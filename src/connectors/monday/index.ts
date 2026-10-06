// @ts-nocheck
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber')
const { initModels } = require('../servicenow-models/init-models');
const { sequelize } = require('../servicenow-models/sequelize');
const { UserModel } = require('@app-connect/core/models/userModel');
const phoneWriteback = require('../shared/phoneWriteback');
const { trackAnalytics } = require('../shared/analytics');
const models = sequelize ? initModels(sequelize) : null;
const FormData = require('form-data')
const s3Helper = require('../servicenow-core/s3');
const AWS = require('aws-sdk');

const licenseHelper = require('../shared/license');
const apiLog = require('../shared/apiLogger');
// GraphQL transport, error contract and column cache live in monday-core/client so the
// work-management module can share them without requiring this connector back.
const {
  mondayApiClient,
  getMondayApiUrl,
  stringifyForLog,
  isNumericMondayId,
  mondayRequest,
  assertNoGraphqlErrors,
  columnIdCache,
  getColumnIdByName
} = require('../monday-core/client');
const projects = require('../monday-core/projects');

// Cache of every active board a connected user can see, across all workspaces. Contact matching
// filters it to the boards with a Phone column; the Project dropdown filters it by workspace.
const boardCache = new Map(); // userId -> { boards: [{ id, name, type, workspaceId, workspaceName, phoneColumnId }], expiry }
const BOARD_CACHE_TTL_MS = 5 * 60 * 1000;
// Monday counts every board AND its columns against the query complexity budget, so boards are
// paged in modest batches; the cap keeps a very large account from stalling contact matching.
const BOARD_PAGE_SIZE = 50;
const BOARD_MAX_PAGES = 10;

// AI notes arrive with markdown bold markers (**Recap**, **Tasks**) which Monday updates
// don't render — they show as literal asterisks. Strip them for clean plain text.
function stripMarkdownBold(text) {
  return text ? String(text).replace(/\*\*/g, '') : text;
}

// Format a timestamp with the user's chosen date format from the extension settings
// (userSettings.logDateFormat — one of RC's six formats, e.g. 'MM/DD/YYYY hh:mm:ss A'),
// applying the user's timezone offset the same way core's callLogComposer does.
function formatDateTime({ user, time }) {
  let momentTime = moment(time);
  const tz = user?.timezoneOffset;
  if (tz) {
    momentTime = (typeof tz === 'string' && tz.includes(':'))
      ? momentTime.utcOffset(tz)
      : momentTime.utcOffset(Number(tz));
  }
  return momentTime.format(user?.userSettings?.logDateFormat?.value || 'YYYY-MM-DD hh:mm:ss A');
}

// Core builds a tokenized download link for fax attachments but NOT for voicemail —
// connectors only get the media-reader page link, which 401s server-side. Build the
// tokenized link ourselves from the message's AudioRecording attachment uri plus the
// RC access token stamped onto the message by the /messageLog wrapper in src/index.ts.
function getVoicemailDownloadLink(message) {
  const audio = message?.attachments?.find?.(a => a.type === 'AudioRecording');
  if (audio?.uri && message?.rcAccessToken) {
    return `${audio.uri}${audio.uri.includes('?') ? '&' : '?'}access_token=${message.rcAccessToken}`;
  }
  return null;
}

// A recording link may be the media-reader PAGE (https://ringcentral.github.io/
// ringcentral-media-reader/?media=<real media url>) rather than the raw media content.
// Downloading the page yields HTML — that's how "recordings" ended up as .htm files in
// Monday. Unwrap the real media URL before downloading.
function resolveMediaContentUrl(link) {
  try {
    const mediaParam = new URL(link).searchParams.get('media');
    return mediaParam || link;
  } catch (e) {
    return link;
  }
}

// Normalize a hostname to the bare host the companies table stores:
// strips scheme (http/https), any path/query, port, and trailing slash; lowercased.
function normalizeHostname(raw) {
  if (!raw) return raw;
  let host = String(raw).trim();
  host = host.replace(/^https?:\/\//i, '');   // drop scheme
  host = host.split('/')[0];                   // drop path / trailing slash
  host = host.split('?')[0];                   // drop query
  host = host.split(':')[0];                   // drop port
  return host.toLowerCase();
}

async function getLicenseStatus({ userId }) {
  return licenseHelper.getLicenseStatus({ models, userId });
}

// `operation` is accepted for call-site compatibility (logged context); the shared
// helper performs the actual license + seat check.
async function validateLicenseOrFail(user, operation = 'unknown') { // eslint-disable-line no-unused-vars
  return licenseHelper.validateLicenseOrFail({ models, user });
}

async function getOrCreateFilesColumn({ accessToken, boardId, columnName = 'Files', operation = 'getOrCreateFilesColumn' }) {
  let columnId = await getColumnIdByName({
    accessToken,
    boardId,
    columnName,
    operation
  })

  if (columnId) {
    return columnId
  }

  const res = await mondayRequest(
    accessToken,
    `
    mutation ($boardId: ID!, $title: String!) {
      create_column(
        board_id: $boardId,
        title: $title,
        column_type: file
      ) {
        id
      }
    }
    `,
    {
      boardId: Number(boardId),
      title: columnName
    },
    { operation }
  )

  assertNoGraphqlErrors(res, `create "${columnName}" column`)
  if (!res?.data?.create_column?.id) {
    throw new Error(`Failed to create "${columnName}" column in Monday`)
  }

  const newColumnId = res.data.create_column.id

  // same cache pattern as Call Logs
  columnIdCache.set(`${boardId}:${columnName}`, newColumnId)

  return newColumnId
}

function normalizePhone(phone) {
  const p = parsePhoneNumber(phone)
  return p?.valid ? p.number.e164 : null
}

// Generate all common formats of a phone number for CRM search matching
// Reference: ServiceNow connector generateFormatsFromE164 pattern
function generatePhoneFormats(e164Number) {
  if (!e164Number) return []
  const digits = e164Number.replace(/\D/g, '')
  const parsed = parsePhoneNumber(e164Number)

  // US/Canada numbers: +1XXXXXXXXXX → 11 digits starting with 1
  if (digits.length === 11 && digits.startsWith('1')) {
    // Monday's phone column matched on "16232011816" (country code + digits, no symbols).
    // Use that single format so every lookup — match OR no-match — is exactly one query.
    return [digits] // 16232011816
  }

  // International numbers — include library-formatted variants (e.g. "+62 320 11860")
  const formats = [
    e164Number,                                                     // +6232011860
    digits,                                                         // 6232011860
    parsed?.valid ? parsed.number.international : null,             // +62 320 11860 (Monday display format)
    parsed?.valid ? parsed.number.national : null,                  // 032-011-860
    parsed?.valid ? parsed.number.significant : null,               // 32011860
  ].filter(Boolean)

  return formats.filter((v, i, arr) => arr.indexOf(v) === i) // deduplicate
}

function getAuthType() {
  return 'oauth'
}

async function getOauthInfo() {

  if (!process.env.MONDAY_CLIENT_ID || !process.env.MONDAY_CLIENT_SECRET) {
    return {
      failMessage: 'Monday OAuth credentials are not configured on the server.'
    };
  }

  return {
    clientId: process.env.MONDAY_CLIENT_ID,
    clientSecret: process.env.MONDAY_CLIENT_SECRET,
    accessTokenUri: process.env.MONDAY_TOKEN_URI,
    redirectUri: process.env.REDIRECT_URI,
    scopes: ['me:read', 'users:read', 'boards:read', 'boards:write', 'updates:write', 'account:read']
  };
}

async function getUserInfo({ authHeader, hostname, query }) {
  console.log("Hostname : ", hostname)
  // OAuth callback already provides `query` with rcAccountId — no framework change needed.
  const rcAccountId = query?.rcAccountId;
  apiLog.logStart('Monday', 'getUserInfo', { rcAccountId, hostname });
  try {
    const accessToken = authHeader.replace('Bearer ', '');
    if (!accessToken) {
      return {
        successful: false,
        returnMessage: { messageType: 'error', message: 'Failed to get access token.', ttl: 3000 }
      };
    }

    // Ask for account.slug too (the account the token was issued for). If the token lacks
    // the scope for the account field, retry with the plain `me` query so connect never
    // breaks — we just lose the slug and fall back to the extension-provided hostname.
    const meQuery = async (query) => {
      const response = await mondayApiClient.post(
        getMondayApiUrl(),
        { query },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          _operation: 'getUserInfo'
        }
      );
      return response.data;
    };

    console.log('[Monday][api] → query me (getUserInfo)');
    let result = await meQuery("query { me { id name email account { slug } } }");
    if (result?.errors?.length || !result?.data?.me) {
      console.warn('[Monday][getUserInfo] me query with account.slug failed — retrying without it', stringifyForLog(result?.errors, 800));
      result = await meQuery("query { me { id name email } }");
    }
    if (result?.errors?.length) {
      console.error('[Monday][api] ✗ GraphQL error (getUserInfo me)', stringifyForLog(result.errors, 800));
    } else {
      console.log('[Monday][api] ← query me (getUserInfo)', { meId: result?.data?.me?.id, accountSlug: result?.data?.me?.account?.slug });
    }
    if (!result?.data?.me) {
      return {
        successful: false,
        returnMessage: { messageType: 'error', message: 'Failed to get user data.', ttl: 3000 }
      };
    }

    // Tenant-scope the user id so the same Monday user under different RC accounts
    // never collides (multi-tenant isolation + per-tenant seat counting).
    if (!rcAccountId) {
      console.warn('[Monday][getUserInfo] missing rcAccountId — falling back to non-tenant-scoped id');
    }
    const userData = {
      id: rcAccountId ? `monday-${rcAccountId}-${result.data.me.id}` : result.data.me.id,
      name: result.data.me.name,
      email: result.data.me.email
    };

    // Derive the hostname from the account the token was ACTUALLY issued for (me.account.slug),
    // not from what the extension passed in. The extension's dynamic-environment hostname is
    // sticky (first workspace URL it saw) and auth.monday.com authorizes the user's active
    // session account — both can disagree with the account the user meant to connect. The
    // slug is authoritative: token, hostname and {hostname} URL templates always match.
    const accountSlug = result?.data?.me?.account?.slug || null;
    const slugHostname = accountSlug ? `${accountSlug}.monday.com` : null;
    if (!slugHostname) {
      console.warn('[Monday][getUserInfo] me.account.slug missing — falling back to extension-provided hostname', { rawHostname: hostname });
    }
    const cleanHostname = normalizeHostname(slugHostname || hostname);
    console.log('[Monday][getUserInfo] hostname resolved', { accountSlug, rawHostname: hostname, cleanHostname });

    // Company / customer onboarding — mirrors the ServiceTitan pattern so that each
    // connecting user is registered in the `customer` table with a `companyId` FK.
    // This is required for the shared license helper's seat-count enforcement to work.
    if (models && models.companies && models.customer && rcAccountId) {
      try {
        // Look up the company row. Try rcAccountId + hostname first for specificity,
        // then fall back to rcAccountId only (matches the shared license helper's
        // fallback chain).
        let company = null;
        if (cleanHostname) {
          company = await models.companies.findOne({
            where: { rcAccountId: String(rcAccountId), hostname: cleanHostname, status: true },
            raw: true
          });
        }

        if (!company) {
          company = await models.companies.findOne({
            where: { rcAccountId: String(rcAccountId), status: true },
            raw: true
          });
        }

        if (!company) {
          return {
            successful: false,
            returnMessage: {
              messageType: 'error',
              message: 'No active subscription found for this account. Please contact Gate6 support.',
              ttl: 5000
            }
          };
        }
        const existingCustomer = await models.customer.findOne({
          where: { companyId: company.id, sysId: String(userData.id) },
          raw: true
        });

        if (!existingCustomer) {
          const currentSeatCount = await models.customer.count({
            where: { companyId: company.id }
          });

          const maxSeats = Number(company.maxAllowedUsers);
          if (Number.isFinite(maxSeats) && maxSeats >= 0 && currentSeatCount >= maxSeats) {
            return {
              successful: false,
              returnMessage: {
                messageType: 'error',
                message: `License seat limit reached (${maxSeats} of ${maxSeats} in use). Contact your admin.`,
                ttl: 5000
              }
            };
          }

          await models.customer.create({
            sysId: String(userData.id),
            companyId: company.id,
            email: userData.email || '',
            firstname: userData.name || 'Monday User',
            platform: 'gate6.monday',
            hostname: cleanHostname,
            rcAccountId
          });
          console.log('[Monday][getUserInfo] customer row created', { firstname: userData.name });
        }
      } catch (err) {
        console.error('[Monday][getUserInfo] error enforcing customer seat limits:', err);
      }
    }

    // Discover the connector's contact board once, at connect time, and store it so the
    // rest of the system reuses it without re-discovering.
    let boardId = null;
    let boardName = null;
    try {
      const boards = await getCrmBoards({ accessToken, userId: null, operation: 'getUserInfo' });
      const defaultBoard = pickDefaultBoard(boards);
      boardId = defaultBoard?.id || null;
      boardName = defaultBoard?.name || null;
      console.log('[Monday][getUserInfo] selected board', { boardId, boardName, discoveredBoardCount: boards.length });
    } catch (e) {
      console.warn('[Monday][getUserInfo] board discovery failed (will retry lazily):', e.message);
    }

    apiLog.logSuccess('Monday', 'getUserInfo', { userId: userData.id, boardId, hostname: cleanHostname });
    return {
      successful: true,
      platformUserInfo: {
        id: userData.id,
        name: userData.name,
        email: userData.email,
        overridingApiKey: accessToken,
        ...(cleanHostname ? { overridingHostname: cleanHostname } : {}),
        // The connected Monday user is the person doing the logging, so their Monday id is what
        // fills the project item's "Last logged by" people column — no email matching needed.
        platformAdditionalInfo: {
          ...(boardId ? { boardId, boardName } : {}),
          ...(result.data.me.id ? { mondayUserId: String(result.data.me.id) } : {})
        }
      },
      returnMessage: { messageType: 'success', message: 'Successfully connected to Monday.', ttl: 3000 }
    };

  } catch (err) {
    console.error('Monday getUserInfo error:', err?.response?.data || err.message);
    return {
      successful: false,
      returnMessage: { messageType: 'error', message: 'Monday authentication failed.', ttl: 3000 }
    };
  }
}

// Runs right after the user record is saved during OAuth connect (before the extension
// fetches user settings). Seed the contactBoardId setting here — the framework hardcodes
// `userSettings: {}` on create, so this is the earliest point we can populate it. Seeding at
// connect (rather than lazily in findContact/getBoardId) ensures the {contactBoardId} URL
// token resolves on the very first call-pop without the user opening Settings to enter it.
async function postSaveUserInfo({ userInfo, oauthApp }) {
  try {
    // saveUserInfo returns only { id, name } — NOT the Sequelize instance — so re-fetch the
    // persisted user to read platformAdditionalInfo.boardId (stored by getUserInfo at connect)
    // and write userSettings.contactBoardId before the extension loads settings.
    const userId = userInfo?.id;
    if (userId) {
      const user = await UserModel.findByPk(userId);
      const pai = user?.platformAdditionalInfo || user?.dataValues?.platformAdditionalInfo || {};
      if (user && pai.boardId) {
        await seedContactBoardIdSetting(user, String(pai.boardId));
        console.log('[Monday][postSaveUserInfo] seeded contactBoardId at connect', { userId, boardId: pai.boardId });
      } else {
        console.warn('[Monday][postSaveUserInfo] no boardId on user record; contactBoardId not seeded', { userId, hasUser: !!user });
      }
    }
  } catch (e: any) {
    console.warn('[Monday][postSaveUserInfo] failed to seed contactBoardId:', e.message);
  }
  return userInfo;
}

async function unAuthorize({ user }) {
  // Blank the token so the user no longer holds a license seat (seat counting keys on
  // a non-empty accessToken). Mirrors the other connectors' disconnect behaviour.
  if (user) {
    user.accessToken = '';
    user.refreshToken = '';
    await user.save();
    licenseHelper.clearLicenseCache(user.id ?? user.dataValues?.id);
  }
  return {
    returnMessage: {
      messageType: 'success',
      message: 'Disconnected from Monday',
      ttl: 3000
    }
  }
}

// Discover every active board a connected user can see, across all of their workspaces. Monday
// pages the `boards` query, and an account big enough to matter has more boards than one page
// holds — so page until a short page comes back (or the cap is hit) rather than taking whatever the
// first page happened to contain. Results are cached briefly per user: contact matching, the
// Project dropdown and the settings workspace list all read the same list.
async function getAllBoards({ accessToken, userId, operation = 'getAllBoards' }) {
  const now = Date.now();
  const cached = userId ? boardCache.get(userId) : null;
  if (cached && cached.expiry > now) {
    return cached.boards;
  }

  const boards = [];
  const seenBoardIds = new Set();
  for (let page = 1; page <= BOARD_MAX_PAGES; page++) {
    const res = await mondayRequest(
      accessToken,
      `
      query ($limit: Int!, $page: Int!) {
        boards(limit: $limit, page: $page, state: active, order_by: created_at) {
          id
          name
          type
          workspace { id name }
          columns { id title type }
        }
      }
      `,
      { limit: BOARD_PAGE_SIZE, page },
      { operation }
    );
    const rawBoards = res?.data?.boards || [];
    for (const board of rawBoards) {
      // A board created while the scan is in flight shifts the pages under it, which can hand back
      // one we already have.
      if (seenBoardIds.has(String(board.id))) continue;
      seenBoardIds.add(String(board.id));
      const columns = board.columns || [];
      // A "phone" typed column is the real thing; a text column titled Phone is the common
      // hand-rolled substitute, so both count as a contact directory.
      const phoneColumn = columns.find(col => col.type === 'phone')
        || columns.find(col => /phone/i.test(col.title || ''));
      boards.push({
        id: String(board.id),
        name: board.name,
        type: board.type || 'board',
        workspaceId: board.workspace?.id != null ? String(board.workspace.id) : null,
        workspaceName: board.workspace?.name || null,
        phoneColumnId: phoneColumn?.id || null
      });
    }
    if (rawBoards.length < BOARD_PAGE_SIZE) break;
    if (page === BOARD_MAX_PAGES) {
      console.warn('[Monday][board] board discovery hit the page cap — some boards were not listed', { pageCap: BOARD_MAX_PAGES, pageSize: BOARD_PAGE_SIZE });
    }
  }

  if (userId) {
    boardCache.set(userId, { boards, expiry: now + BOARD_CACHE_TTL_MS });
  }
  return boards;
}

// The CRM boards are the ones that can hold a contact: an active board with a Phone column.
async function getCrmBoards({ accessToken, userId, operation = 'getCrmBoards' }) {
  const boards = await getAllBoards({ accessToken, userId, operation });
  return boards
    .filter(board => board.phoneColumnId && (!board.type || board.type === 'board'))
    .map(board => ({
      id: board.id,
      name: board.name,
      type: board.type,
      workspaceId: board.workspaceId,
      workspaceName: board.workspaceName,
      phoneColumnId: board.phoneColumnId
    }));
}

// Pick the board contacts live on. A board actually called "Contacts" is the intended one, so an
// exact name match wins outright; "Leads" is the next best answer for an account that keeps only
// prospects. Anything looser (a board merely mentioning contacts or leads) is tried after both
// exact names, and only then does the first board with a Phone column stand in.
function pickDefaultBoard(boards = []) {
  const named = (pattern) => boards.find(board => pattern.test(String(board.name ?? '').trim()));
  return named(/^contacts?$/i)
    || named(/^leads?$/i)
    || named(/contact/i)
    || named(/lead/i)
    || boards[0]
    || null;
}

function getUserId(user) {
  return user?.dataValues?.id || user?.id || null;
}

// The board list without paying for discovery. Log writes only need it to sanity-check the picked
// project board, which is not worth a board query of its own — contact matching has almost always
// warmed the cache moments earlier, and when it hasn't the check is simply skipped.
function getCachedBoards(user) {
  const userId = getUserId(user);
  const cached = userId ? boardCache.get(userId) : null;
  return cached && cached.expiry > Date.now() ? cached.boards : [];
}

// The board list the project resolver works from. Normally the cached one: a log write only needs it
// to sanity-check the picked board, which isn't worth a query. Raising a NEW project board is the
// exception — the workspace it belongs in is resolved through a board already sitting in that
// workspace, so there the list has to be real, and one query is nothing against creating a board.
async function boardsForProjectResolution({ user, accessToken, additionalSubmission, operation }) {
  if (additionalSubmission?.project === projects.PROJECT_OPTION_CREATE_NEW) {
    return getBoardsForOptions({ user, accessToken, operation });
  }
  return getCachedBoards(user);
}

// A project board raised from the log form is not in the cached list, and until it is the Project
// dropdown won't offer it — so the cache is dropped rather than left to expire on its own.
function forgetCachedBoards(user, createdBoard) {
  if (!createdBoard) return;
  const userId = getUserId(user);
  if (userId) boardCache.delete(userId);
  console.log('[Monday][board] dropped the cached board list after creating a project', { boardId: createdBoard.id, name: createdBoard.name });
}

// The board list for building the Project dropdown, discovering it when the cache is cold. The
// paths that need this (contact search by name, creating a contact mid-call) don't otherwise list
// boards, and an empty dropdown there would mean the very first call for a new contact is the one
// that cannot reach a project. Discovery is cached per user, so this costs at most one query per
// cache period — and a failure costs only the dropdown, never the contact.
async function getBoardsForOptions({ user, accessToken, operation }) {
  const cached = getCachedBoards(user);
  if (cached.length) return cached;
  try {
    return await getAllBoards({ accessToken, userId: getUserId(user), operation });
  } catch (e) {
    console.warn(`[Monday][${operation}] board discovery for the project options failed:`, e.message);
    return [];
  }
}

// The contact board as the project helpers want it — the id they must exclude from the project
// list — read from what connect persisted, so no API call is needed on the logging path.
function contactBoardOf(user) {
  const pai = user?.platformAdditionalInfo || user?.dataValues?.platformAdditionalInfo || {};
  if (!pai.boardId) return null;
  return { id: String(pai.boardId), name: pai.boardName || null };
}

// Move a project item's "Last activity" and "Last logged by" on for an interaction that continues an
// existing conversation — the paths that already know the item from the stored log id and so never
// go through resolveTargetProjectItem. Never throws.
async function stampProjectItem({ user, accessToken, projectBoardId, projectItemId, activityTime }) {
  if (!projectItemId || !projects.isProjectLoggingEnabled(user)) return;
  try {
    await projects.stampProjectActivity({
      accessToken,
      projectBoardId,
      projectItemId,
      contactBoardId: contactBoardOf(user)?.id,
      mondayUserId: mondayUserIdOf(user),
      activityTime,
      operation: 'stampProjectItem'
    });
  } catch (e) {
    console.warn('[Monday][projects] could not refresh the project item activity', { projectItemId, message: e.message });
  }
}

// The Monday user id behind this connection — the person whose token writes the log, and so the
// person the project item credits. Stored at connect; for connections made before it was stored,
// recovered from the tenant-scoped user id (`monday-{rcAccountId}-{mondayUserId}`) so those users
// don't have to reconnect to get the column filled.
function mondayUserIdOf(user) {
  const pai = user?.platformAdditionalInfo || user?.dataValues?.platformAdditionalInfo || {};
  if (pai.mondayUserId) return String(pai.mondayUserId);
  const trailing = String(getUserId(user) ?? '').split('-').pop();
  return /^\d+$/.test(trailing || '') ? trailing : null;
}

// The connector uses a single board for everything. It is discovered once (the default
// board with a Phone column), stored on the user record's platformAdditionalInfo, and
// reused everywhere — no per-contact board lookup.
// Self-labeling display value for a matched/created contact's `type`/`contactType`. Renders
// as e.g. "Board: Sales Leads" so the board name is distinguishable from the numeric Monday
// item (pulse) id shown alongside it. Falls back to the board id when the name is unknown
// (e.g. users connected before boardName was persisted). Used only for display — the deep-link
// URL resolves the board via the {contactBoardId} setting and logging reads the persisted id.
function boardDisplayLabel({ boardName, boardId }: { boardName?: any, boardId?: any }) {
  const val = boardName || (boardId != null ? String(boardId) : '');
  return val ? `Board: ${val}` : '';
}

// Auto-populate the per-user `contactBoardId` setting so the {contactBoardId} URL token
// (contactPageUrl/logPageUrl/callPopUrl) resolves without the admin entering it manually.
// The token reads from `userSettings.contactBoardId.value`. Written only when it differs, to
// avoid redundant DB writes. This also backfills users whose board was persisted before the
// feature existed.
async function seedContactBoardIdSetting(user: any, boardId: string) {
  if (!boardId || typeof user?.update !== 'function') return;
  const current = user.userSettings || user.dataValues?.userSettings || {};
  if (String(current?.contactBoardId?.value ?? '') === String(boardId)) return;
  try {
    const nextSettings = { ...current, contactBoardId: { value: String(boardId) } };
    await user.update({ userSettings: nextSettings });
    if (typeof user.changed === 'function') {
      user.changed('userSettings', true);
      if (typeof user.save === 'function') await user.save();
    }
    console.log('[Monday][board] seeded contactBoardId setting', { boardId });
  } catch (e: any) {
    console.warn('[Monday][board] failed to seed contactBoardId setting:', e.message);
  }
}

async function getBoardId({ user, accessToken, operation = 'getBoardId' }) {
  const pai = user?.platformAdditionalInfo || user?.dataValues?.platformAdditionalInfo || {};
  if (pai.boardId) {
    // Backfill the contactBoardId setting for users whose board was persisted earlier.
    await seedContactBoardIdSetting(user, String(pai.boardId));
    return String(pai.boardId);
  }
  // Not stored yet — discover the default board and persist it on the user record.
  const boards = await getCrmBoards({ accessToken, userId: getUserId(user), operation });
  const board = pickDefaultBoard(boards);
  const boardId = board?.id || null;
  console.log('[Monday][board] discovered board', { boardId, boardName: board?.name, discoveredBoardCount: boards.length });
  if (boardId && typeof user?.update === 'function') {
    try {
      const nextPai = { ...pai, boardId, boardName: board?.name || pai.boardName };
      await user.update({ platformAdditionalInfo: nextPai });
      // JSON columns don't always auto-flag as changed; force a save to be safe.
      if (typeof user.changed === 'function') {
        user.changed('platformAdditionalInfo', true);
        if (typeof user.save === 'function') await user.save();
      }
      console.log('[Monday][board] stored boardId on user record', { boardId });
    } catch (e) {
      console.warn('[Monday][board] failed to persist boardId on user record:', e.message);
    }
    // Seed the contactBoardId setting so the {contactBoardId} URL token resolves.
    await seedContactBoardIdSetting(user, String(boardId));
  }
  return boardId;
}

// Logging always targets the connector's single board (read stored, else discover).
// This does not depend on contactInfo.type surviving the extension round-trip.
async function resolveBoardId({ accessToken, user, operation = 'resolveBoardId' }) {
  const boardId = await getBoardId({ user, accessToken, operation });
  console.log('[Monday][board] resolveBoardId ->', { boardId, operation });
  return boardId;
}

// The Phone column id for a board, cached via getColumnIdByName.
async function getPhoneColumnId({ accessToken, boardId, operation = 'getPhoneColumnId' }) {
  return getColumnIdByName({ accessToken, boardId, columnName: 'Phone', operation });
}

function parseMondayCallLogBody(body = '') {
  const normalized = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .trim()

  const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/)
  let subject = subjectMatch ? subjectMatch[1].trim() : ''

  if (!subject || subject.toLowerCase().startsWith('direction:')) {
    subject = ''
  }
  const direction = normalized.match(/Direction:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''
  const startTime = normalized.match(/Start Time:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''
  const endTime = normalized.match(/End Time:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''
  const result = normalized.match(/Result:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''
  const duration = normalized.match(/Duration:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''
  const recording = normalized.match(/Recording:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''
  let agentNote = ''
  const agentMatch = normalized.match(
    /Agent Notes?:\s*([\s\S]*?)(?:\n[A-Z][^\n]*:|$)/i
  )

  if (agentMatch) {
    agentNote = agentMatch[1].trim()
  }
  let aiNote = ''
  const aiMatch = normalized.match(/AI Note:\s*([\s\S]*?)(?:\n[A-Z][^\n]*:|$)/i)
  if (aiMatch) {
    aiNote = aiMatch[1].trim()
  }
  let transcript = ''
  const transcriptMatch = normalized.match(/Transcript:\s*([\s\S]*?)(?:\n[A-Z][^\n]*:|$)/i)
  if (transcriptMatch) {
    transcript = transcriptMatch[1].trim()
  }

  const sessionId = normalized.match(/Call Session ID:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''
  const rcUserName = normalized.match(/RingCentral Username:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''
  const rcPhoneNumber = normalized.match(/RingCentral Phone Number:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''
  const contactNumber = normalized.match(/Contact Number:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || ''

  return {
    subject,
    direction,
    startTime,
    endTime,
    result,
    duration,
    recording,
    agentNote,
    aiNote,
    transcript,
    sessionId,
    rcUserName,
    rcPhoneNumber,
    contactNumber,
    normalizedBody: normalized
  }
}

async function searchBoardByPhone({ accessToken, boardId, phoneColumnId, phone, operation = 'findContact' }) {
  // Try formats in priority order (Monday's "+1 623 201 1816" first) and STOP at the
  // first format that matches — best case is a single query. Each request is bounded by
  // the client timeout and try/caught, so a slow/failed format is skipped, not fatal.
  const phoneFallbacks = generatePhoneFormats(phone)
  for (const searchValue of phoneFallbacks) {
    try {
      const res = await mondayRequest(
        accessToken,
        `
        query ($boardId: ID!, $columnId: String!, $value: String!) {
          items_page_by_column_values(
            board_id: $boardId,
            columns: [{ column_id: $columnId, column_values: [$value] }]
          ) {
            items { id name }
          }
        }
        `,
        { boardId: String(boardId), columnId: String(phoneColumnId), value: searchValue },
        { operation }
      )
      if (res?.errors?.length) {
        console.warn('[Monday] searchBoardByPhone error on board', boardId, res.errors[0].message)
        continue
      }
      const items = res?.data?.items_page_by_column_values?.items || []
      if (items.length > 0) {
        console.log('[Monday] findContact: matched', items.length, 'contact(s) on board', boardId, 'via format', searchValue)
        return items
      }
    } catch (e) {
      console.warn('[Monday] searchBoardByPhone request failed on board', boardId, 'format', searchValue, e.message)
    }
  }
  return []
}

async function findContact({ phoneNumber, accessToken, authHeader, user, isExtension }) {
  apiLog.logStart('Monday', 'findContact', { phoneNumber, isExtension });
  const licenseError = await validateLicenseOrFail(user, 'findContact');
  if (licenseError) return licenseError;

  // Replicate ServiceTitan: skip the CRM search (and all its API calls) for extension-context
  // lookups. By the time the user clicks "Log", the extension already knows whether the
  // contact exists from the earlier match, so re-searching here is redundant — return empty
  // and let the extension drive the create-contact / log flow.
  if (isExtension === 'true' || isExtension === true) {
    return { successful: false, matchedContactInfo: [] };
  }

  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

  // ── SINGLE-BOARD MODE ─────────────────────────────────────────────────────────────────
  // Multi-board search is disabled for now. Contacts are matched against the connector's
  // single default board. `boardId` is kept for logging; `type`/`contactType` now carry the
  // board NAME (shown in the contact list) since the deep-link URL uses the {contactBoardId}
  // setting token, not {contactType}. We also seed that setting from the resolved board.
  //
  // --- multi-board search (commented out; restore to search every board) ---
  // let boards = []
  // try { boards = await getCrmBoards({ accessToken: resolvedAccessToken, userId: getUserId(user) }) }
  // catch (e) { return { successful: false, returnMessage: { messageType: 'warning', message: 'Monday is taking too long to respond. Please try again.', ttl: 3000 } } }
  // const perBoardMatches = await Promise.all(boards.map(async board => { ... type: String(board.id) ... }))
  // --------------------------------------------------------------------------
  let board: any = null
  let allBoards: any[] = []
  try {
    allBoards = await getAllBoards({ accessToken: resolvedAccessToken, userId: getUserId(user), operation: 'findContact' })
    board = pickDefaultBoard(allBoards.filter(b => b.phoneColumnId && (!b.type || b.type === 'board')))
  } catch (e: any) {
    // A board-discovery failure (e.g. a slow query hitting the request timeout) should not
    // surface as a hard error — tell the user to retry.
    console.warn('[Monday] findContact: board discovery failed', e.message)
    return { successful: false, returnMessage: { messageType: 'warning', message: 'Monday is taking too long to respond. Please try again.', ttl: 3000 } }
  }
  if (!board) {
    return { successful: false, returnMessage: { messageType: 'error', message: 'No Monday board with a Phone column was found. Add a Phone column to your board and try again.', ttl: 3000 } }
  }
  // Auto-populate the contactBoardId setting so the {contactBoardId} URL token resolves.
  await seedContactBoardIdSetting(user, String(board.id))

  const boardName = board.name || String(board.id)
  const phone = normalizePhone(phoneNumber)
  const matchedContactInfo: any[] = []
  // The Project options are the same for every match, so build them once rather than per contact.
  const projectAdditionalInfo = projects.buildProjectAdditionalInfo({ user, boards: allBoards, contactBoard: board })

  if (phone) {
    const phoneColumnId = board.phoneColumnId || await getPhoneColumnId({ accessToken: resolvedAccessToken, boardId: board.id })
    if (phoneColumnId) {
      const items = await searchBoardByPhone({ accessToken: resolvedAccessToken, boardId: board.id, phoneColumnId, phone })
      const boardLabel = boardDisplayLabel({ boardName, boardId: board.id })
      for (const item of items) {
        // Display the board name (self-labeled "Board: …") in the contact list; keep boardId for logging.
        matchedContactInfo.push({
          id: item.id,
          name: item.name,
          phone,
          type: boardLabel,
          contactType: boardLabel,
          boardId: board.id,
          boardName,
          ...(projectAdditionalInfo ? { additionalInfo: projectAdditionalInfo } : {})
        })
      }
    }

  }

  matchedContactInfo.push({
    id: 'createNewContact',
    name: 'Create new contact...',
    isNewContact: true
  })

  apiLog.logSuccess('Monday', 'findContact', { phoneNumber, matchedCount: matchedContactInfo.length - 1, boardId: board.id });
  return { successful: true, matchedContactInfo }
}

async function findContactWithName({ name, accessToken, authHeader, user }) {
  apiLog.logStart('Monday', 'findContactWithName', { name });
  const licenseError = await validateLicenseOrFail(user, 'findContactWithName');
  if (licenseError) return licenseError;

  const term = (name || '').trim()
  if (!term) {
    return { successful: true, matchedContactInfo: [] }
  }

  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  // Board resolution must not throw out of this function — if it does (e.g. a slow
  // board-discovery query hitting the request timeout), the framework surfaces it as
  // "Contact search by name failed". Degrade to an empty result instead.
  let boardId = null
  try {
    boardId = await getBoardId({ user, accessToken: resolvedAccessToken, operation: 'findContactWithName' })
  } catch (e) {
    console.warn('[Monday] findContactWithName: board resolution failed', e.message)
    return { successful: true, matchedContactInfo: [] }
  }
  if (!boardId) {
    return { successful: true, matchedContactInfo: [] }
  }

  // The interface contract (docs/developers/interfaces/findContactWithName.md) requires the
  // same contact shape as findContact — including `phone`. Without it, the extension cannot
  // reconcile a manually-selected contact with later phone-based lookups, so fetch the
  // board's phone column value alongside id/name. A missing phone column is non-fatal.
  let phoneColumnId = null
  try {
    phoneColumnId = await getPhoneColumnId({ accessToken: resolvedAccessToken, boardId, operation: 'findContactWithName' })
  } catch (e) {
    console.warn('[Monday] findContactWithName: phone column resolution failed', e.message)
  }

  // Inline the search term via JSON.stringify so it is a safely-escaped GraphQL list
  // literal (e.g. ["O'Brien"]). compare_value is Monday's JSON CompareValue scalar.
  const compareValue = JSON.stringify([term])

  let items = []
  try {
    const res = await mondayRequest(
      resolvedAccessToken,
      `
      query ($boardId: [ID!]${phoneColumnId ? ', $phoneColumnIds: [String!]' : ''}) {
        boards(ids: $boardId) {
          items_page(
            limit: 25,
            query_params: { rules: [{ column_id: "name", compare_value: ${compareValue}, operator: contains_text }] }
          ) {
            items { id name${phoneColumnId ? ' column_values(ids: $phoneColumnIds) { text }' : ''} }
          }
        }
      }
      `,
      { boardId: [boardId], ...(phoneColumnId ? { phoneColumnIds: [String(phoneColumnId)] } : {}) },
      { operation: 'findContactWithName' }
    )
    if (res?.errors?.length) {
      console.warn('[Monday] findContactWithName error on board', boardId, res.errors[0].message)
    } else {
      items = res?.data?.boards?.[0]?.items_page?.items || []
    }
  } catch (e) {
    console.warn('[Monday] findContactWithName threw on board', boardId, e.message)
  }

  // `type` feeds the RC entity contactType (contacts/match.js) → {contactType} URL var.
  // Match findContact's display: board name (self-labeled), not the raw boardId.
  const wnPai = user?.platformAdditionalInfo || user?.dataValues?.platformAdditionalInfo || {}
  const wnBoardLabel = boardDisplayLabel({ boardName: wnPai.boardName, boardId })
  // A contact picked by name logs through the same form as a phone match, so it needs the same
  // Project options.
  const wnProjectAdditionalInfo = projects.buildProjectAdditionalInfo({
    user,
    boards: await getBoardsForOptions({ user, accessToken: resolvedAccessToken, operation: 'findContactWithName' }),
    contactBoard: contactBoardOf(user)
  })
  const matchedContactInfo = items.map(item => {
    // Monday stores the phone column as display text (e.g. "+1 623 201 1816" or
    // "16232011816"); normalize to E.164 where possible so it matches what findContact
    // returns, falling back to the raw text rather than dropping the number.
    const rawPhone = item.column_values?.[0]?.text?.trim() || ''
    const phone = rawPhone ? (normalizePhone(rawPhone) || normalizePhone(`+${rawPhone.replace(/\D/g, '')}`) || rawPhone) : ''
    return {
      id: item.id,
      name: item.name,
      phone,
      type: wnBoardLabel,
      contactType: wnBoardLabel,
      boardId,
      boardName: wnPai.boardName,
      ...(wnProjectAdditionalInfo ? { additionalInfo: wnProjectAdditionalInfo } : {})
    }
  })
  console.log('[Monday] findContactWithName', { term, matches: matchedContactInfo.length, withPhone: matchedContactInfo.filter(c => c.phone).length })

  return { successful: true, matchedContactInfo }
}

// Monday "phone"-type columns expect a JSON object { phone, countryShortName }; a plain string
// is rejected. Text columns named "Phone" accept a plain string. Callers try the structured
// format first, then fall back to the plain string.
function buildMondayPhoneVariants(phoneNumber) {
  const parsed = parsePhoneNumber(phoneNumber || '')
  const e164 = parsed?.valid ? parsed.number.e164 : (phoneNumber || '')
  const countryShortName = parsed?.valid ? parsed.regionCode : ''
  return [
    countryShortName ? { phone: e164, countryShortName } : { phone: e164 },
    e164
  ]
}

// Write `phoneNumber` into an existing item's phone column (used to fill an empty field on a
// contact picked by name, rather than creating a duplicate item). Throws on failure.
async function updateItemPhone({ accessToken, boardId, itemId, phoneColumnId, phoneNumber, operation }) {
  let lastError = ''
  for (const variant of buildMondayPhoneVariants(phoneNumber)) {
    const res = await mondayRequest(
      accessToken,
      `
      mutation ($itemId: ID!, $boardId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(item_id: $itemId, board_id: $boardId, column_id: $columnId, value: $value) {
          id
        }
      }
      `,
      { itemId: String(itemId), boardId: String(boardId), columnId: String(phoneColumnId), value: JSON.stringify(variant) },
      { operation }
    )
    if (!res?.errors?.length && res?.data?.change_column_value?.id) return true
    lastError = res?.errors?.[0]?.message || 'unknown error'
    console.warn(`[Monday][${operation}] change_column_value attempt failed; trying next phone format`, { boardId, itemId, variant, error: lastError })
  }
  throw new Error(lastError || 'change_column_value failed')
}

// Create an item named `name` on `boardId` with `phoneNumber` written into `phoneColumnId`.
// Shared by createContact and the log write-back so both build the item identically. Returns the
// created { id, name } or throws on failure.
async function createItemOnBoard({ accessToken, boardId, phoneColumnId, name, phoneNumber, operation }) {
  let created = null
  let lastError = ''
  for (const variant of buildMondayPhoneVariants(phoneNumber)) {
    const res = await mondayRequest(
      accessToken,
      `
      mutation ($name: String!, $values: JSON!) {
        create_item(
          board_id: ${boardId},
          item_name: $name,
          column_values: $values
        ) {
          id
          name
        }
      }
      `,
      {
        name,
        values: JSON.stringify({ [phoneColumnId]: variant })
      },
      { operation }
    )
    if (!res?.errors?.length && res?.data?.create_item?.id) {
      created = res.data.create_item
      break
    }
    lastError = res?.errors?.[0]?.message || 'unknown error'
    console.warn(`[Monday][${operation}] create_item attempt failed; trying next phone format`, { boardId, variant, error: lastError })
  }

  if (!created) throw new Error(lastError || 'create_item failed')
  return created
}

// Read the phone-column text of a single item by id. Returns the string (possibly empty) or
// null when it couldn't be read, so callers can distinguish "no number" from "unknown".
async function getItemPhoneText({ accessToken, itemId, phoneColumnId, operation }) {
  if (!itemId || !phoneColumnId) return null
  try {
    const res = await mondayRequest(
      accessToken,
      `
      query ($ids: [ID!], $cols: [String!]) {
        items(ids: $ids) { column_values(ids: $cols) { text } }
      }
      `,
      { ids: [String(itemId)], cols: [String(phoneColumnId)] },
      { operation }
    )
    if (res?.errors?.length) return null
    return res?.data?.items?.[0]?.column_values?.[0]?.text ?? ''
  } catch (e) {
    console.warn(`[Monday][${operation}] failed to read item phone`, { itemId, message: e.message })
    return null
  }
}

// Monday phone columns hold a single value. Decide, for the number this interaction came in on,
// where to log:
//   - already on the picked item          -> log against it unchanged (no-op)
//   - another item already has this number -> reuse that item (never duplicate the number)
//   - picked item's phone is EMPTY         -> fill it in on the SAME item
//   - picked item has a DIFFERENT number   -> create a NEW item carrying this number and log there
// Returns the item to log against. Falls back to the picked contact if anything fails, so
// logging never breaks.
//
// The picked item's stored number is NOT on contactInfo — core sets contactInfo.phoneNumber to
// the CALL's number — so read the item's phone column and compare. If that read fails we leave
// the picked contact untouched rather than risk a duplicate.
async function resolveLogTarget({ user, accessToken, contactInfo, boardId, receivedNumber, logPrefix }) {
  if (!receivedNumber || !contactInfo?.id) return contactInfo
  try {
    const targetBoardId = boardId || await getBoardId({ user, accessToken, operation: 'createLog' })
    const phoneColumnId = targetBoardId ? await getPhoneColumnId({ accessToken, boardId: targetBoardId, operation: 'createLog' }) : null
    if (!targetBoardId || !phoneColumnId) return contactInfo

    const existingPhone = await getItemPhoneText({ accessToken, itemId: contactInfo.id, phoneColumnId, operation: 'createLog' })
    if (existingPhone === null) return contactInfo // couldn't verify → don't risk a duplicate
    if (!phoneWriteback.isNewNumberForContact(receivedNumber, existingPhone)) return contactInfo // picked item already has it

    // The received number isn't on the picked item. Identity is NAME + number: the user picked a
    // name (e.g. "emma"), so reuse only an item with that SAME name that already carries this
    // number — never a different-named contact who happens to own the number (e.g. "freya"). This
    // both stops duplicate emmas AND stops the log landing on freya. If no same-named item has the
    // number, we fall through to fill/create so an item of the picked name ends up owning it.
    const pickedName = String(contactInfo?.name || '').trim().toLowerCase()
    const existingItems = await searchBoardByPhone({ accessToken, boardId: targetBoardId, phoneColumnId, phone: receivedNumber, operation: 'createLog' })
    const reusable = (existingItems || []).find(it =>
      String(it.id) !== String(contactInfo.id) &&
      String(it.name || '').trim().toLowerCase() === pickedName
    )
    if (reusable) {
      console.log(`${logPrefix} reusing existing same-name item for number:`, reusable.id)
      return { ...contactInfo, id: reusable.id, name: reusable.name, boardId: String(targetBoardId), phone: receivedNumber, phoneNumber: receivedNumber }
    }

    // No item has this number yet. If the picked item's phone is empty, fill it in place.
    if (!String(existingPhone).replace(/\D/g, '')) {
      try {
        await updateItemPhone({ accessToken, boardId: targetBoardId, itemId: contactInfo.id, phoneColumnId, phoneNumber: receivedNumber, operation: 'createLog' })
        console.log(`${logPrefix} filled empty phone on existing item:`, contactInfo.id)
        return { ...contactInfo, boardId: String(targetBoardId), phone: receivedNumber, phoneNumber: receivedNumber }
      } catch (err) {
        console.warn(`${logPrefix} failed to fill empty phone; creating new item instead:`, err.message)
        // fall through to create a new item
      }
    }

    // Picked item holds a different number and none exists for this one: create a new item.
    const created = await createItemOnBoard({ accessToken, boardId: targetBoardId, phoneColumnId, name: contactInfo?.name, phoneNumber: receivedNumber, operation: 'createLog' })
    console.log(`${logPrefix} created new item for new number:`, created.id)
    return { ...contactInfo, id: created.id, name: created.name, boardId: String(targetBoardId), phone: receivedNumber, phoneNumber: receivedNumber }
  } catch (err) {
    console.warn(`${logPrefix} failed to resolve log target:`, err.message)
    return contactInfo
  }
}

async function createContact({ phoneNumber, newContactName, accessToken, authHeader, user }) {
  apiLog.logStart('Monday', 'createContact', { phoneNumber, newContactName });
  const licenseError = await validateLicenseOrFail(user, 'createContact');
  if (licenseError) return licenseError;

  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  const boardId = await getBoardId({ user, accessToken: resolvedAccessToken, operation: 'createContact' })
  const phoneColumnId = boardId ? await getPhoneColumnId({ accessToken: resolvedAccessToken, boardId, operation: 'createContact' }) : null
  if (!boardId || !phoneColumnId) {
    return {
      contactInfo: null,
      returnMessage: {
        messageType: 'error',
        message: 'No Monday board with a Phone column was found to create the contact in.',
        ttl: 3000
      }
    }
  }

  let created = null
  try {
    created = await createItemOnBoard({ accessToken: resolvedAccessToken, boardId, phoneColumnId, name: newContactName, phoneNumber, operation: 'createContact' })
  } catch (err) {
    return {
      contactInfo: null,
      returnMessage: {
        messageType: 'error',
        message: `Failed to create contact in Monday: ${err.message}`,
        ttl: 3000
      }
    }
  }

  apiLog.logSuccess('Monday', 'createContact', { contactId: created.id, boardId })

  await trackAnalytics({ user, crm: 'Monday', event: 'contactCreated' });

  const createdBoardName =
    (user?.platformAdditionalInfo || user?.dataValues?.platformAdditionalInfo || {})?.boardName
  const createdBoardLabel = boardDisplayLabel({ boardName: createdBoardName, boardId })
  // A contact created mid-call is logged immediately afterwards, so carry the Project options back
  // with it — otherwise the very first call for a new contact is the one that cannot reach a project.
  const createdProjectAdditionalInfo = projects.buildProjectAdditionalInfo({
    user,
    boards: await getBoardsForOptions({ user, accessToken: resolvedAccessToken, operation: 'createContact' }),
    contactBoard: contactBoardOf(user)
  })
  return {
    contactInfo: {
      id: created.id,
      name: created.name,
      // `type`/`contactType` carry the board name (self-labeled "Board: …") for display; `boardId`
      // targets the board for logging, and the deep-link URL resolves the board via the
      // {contactBoardId} setting.
      type: createdBoardLabel,
      contactType: createdBoardLabel,
      boardId,
      ...(createdProjectAdditionalInfo ? { additionalInfo: createdProjectAdditionalInfo } : {})
    },
    returnMessage: {
      messageType: 'success',
      message: 'New contact created',
      ttl: 3000
    }
  }
}

async function getMondayUserName(user) {
  if (!user || !user.id || !models || !models.customer) return '';
  try {
    const existingCustomer = await models.customer.findOne({
      where: { sysId: String(user.id) },
      raw: true
    });
    if (existingCustomer) {
      return [existingCustomer.firstname, existingCustomer.lastname].filter(Boolean).join(' ');
    }
  } catch (e) {
    console.warn('[Monday] Failed to fetch user name from db:', e.message);
  }
  return '';
}

async function createCallLog({ contactInfo, callLog, note, aiNote, transcript, additionalSubmission, accessToken, authHeader, user }) {
  apiLog.logStart('Monday', 'createCallLog', { contactId: contactInfo?.id, direction: callLog?.direction, duration: callLog?.duration, sessionId: callLog?.sessionId, hasRecording: !!callLog?.recording?.downloadUrl });
  const licenseError = await validateLicenseOrFail(user, 'createCallLog');
  if (licenseError) return licenseError;

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  // Log directly against the contact passed in — like ServiceTitan/ServiceNow — instead of
  // re-querying Monday for the board. create_update only needs the item id (contactInfo.id),
  // so no board lookup ("search") is needed on the main path. The board id is only needed for
  // an optional recording upload, which resolves it lazily below. In single-board mode we read
  // the persisted board id off the user record (no API call) — `contactInfo.type` now carries
  // the board NAME for display, so it can no longer double as the board id.
  const persistedPai = user?.platformAdditionalInfo || user?.dataValues?.platformAdditionalInfo || {};
  const boardId = String(contactInfo?.boardId || persistedPai.boardId || '') || null;
  // If this call came in on a number the picked contact lacks, log against a NEW item carrying
  // that number (Monday's phone column holds a single value). `target` is the picked contact
  // otherwise; everything below logs against target.id.
  const receivedNumber = phoneWriteback.resolveCounterpartyNumber({ callLog });
  const target = await resolveLogTarget({ user, accessToken: resolvedAccessToken, contactInfo, boardId, receivedNumber, logPrefix: '[Monday] createCallLog:' });
  // Fall back to a generated subject when no custom subject is supplied — matches every
  // other connector (clio/insightly/netsuite) and avoids the blank "Subject:" line.
  const defaultSubject = `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo?.name || 'contact'}`
  const subject =
    (user.userSettings?.addCallLogSubject?.value ?? true)
      ? (callLog?.customSubject?.trim() || defaultSubject)
      : ""

  let sections = []

  if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
    sections.push(`Agent Notes:<br>${note.replace(/\r?\n/g, '<br>')}`)
  }
  if (callLog?.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) {
    sections.push(`Recording:<br>${callLog.recording.link}`)
  }
  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
    sections.push(`AI Note:<br>${stripMarkdownBold(aiNote).replace(/\r?\n/g, '<br>')}`)
  }
  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
    sections.push(`Transcript:<br>${transcript.replace(/\r?\n/g, '<br>')}`)
  }

  const optionalSections = sections.join("<br><br>")

  const headerLines = [];
  if (subject) headerLines.push(`Subject: ${subject}`);
  if (callLog.direction) headerLines.push(`Direction: ${callLog.direction}`);

  if (callLog?.result && (user.userSettings?.addCallLogResult?.value ?? true)) {
    headerLines.push(`Result: ${callLog.result}`);
  }
  if (callLog?.duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
    headerLines.push(`Duration: ${callLog.duration} sec`);
  }
  if (callLog?.sessionId && (user.userSettings?.addCallSessionId?.value ?? true)) {
    headerLines.push(`Call Session ID: ${callLog.sessionId}`);
  }
  const mondayUserName = await getMondayUserName(user);
  const agentParty = callLog?.direction === 'Inbound' ? callLog?.to : callLog?.from;
  const rcNameFromLog = agentParty?.name;
  const rcUserName = rcNameFromLog || mondayUserName || '';
  if (rcUserName && (user.userSettings?.addRingCentralUserName?.value ?? true)) {
    headerLines.push(`RingCentral Username: ${rcUserName}`);
  }
  // We don't have additionalSubmission in Monday's createCallLog signature yet, but we can extract rcPhone
  // from callLog if it's there.
  const rcPhone = callLog?.extensionNumber || (callLog?.direction === 'Inbound' ? callLog?.to?.phoneNumber : callLog?.from?.phoneNumber);
  if (rcPhone && (user.userSettings?.addRingCentralNumber?.value ?? true)) {
    headerLines.push(`RingCentral Phone Number: ${rcPhone}`);
  }
  const contactPhone = contactInfo?.phoneNumber || contactInfo?.phone;
  if (contactPhone && (user.userSettings?.addCallLogContactNumber?.value ?? true)) {
    headerLines.push(`Contact Number: ${contactPhone}`);
  }

  const footerLines = [];
  if (callLog.startTime && (user.userSettings?.addCallLogDateTime?.value ?? true)) {
    footerLines.push(`Start Time: ${formatDateTime({ user, time: callLog.startTime })}`);
    if (callLog.duration) {
      footerLines.push(`End Time: ${formatDateTime({ user, time: moment(callLog.startTime).add(callLog.duration, "seconds") })}`);
    }
  }

  const lines = [...headerLines];
  if (optionalSections) {
    lines.push("");
    lines.push(optionalSections);
  }
  if (footerLines.length > 0) {
    lines.push("");
    lines.push(...footerLines);
  }

  const body = lines.join("<br>").replace(/^(<br>)+|(<br>)+$/g, '');

  const res = await mondayRequest(
    resolvedAccessToken,
    `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
    `,
    {
      itemId: Number(target.id),
      body
    },
    { operation: 'createCallLog' }
  )
  assertNoGraphqlErrors(res, `createCallLog (create_update itemId=${target.id})`)

  const updateId = res?.data?.create_update?.id
  if (!updateId) {
    throw new Error(`Monday createCallLog: create_update returned no id for itemId=${target.id}`)
  }
  apiLog.logSuccess('Monday', 'createCallLog', { logId: updateId, contactId: Number(target.id), boardId })

  // ---- Project copy ----
  // The contact item above is the log's system of record; the project item is where the team
  // working the job will actually read it. Resolving and writing it never throws — a project
  // problem downgrades to "logged to the contact only" rather than losing the call.
  const projectTarget = await projects.resolveTargetProjectItem({
    user,
    accessToken: resolvedAccessToken,
    additionalSubmission,
    contactInfo: target,
    contactBoard: contactBoardOf(user) || (boardId ? { id: boardId } : null),
    boards: await boardsForProjectResolution({ user, accessToken: resolvedAccessToken, additionalSubmission, operation: 'createCallLog' }),
    mondayUserId: mondayUserIdOf(user),
    activityTime: callLog?.startTime,
    logPrefix: '[Monday] createCallLog:',
    operation: 'createCallLog'
  })
  forgetCachedBoards(user, projectTarget.createdBoard)
  const projectUpdateId = projectTarget.itemId
    ? await projects.postUpdate({ accessToken: resolvedAccessToken, itemId: projectTarget.itemId, body, operation: 'createCallLog' })
    : null
  if (projectUpdateId) {
    apiLog.logSuccess('Monday', 'createCallLog', { logId: projectUpdateId, itemId: projectTarget.itemId, boardId: projectTarget.boardId, target: 'project' })
    await trackAnalytics({ user, crm: 'Monday', event: 'projectLogCreated' });
  }

  // ---- Recording Upload ----
  // Only here is the board id actually needed. Use the one carried on the contact; resolve
  // it lazily (one query) only if it wasn't provided, so the call log itself never blocks on
  // board discovery.
  if (callLog?.recording?.downloadUrl) {
    const uploadBoardId = boardId || await resolveBoardId({ accessToken: resolvedAccessToken, user, operation: 'createCallLog' })
    const fileName = `Call-${Date.now()}.mp3`
    const s3Key = fileName
    const s3Url = await downloadAudioFile(
      callLog.recording.downloadUrl,
      process.env.S3_BUCKET,
      s3Key
    )

    if (s3Url) {
      await uploadToMonday({
        s3Url,
        accessToken: resolvedAccessToken,
        itemId: Number(target.id),
        fileName,
        boardId: uploadBoardId
      })
    }
  }

  await trackAnalytics({ user, crm: 'Monday', event: 'callLogCreated' });

  return {
    // The id is the monday.com page "view log details" opens — the project item when one was
    // picked, the contact item otherwise — and carries both updates so a later edit or recording
    // sync can find them (see projects.buildLogId).
    logId: projects.buildLogId({
      contactBoardId: boardId,
      contactItemId: target.id,
      contactUpdateId: updateId,
      projectBoardId: projectTarget.boardId,
      projectItemId: projectTarget.itemId,
      projectUpdateId
    }),
    contactId: Number(target.id),
    returnMessage: {
      message: projectTarget.warning || "Call log created",
      messageType: projectTarget.warning ? "warning" : "success",
      ttl: projectTarget.warning ? 4000 : 2000
    }
  }
}

// Mirror createCallLog's recording upload for updates: the recording usually arrives AFTER
// the log is created (recording-sync fires updateCallLog), so attach the audio file to the
// contact item's Files column here too. Failures are logged but never break the log update.
// `recordingLink` here should be the DOWNLOAD link (tokenized) when available — the
// media-reader page link often has no accessToken, so downloading it fails auth.
async function uploadCallRecording({ accessToken, user, itemId, recordingLink, operation = 'updateCallLog' }) {
  if (!recordingLink || !itemId) return
  try {
    const boardId = await resolveBoardId({ accessToken, user, operation })
    const fileName = `Call-${Date.now()}.mp3`
    const s3Url = await downloadAudioFile(recordingLink, process.env.S3_BUCKET, fileName)
    if (!s3Url) {
      console.warn(`[Monday][${operation}] recording download failed — skipping file upload`, { itemId })
      return
    }
    await uploadToMonday({ s3Url, accessToken, itemId: Number(itemId), fileName, boardId })
    console.log(`[Monday][${operation}] recording file attached`, { itemId, boardId })
  } catch (e) {
    console.warn(`[Monday][${operation}] recording upload failed`, { itemId, message: e.message })
  }
}

async function updateCallLog({ existingCallLog, recordingLink, recordingDownloadLink, note, aiNote, transcript, additionalSubmission, accessToken, authHeader, user, subject, duration, startTime, result }) {
  const licenseError = await validateLicenseOrFail(user, 'updateCallLog');
  if (licenseError) return licenseError;

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  // The stored id may carry a project copy written when the call was first logged; the contact
  // item's update is always its first segment.
  const storedLogId = existingCallLog?.thirdPartyLogId
  const parsedLogId = projects.parseLogId(storedLogId)
  const logId = parsedLogId.updateId
  let projectBoardId = parsedLogId.projectBoardId
  let projectItemId = parsedLogId.projectItemId
  let projectUpdateId = parsedLogId.projectUpdateId
  const itemId = Number(existingCallLog?.contactId)
  apiLog.logStart('Monday', 'updateCallLog', {
    logId,
    contactId: existingCallLog?.contactId,
    isNumericId: isNumericMondayId(logId),
    projectItemId,
    hasRecordingLink: !!recordingLink,
    hasRecordingDownloadLink: !!recordingDownloadLink
  })

  // 1. Read the existing update so we can merge with it — only if the stored id is a
  // valid (numeric) Monday update id. A stale/hash id is skipped to avoid the API 500.
  let oldBody = ''
  let canEditExisting = false
  if (isNumericMondayId(logId)) {
    try {
      const res = await mondayRequest(
        resolvedAccessToken,
        `
        query ($updateId: [ID!]) {
          updates(ids: $updateId) {
            id
            body
          }
        }
        `,
        { updateId: [logId] },
        { operation: 'updateCallLog' }
      )
      if (res?.errors?.length) {
        console.warn('[Monday][updateCallLog] could not read existing update; will recreate', { logId })
      } else if (res?.data?.updates?.length) {
        oldBody = res.data.updates[0].body || ''
        canEditExisting = true
      } else {
        console.warn('[Monday][updateCallLog] existing update not found; will recreate', { logId })
      }
    } catch (e) {
      console.warn('[Monday][updateCallLog] reading existing update threw; will recreate', { logId, message: e.message })
    }
  } else {
    console.warn('[Monday][updateCallLog] stored thirdPartyLogId is not a numeric Monday update id; will recreate', { logId })
  }

  const parsed = parseMondayCallLogBody(oldBody)
  let subjectToUse = parsed.subject

  if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
    subjectToUse = subject.trim()
  }

  // Preserve sections the original log already had: an update often supplies only ONE
  // field (e.g. a recording-sync or disposition update arrives with note/duration empty).
  // Without these fallbacks the rebuilt body silently drops the existing note, duration
  // and recording — which is exactly how a fully-populated log became "Subject:/Direction/
  // Start/End" only. Fall back to the parsed (existing) value when no new one is supplied.
  const effectiveNote = note || parsed.agentNote
  const effectiveDurationLine = duration ? `${duration} sec` : parsed.duration
  const effectiveRecording = recordingLink || parsed.recording
  const effectiveAiNote = aiNote || parsed.aiNote
  const effectiveTranscript = transcript || parsed.transcript
  const effectiveSessionId = parsed.sessionId
  const mondayUserName = await getMondayUserName(user);
  const agentParty = existingCallLog?.direction === 'Inbound' ? existingCallLog?.to : existingCallLog?.from;
  const rcNameFromLog = agentParty?.name;
  const effectiveRcUserName = parsed.rcUserName || rcNameFromLog || mondayUserName || '';
  const effectiveRcPhoneNumber = parsed.rcPhoneNumber
  const effectiveContactNumber = parsed.contactNumber

  let sections = []

  if (effectiveNote && (user.userSettings?.addCallLogNote?.value ?? true)) {
    sections.push(`Agent Notes:<br>${effectiveNote.replace(/\r?\n/g, '<br>')}`)
  }
  if (effectiveRecording && (user.userSettings?.addCallLogRecording?.value ?? true)) {
    sections.push(`Recording:<br>${effectiveRecording}`)
  }
  if (effectiveAiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
    sections.push(`AI Note:<br>${stripMarkdownBold(effectiveAiNote).replace(/\r?\n/g, '<br>')}`)
  }
  if (effectiveTranscript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
    sections.push(`Transcript:<br>${effectiveTranscript.replace(/\r?\n/g, '<br>')}`)
  }

  let startTimeToUse = parsed.startTime
  let endTimeToUse = parsed.endTime

  if (startTime) {
    startTimeToUse = formatDateTime({ user, time: startTime })
    if (duration) {
      endTimeToUse = formatDateTime({ user, time: moment(startTime).add(duration, "seconds") })
    }
  }

  const optionalSections = sections.join("<br><br>")

  const headerLines = [];
  if (subjectToUse) headerLines.push(`Subject: ${subjectToUse}`);
  if (parsed.direction) headerLines.push(`Direction: ${parsed.direction}`);

  const effectiveResult = result || parsed.result;
  if (effectiveResult && (user.userSettings?.addCallLogResult?.value ?? true)) {
    headerLines.push(`Result: ${effectiveResult}`);
  }
  if (effectiveDurationLine && (user.userSettings?.addCallLogDuration?.value ?? true)) {
    headerLines.push(`Duration: ${effectiveDurationLine}`);
  }
  if (effectiveSessionId && (user.userSettings?.addCallSessionId?.value ?? true)) {
    headerLines.push(`Call Session ID: ${effectiveSessionId}`);
  }
  if (effectiveRcUserName && (user.userSettings?.addRingCentralUserName?.value ?? true)) {
    headerLines.push(`RingCentral Username: ${effectiveRcUserName}`);
  }
  if (effectiveRcPhoneNumber && (user.userSettings?.addRingCentralNumber?.value ?? true)) {
    headerLines.push(`RingCentral Phone Number: ${effectiveRcPhoneNumber}`);
  }
  if (effectiveContactNumber && (user.userSettings?.addCallLogContactNumber?.value ?? true)) {
    headerLines.push(`Contact Number: ${effectiveContactNumber}`);
  }

  const footerLines = [];
  // For updates, we use the parsed start/end time or the new ones, but we still respect the setting
  // to include them or not (if they exist).
  if (startTimeToUse && (user.userSettings?.addCallLogDateTime?.value ?? true)) {
    footerLines.push(`Start Time: ${startTimeToUse}`);
  }
  if (endTimeToUse && (user.userSettings?.addCallLogDateTime?.value ?? true)) {
    footerLines.push(`End Time: ${endTimeToUse}`);
  }

  const lines = [...headerLines];
  if (optionalSections) {
    lines.push("");
    lines.push(optionalSections);
  }
  if (footerLines.length > 0) {
    lines.push("");
    lines.push(...footerLines);
  }

  const body = lines.join("<br>").replace(/^(<br>)+|(<br>)+$/g, '');

  // ---- Project copy ----
  // A project can be picked when the log is edited, not only when it is created, so resolve one
  // here too when the stored id carries none yet. Automatic updates (recording sync) submit no
  // form and simply keep whatever the original log chose.
  if (!projectItemId && additionalSubmission?.project) {
    const projectTarget = await projects.resolveTargetProjectItem({
      user,
      accessToken: resolvedAccessToken,
      additionalSubmission,
      // Only the contact's item id survives into an update; resolveTargetProjectItem reads the
      // name off it when needed.
      contactInfo: { id: existingCallLog?.contactId },
      contactBoard: contactBoardOf(user),
      boards: await boardsForProjectResolution({ user, accessToken: resolvedAccessToken, additionalSubmission, operation: 'updateCallLog' }),
      mondayUserId: mondayUserIdOf(user),
      activityTime: startTime,
      logPrefix: '[Monday] updateCallLog:',
      operation: 'updateCallLog'
    })
    forgetCachedBoards(user, projectTarget.createdBoard)
    projectBoardId = projectTarget.boardId
    projectItemId = projectTarget.itemId
  }

  // Mirrors the freshly built body onto the project item, then composes the id the caller stores
  // and repoints the log record when it changed. Used by both the edit and the recreate path.
  async function writeProjectCopy(contactUpdateId) {
    if (projectItemId) {
      const mirrored = await projects.mirrorUpdate({
        accessToken: resolvedAccessToken,
        projectItemId,
        projectUpdateId,
        body,
        operation: 'updateCallLog'
      })
      projectUpdateId = mirrored || projectUpdateId
    }
    const composed = projects.buildLogId({
      contactBoardId: contactBoardOf(user)?.id,
      contactItemId: existingCallLog?.contactId,
      contactUpdateId,
      projectBoardId,
      projectItemId,
      projectUpdateId
    })
    if (composed !== String(storedLogId ?? '') && typeof existingCallLog?.update === 'function') {
      try {
        await existingCallLog.update({ thirdPartyLogId: composed })
      } catch (e: any) {
        console.warn('[Monday][updateCallLog] failed to repoint thirdPartyLogId', { composed, message: e.message })
      }
    }
    return composed
  }

  // ---- Recording Upload (recording-sync) ----
  // RingCentral recordings are usually NOT ready when the call is first logged, so
  // createCallLog's upload is skipped and the recording only arrives here, on the later
  // recording-sync, as `recordingDownloadLink`. Upload it now so the MP3 lands in the board's
  // Files column. Dedupe against the case where the recording WAS ready at create: if the
  // existing log body already has a Recording section (`parsed.recording`), createCallLog
  // already handled the file — skip to avoid a duplicate upload.
  if (recordingDownloadLink && !parsed.recording && itemId && (user.userSettings?.addCallLogRecording?.value ?? true)) {
    try {
      const uploadBoardId = await resolveBoardId({ accessToken: resolvedAccessToken, user })
      const fileName = `Call-${Date.now()}.mp3`
      const s3Url = await downloadAudioFile(recordingDownloadLink, process.env.S3_BUCKET, fileName)
      await uploadToMonday({ s3Url, accessToken: resolvedAccessToken, itemId, fileName, boardId: uploadBoardId })
    } catch (e: any) {
      console.warn('[Monday][updateCallLog] recording upload failed:', e.message)
    }
  }

  // 2. Edit the existing update if we could read it.
  if (canEditExisting) {
    try {
      const updateRes = await mondayRequest(
        resolvedAccessToken,
        `
        mutation ($updateId: ID!, $body: String!) {
          edit_update(id: $updateId, body: $body) {
            id
          }
        }
        `,
        { updateId: logId, body },
        { operation: 'updateCallLog' }
      )
      if (!updateRes?.errors?.length && updateRes?.data?.edit_update?.id) {
        // Attach the recording file only when a NEW recording link arrived (the old body not
        // already carrying it) — otherwise every later edit would re-upload a duplicate file.
        // Prefer the tokenized download link; the display link is the fallback.
        if (recordingLink && recordingLink !== parsed.recording) {
          await uploadCallRecording({ accessToken: resolvedAccessToken, user, itemId, recordingLink: recordingDownloadLink || recordingLink })
        }
        apiLog.logSuccess('Monday', 'updateCallLog', { logId: updateRes.data.edit_update.id, contactId: existingCallLog?.contactId, mode: 'edited' });
        await trackAnalytics({ user, crm: 'Monday', event: 'callLogUpdated' });
        return {
          logId: await writeProjectCopy(updateRes.data.edit_update.id),
          returnMessage: { message: "Call log updated", messageType: "success", ttl: 2000 }
        }
      }
      console.warn('[Monday][updateCallLog] edit_update failed; will recreate', { logId, errors: stringifyForLog(updateRes?.errors, 500) })
    } catch (e) {
      console.warn('[Monday][updateCallLog] edit_update threw; will recreate', { logId, message: e.message })
    }
  }

  // 3. Fallback: the stored update is missing/invalid — create a fresh update on the
  // contact item and repoint thirdPartyLogId so future updates edit it (no duplicates).
  if (!itemId) {
    throw new Error(`Monday updateCallLog: cannot recreate update — existingCallLog.contactId is missing/invalid (${existingCallLog?.contactId})`)
  }
  const createRes = await mondayRequest(
    resolvedAccessToken,
    `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
    `,
    { itemId, body },
    { operation: 'updateCallLog' }
  )
  assertNoGraphqlErrors(createRes, 'updateCallLog (create_update fallback)')
  const newLogId = createRes?.data?.create_update?.id
  if (!newLogId) {
    throw new Error('Monday updateCallLog: fallback create_update returned no id')
  }
  apiLog.logSuccess('Monday', 'updateCallLog', { logId: newLogId, oldLogId: logId, contactId: itemId, mode: 'recreated' })
  if (recordingLink && recordingLink !== parsed.recording) {
    await uploadCallRecording({ accessToken: resolvedAccessToken, user, itemId, recordingLink: recordingDownloadLink || recordingLink })
  }
  // Repoint the stored id so the next update edits this new update instead of recreating.
  const recreatedLogId = await writeProjectCopy(newLogId)

  await trackAnalytics({ user, crm: 'Monday', event: 'callLogUpdated' });

  return {
    logId: recreatedLogId,
    returnMessage: { message: "Call log updated", messageType: "success", ttl: 2000 }
  }
}

async function getCallLog({ callLogId, accessToken, authHeader, user }) {
  apiLog.logStart('Monday', 'getCallLog', { logId: callLogId });
  const licenseError = await validateLicenseOrFail(user, 'getCallLog');
  if (licenseError) return licenseError;

  // The log's own copy on the contact item is the one that is read back; a project copy appended
  // to the id (see projects.buildLogId) is a mirror and holds nothing extra.
  const contactUpdateId = projects.parseLogId(callLogId).updateId

  // A non-numeric stored id (e.g. a stale hash) is not a valid Monday update id and
  // makes the API 500 — skip the doomed query and report "not found" cleanly so the
  // caller (updateCallLog) recreates the update instead.
  if (!isNumericMondayId(contactUpdateId)) {
    console.warn('[Monday][getCallLog] skipping fetch — callLogId is not a numeric Monday update id', { callLogId })
    return {
      callLogInfo: {},
      returnMessage: { messageType: 'warning', message: 'Call log not found', ttl: 3000 }
    }
  }

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  const res = await mondayRequest(
    resolvedAccessToken,
    `
    query ($updateId: [ID!]) {
      updates(ids: $updateId) {
        id
        body
      }
    }
    `,
    { updateId: [contactUpdateId] },
    { operation: 'getCallLog' }
  )

  if (res?.errors?.length || !res?.data?.updates?.length) {
    // The stored update may have been deleted, or the id predates this connector. Treat
    // it as "not found" (a warning, not a hard error) so the update flow recreates the
    // update instead of surfacing an alarming "Failed to fetch call log" to the user.
    if (res?.errors?.length) {
      console.warn('[Monday][getCallLog] updates query returned errors', { callLogId, error: res.errors[0]?.message })
    } else {
      console.log('[Monday][getCallLog] no update found for id', { callLogId })
    }
    return {
      callLogInfo: {},
      returnMessage: { messageType: 'warning', message: 'Call log not found', ttl: 3000 }
    }
  }

  const update = res.data.updates[0]
  const rawBody = update.body || ''
  const parsed = parseMondayCallLogBody(rawBody)

  apiLog.logSuccess('Monday', 'getCallLog', { logId: callLogId })
  return {
    callLogInfo: {
      subject: parsed.subject,
      note: parsed.agentNote,
      fullBody: rawBody,
      fullLogResponse: update
    },
    returnMessage: {
      messageType: 'success',
      message: 'Call log fetched',
      ttl: 3000
    }
  }
}

async function upsertCallDisposition({ existingCallLog }) {
  return { logId: existingCallLog.thirdPartyLogId }
}

async function createMessageLog({ user, contactInfo, message, recordingLink, recordingDownloadLink, faxDocLink, faxDownloadLink, additionalSubmission, accessToken }) {
  apiLog.logStart('Monday', 'createMessageLog', { contactId: contactInfo?.id, direction: message?.direction, hasRecording: !!recordingLink, hasRecordingDownloadLink: !!recordingDownloadLink, hasFax: !!faxDocLink });
  const licenseError = await validateLicenseOrFail(user, 'createMessageLog');
  if (licenseError) return licenseError;

  const resolvedAccessToken = accessToken || user?.accessToken
  const boardId = await resolveBoardId({ accessToken: resolvedAccessToken, user, operation: 'createMessageLog' });
  // If this message came in on a number the picked contact lacks, log against a NEW item
  // carrying that number (Monday's phone column holds a single value). `target` is the picked
  // contact otherwise.
  const receivedNumber = phoneWriteback.resolveCounterpartyNumber({ message });
  const target = await resolveLogTarget({ user, accessToken: resolvedAccessToken, contactInfo, boardId, receivedNumber, logPrefix: '[Monday] createMessageLog:' });
  const itemId = Number(target.id)
  const messageType =
    recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS')
  let body = ""

  if (messageType === "SMS") {
    const sender =
      message.direction === 'Inbound'
        ? contactInfo.name
        : 'You'
    const text = message.subject || message.text || ''
    body = `SMS conversation with ${contactInfo.name}<br>`
    body += `[${formatDateTime({ user, time: message.creationTime || Date.now() })}] ${sender}: ${text}<br>`

  }

  else if (messageType === "Voicemail") {
    body = `Voicemail from ${contactInfo.name}<br><br>Recording:<br>${recordingLink}`
  }

  else if (messageType === "Fax") {
    body = `Fax from ${contactInfo.name}<br><br>Document:<br>${faxDocLink}`
  }

  const res = await mondayRequest(
    resolvedAccessToken,
    `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
    `,
    {
      itemId,
      body
    },
    { operation: 'createMessageLog' }
  )

  if (!res?.data?.create_update?.id) {
    throw new Error('Failed to create message log')
  }

  const updateId = res.data.create_update.id

  // ---- Project copy ----
  // Same contract as calls: the contact item's thread is the system of record, the project item
  // gets a mirror of it, and a project problem never fails the message log.
  const projectTarget = await projects.resolveTargetProjectItem({
    user,
    accessToken: resolvedAccessToken,
    additionalSubmission,
    contactInfo: target,
    contactBoard: contactBoardOf(user) || (boardId ? { id: boardId } : null),
    boards: await boardsForProjectResolution({ user, accessToken: resolvedAccessToken, additionalSubmission, operation: 'createMessageLog' }),
    mondayUserId: mondayUserIdOf(user),
    activityTime: message?.creationTime,
    logPrefix: '[Monday] createMessageLog:',
    operation: 'createMessageLog'
  })
  forgetCachedBoards(user, projectTarget.createdBoard)
  const projectUpdateId = projectTarget.itemId
    ? await projects.postUpdate({ accessToken: resolvedAccessToken, itemId: projectTarget.itemId, body, operation: 'createMessageLog' })
    : null

  if (recordingLink || faxDocLink) {
    // Prefer the tokenized download links — the display links (media-reader pages)
    // have no access token and 401 when downloaded server-side.
    const downloadUrl = recordingDownloadLink || faxDownloadLink || getVoicemailDownloadLink(message) || recordingLink || faxDocLink
    const fileName =
      recordingLink
        ? `Voicemail-${Date.now()}.mp3`
        : `Fax-${Date.now()}.pdf`
    const s3Key = fileName
    const s3Url = await downloadAudioFile(
      downloadUrl,
      process.env.S3_BUCKET,
      s3Key
    )

    if (s3Url) {
      await uploadToMonday({
        s3Url,
        accessToken: resolvedAccessToken,
        itemId,
        fileName,
        boardId
      })
    }
  }

  await trackAnalytics({ user, crm: 'Monday', event: 'messageLogCreated' });

  apiLog.logSuccess('Monday', 'createMessageLog', { logId: updateId, contactId: itemId, messageType, boardId, projectItemId: projectTarget.itemId })
  return {
    logId: projects.buildLogId({
      contactBoardId: boardId,
      contactItemId: target.id,
      contactUpdateId: updateId,
      projectBoardId: projectTarget.boardId,
      projectItemId: projectTarget.itemId,
      projectUpdateId
    }),
    contactId: itemId,
    returnMessage: {
      message: projectTarget.warning || 'Message thread created',
      messageType: projectTarget.warning ? 'warning' : 'success',
      ttl: projectTarget.warning ? 4000 : 1000
    }
  }
}

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, recordingLink, recordingDownloadLink, faxDocLink, faxDownloadLink, accessToken }) {
  apiLog.logStart('Monday', 'updateMessageLog', { contactId: contactInfo?.id, logId: existingMessageLog?.thirdPartyLogId, direction: message?.direction, hasRecording: !!recordingLink, hasFax: !!faxDocLink });
  const licenseError = await validateLicenseOrFail(user, 'updateMessageLog');
  if (licenseError) return licenseError;

  const MAX_THREAD_MESSAGES = 10
  const resolvedAccessToken = accessToken || user?.accessToken
  const boardId = await resolveBoardId({ accessToken: resolvedAccessToken, user, operation: 'updateMessageLog' });
  const itemId = Number(contactInfo.id)
  // The stored id carries the project copy the thread was created with, so appends reach the same
  // project item without the agent picking it again (an append submits no form at all).
  const storedMessageLogId = existingMessageLog.thirdPartyLogId
  const parsedMessageLogId = projects.parseLogId(storedMessageLogId)
  const updateId = parsedMessageLogId.updateId
  const projectBoardId = parsedMessageLogId.projectBoardId
  const projectItemId = parsedMessageLogId.projectItemId
  const projectUpdateId = parsedMessageLogId.projectUpdateId
  const messageType =
    recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS')

  // ------------------------------------------------
  // VOICEMAIL OR FAX → always create new update
  // ------------------------------------------------

  if (messageType !== "SMS") {
    let body = ""
    if (messageType === "Voicemail") {
      body = `Voicemail from ${contactInfo.name}<br><br>Recording:<br>${recordingLink}`
    }

    if (messageType === "Fax") {
      body = `Fax from ${contactInfo.name}<br><br>Document:<br>${faxDocLink}`
    }

    const res = await mondayRequest(
      resolvedAccessToken,
      `
      mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) {
          id
        }
      }
      `,
      {
        itemId,
        body
      },
      { operation: 'updateMessageLog' }
    )

    const newUpdateId = res.data.create_update.id

    // A voicemail or fax is its own update rather than an append, so the project item gets its own
    // new update too — no old one to supersede.
    const newProjectUpdateId = projectItemId
      ? await projects.postUpdate({ accessToken: resolvedAccessToken, itemId: projectItemId, body, operation: 'updateMessageLog' })
      : null
    if (projectItemId) {
      await stampProjectItem({ user, accessToken: resolvedAccessToken, projectBoardId, projectItemId, activityTime: message?.creationTime })
    }

    await trackAnalytics({ user, crm: 'Monday', event: 'messageLogUpdated' });

    apiLog.logSuccess('Monday', 'updateMessageLog', { logId: newUpdateId, contactId: itemId, messageType, projectItemId })
    return {
      logId: projects.buildLogId({
        contactBoardId: boardId,
        contactItemId: itemId,
        contactUpdateId: newUpdateId,
        projectBoardId,
        projectItemId,
        projectUpdateId: newProjectUpdateId
      }),
      returnMessage: {
        message: 'Message logged',
        messageType: 'success',
        ttl: 1000
      }
    }
  }

  // ------------------------------------------------
  // SMS THREAD
  // ------------------------------------------------

  const existing = await mondayRequest(
    resolvedAccessToken,
    `
    query ($updateId: [ID!]) {
      updates(ids: $updateId) {
        id
        body
      }
    }
    `,
    { updateId: [updateId] },
    { operation: 'updateMessageLog' }
  )

  const previousBody =
    existing?.data?.updates?.[0]?.body || ''
  const sender =
    message.direction === 'Inbound'
      ? contactInfo.name
      : 'You'
  const text = message.subject || message.text || ''
  // No leading/trailing <br> on the message line itself — junction breaks are added
  // explicitly below, so messages are separated by exactly ONE line break (the old
  // `<br>…<br>` pattern doubled up into a blank line between every message).
  const newLine = `[${formatDateTime({ user, time: message.creationTime || Date.now() })}] ${sender}: ${text}`
  const messageLines =
    previousBody
      .split('<br>')
      .filter(l => l.includes(':'))
  const messageCount = messageLines.length
  let updatedBody
  let response
  let newThreadId = updateId
  // On a thread reset (>= MAX messages) the old update stays as history; otherwise the
  // new update carries the merged history forward and the old one is deleted.
  let shouldDeleteOld = false

  if (messageCount >= MAX_THREAD_MESSAGES) {
    updatedBody =
      `SMS conversation with ${contactInfo.name}<br>${newLine}`
  } else {
    shouldDeleteOld = true
    // Collapse legacy double breaks, then strip trailing breaks so the append adds
    // exactly one line break — this also cleans up old threads on their next message.
    const trimmedPrevious = previousBody
      .replace(/(<br\s*\/?>)\s*(<br\s*\/?>)+/gi, '$1')
      .replace(/(?:\s|<br\s*\/?>)+$/i, '')
    updatedBody = trimmedPrevious
      ? `${trimmedPrevious}<br>${newLine}`
      : `SMS conversation with ${contactInfo.name}<br>${newLine}`
  }

  // Monday's updates feed is ordered by creation time and edit_update does NOT move an
  // update up — so an ongoing conversation stayed buried under newer updates. Recreate
  // the thread (create a fresh update with the full history, then delete the old one)
  // so the conversation always surfaces on top.
  response = await mondayRequest(
    resolvedAccessToken,
    `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
    `,
    {
      itemId,
      body: updatedBody
    },
    { operation: 'updateMessageLog' }
  )
  assertNoGraphqlErrors(response, 'updateMessageLog (create_update SMS thread)')
  newThreadId = response?.data?.create_update?.id
  if (!newThreadId) {
    throw new Error('Monday updateMessageLog: create_update returned no id')
  }

  if (shouldDeleteOld && isNumericMondayId(updateId) && String(newThreadId) !== String(updateId)) {
    try {
      await mondayRequest(
        resolvedAccessToken,
        `
        mutation ($updateId: ID!) {
          delete_update(id: $updateId) {
            id
          }
        }
        `,
        { updateId },
        { operation: 'updateMessageLog' }
      )
    } catch (e) {
      console.warn('[Monday][updateMessageLog] failed to delete old thread update — a duplicate may remain', { oldUpdateId: updateId, message: e.message })
    }
  }

  // The project item's copy of the thread is recreated the same way and for the same reason: an
  // edited update stays where it was in the feed, so an ongoing conversation would sink out of
  // sight. It carries the history built from the contact thread above, so both read identically.
  const newProjectThreadId = projectItemId
    ? await projects.mirrorThread({
      accessToken: resolvedAccessToken,
      projectItemId,
      projectUpdateId: shouldDeleteOld ? projectUpdateId : null,
      body: updatedBody,
      operation: 'updateMessageLog'
    })
    : null
  // Each new message in the thread is a fresh interaction, so the item's activity stamp moves with it.
  if (projectItemId) {
    await stampProjectItem({ user, accessToken: resolvedAccessToken, projectBoardId, projectItemId, activityTime: message?.creationTime })
  }

  // Repoint the stored id so the next message appends to the recreated thread instead
  // of a deleted update (which would restart the conversation and lose history).
  const composedThreadId = projects.buildLogId({
    contactBoardId: boardId,
    contactItemId: itemId,
    contactUpdateId: newThreadId,
    projectBoardId,
    projectItemId,
    projectUpdateId: newProjectThreadId
  })
  if (composedThreadId !== String(storedMessageLogId ?? '') && typeof existingMessageLog?.update === 'function') {
    try {
      await existingMessageLog.update({ thirdPartyLogId: composedThreadId })
    } catch (e) {
      console.warn('[Monday][updateMessageLog] failed to repoint thirdPartyLogId', { composedThreadId, message: e.message })
    }
  }

  if (recordingLink || faxDocLink) {
    // Prefer the tokenized download links — the display links (media-reader pages)
    // have no access token and 401 when downloaded server-side.
    const downloadUrl = recordingDownloadLink || faxDownloadLink || getVoicemailDownloadLink(message) || recordingLink || faxDocLink
    const fileName =
      recordingLink
        ? `Voicemail-${Date.now()}.mp3`
        : `Fax-${Date.now()}.pdf`
    const s3Key = fileName
    const s3Url = await downloadAudioFile(
      downloadUrl,
      process.env.S3_BUCKET,
      s3Key
    )

    if (s3Url) {
      await uploadToMonday({
        s3Url,
        accessToken: resolvedAccessToken,
        itemId,
        fileName,
        boardId
      })
    }
  }

  await trackAnalytics({ user, crm: 'Monday', event: 'messageLogUpdated' });

  apiLog.logSuccess('Monday', 'updateMessageLog', { logId: newThreadId, contactId: itemId, messageType: 'SMS', appended: newThreadId === updateId, projectItemId })
  return {
    logId: composedThreadId,
    returnMessage: {
      message: 'Message appended',
      messageType: 'success',
      ttl: 1000
    }
  }
}

async function getUserList() {
  return {
    successful: true,
    userList: []
  }
}

async function downloadAudioFile(url, s3Bucket, s3Key) {
  // Unwrap media-reader page links to the raw media content URL (see resolveMediaContentUrl).
  url = resolveMediaContentUrl(url);
  const urlObj = new URL(url);
  // RC media links carry the token as either `accessToken` or `access_token`.
  const accessToken = urlObj.searchParams.get("accessToken") || urlObj.searchParams.get("access_token");
  const s3Values = {
    accessKeyId: process.env.MEDIA_UPLOAD_KEY_ID,
    secretAccessKey: process.env.MEDIA_UPLOAD_SECRET_KEY,
    region: process.env.AWS_REGION
  };
  const s3 = new AWS.S3(s3Values);
  console.log("Downloading Audio File...");

  try {
    // Only send Authorization when we actually have a token — `Bearer null` makes RC
    // reject the request even when the URL itself carries a valid query token.
    const response = await mondayApiClient.get(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      responseType: "stream",
      _operation: 'downloadAudioFile'
    });
    // If we still got a web page instead of media, don't upload it — a .htm file in the
    // Files column is worse than no file.
    const contentType = response.headers?.['content-type'] || '';
    if (contentType.includes('text/html')) {
      console.warn('[Monday][downloadAudioFile] got HTML instead of media — skipping upload', { url: url.split('?')[0], contentType });
      return null;
    }
    const uploadParams = {
      Bucket: s3Bucket,
      Key: s3Key,
      Body: response.data
    };
    const uploadResult = await s3.upload(uploadParams).promise();

    return uploadResult.Location;

  } catch (error) {
    console.log("Error downloading or uploading audio:", error);
  }
}

async function uploadToMonday({ s3Url, accessToken, itemId, fileName, boardId }) {
  try {
    console.log('[Monday][api] → file upload (add_file_to_column)', { itemId, boardId, fileName })
    const filesColumnId = await getOrCreateFilesColumn({
      accessToken,
      boardId,
      operation: 'uploadToMonday'
    })

    if (!filesColumnId) {
      throw new Error('Files column not found on Monday board')
    }

    const s3Key = decodeURIComponent(new URL(s3Url).pathname.substring(1))
    const fileStream = await s3Helper.getObject(s3Key, 'audio')
    const formData = new FormData()

    formData.append(
      'query',
      `
      mutation ($file: File!) {
        add_file_to_column(
          item_id: ${Number(itemId)},
          column_id: "${filesColumnId}",
          file: $file
        ) {
          id
        }
      }
      `
    )

    formData.append('variables[file]', fileStream, {
      filename: fileName,
      contentType: fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'audio/mpeg'
    })

    const response = await mondayApiClient.post(
      `${getMondayApiUrl()}/file`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity,
        _operation: 'uploadToMonday'
      }
    )

    if (response.data?.errors?.length) {
      console.error('[Monday][api] ✗ GraphQL error (file upload)', stringifyForLog(response.data.errors, 800))
    } else {
      console.log('[Monday][api] ← file upload ok', stringifyForLog(response.data, 400))
    }
    await s3Helper.deleteObject(s3Key, 'audio')
    console.log('File deleted from S3:', s3Key)

    return response.data
  } catch (error) {
    console.error(
      '[Monday][api] ✗ file upload error:',
      error?.response?.data || error.message
    )
    throw error
  }
}


function getOverridingOAuthOption({ code, oauthInfo }) {
  return {
    query: {
      grant_type: 'authorization_code',
      client_id: oauthInfo?.clientId,
      client_secret: oauthInfo?.clientSecret,
      redirect_uri: oauthInfo?.redirectUri,
      code,
    },
    headers: {
      Authorization: ''
    }
  };
}

exports.getAuthType = getAuthType;
exports.getOauthInfo = getOauthInfo;
exports.getOverridingOAuthOption = getOverridingOAuthOption;
exports.getUserInfo = getUserInfo;
exports.postSaveUserInfo = postSaveUserInfo;
exports.unAuthorize = unAuthorize;
exports.findContact = findContact;
exports.findContactWithName = findContactWithName;
exports.createContact = createContact;
exports.createCallLog = createCallLog;
exports.updateCallLog = updateCallLog;
exports.getCallLog = getCallLog;
exports.upsertCallDisposition = upsertCallDisposition;
exports.createMessageLog = createMessageLog;
exports.updateMessageLog = updateMessageLog;
exports.getUserList = getUserList;
exports.getLicenseStatus = getLicenseStatus;
export { };
