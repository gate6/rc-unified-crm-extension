const axios = require('axios')
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber')
const { initModels } = require('../servicenow-models/init-models');
const { sequelize } = require('../servicenow-models/sequelize');
const { UserModel } = require('@app-connect/core/models/userModel');
const { AccountDataModel } = require('@app-connect/core/models/accountDataModel');
const { trackAnalytics } = require('../servicenow-core/analytics');
const models = sequelize ? initModels(sequelize) : null;
const FormData = require('form-data')
const s3Helper = require('../servicenow-core/s3');
const AWS = require('aws-sdk');

const licenseHelper = require('../shared/license');
const apiLog = require('../shared/apiLogger');

const MONDAY_API_URL = process.env.MONDAY_API_URL;
const columnIdCache = new Map();
// Cache of discovered CRM boards (those with a Phone column) per connected user.
const boardCache = new Map(); // userId -> { boards: [{ id, name, phoneColumnId }], expiry }
const BOARD_CACHE_TTL_MS = 5 * 60 * 1000;

// A per-request timeout so a slow/hanging Monday call fails fast instead of blocking
// findContact (the contact-existence check) until the extension itself times out and
// aborts the whole "create new contact + log" flow. On timeout the request rejects, the
// caller's try/catch treats it as "no match", and the create prompt still appears.
const MONDAY_REQUEST_TIMEOUT_MS = 12000;
const mondayApiClient = axios.create({ timeout: MONDAY_REQUEST_TIMEOUT_MS });

function stringifyForLog(value, maxLength = 1200) {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
  } catch (error) {
    return String(value);
  }
}

apiLog.installErrorInterceptor(mondayApiClient, 'Monday');

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

let mondayApiCallCounter = 0;

// Extract the GraphQL operation kind + first root field for concise logging.
function describeGraphqlOperation(query) {
  const text = String(query || '');
  const kind = /\bmutation\b/.test(text) ? 'mutation' : 'query';
  const fieldMatch = text.match(/\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/);
  return `${kind} ${fieldMatch ? fieldMatch[1] : 'unknown'}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Monday's "monolith" backend intermittently returns INTERNAL_SERVER_ERROR (status_code
// 500) as a GraphQL error on otherwise-valid queries (commonly items_page_by_column_values).
// These are transient, so a short retry usually succeeds instead of degrading to "no match".
function hasTransientMondayError(errors) {
  return Array.isArray(errors) && errors.some((e) => {
    const code = e?.extensions?.code;
    const status = e?.extensions?.status_code;
    return code === 'INTERNAL_SERVER_ERROR' || (typeof status === 'number' && status >= 500);
  });
}

async function mondayRequest(accessToken, query, variables = {}, { maxAttempts = 2 } = {}) {
  const reqId = ++mondayApiCallCounter;
  const op = describeGraphqlOperation(query);
  let lastBody = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    console.log(attempt === 1 ? '[Monday][api] →' : '[Monday][api] ↻ retry', { reqId, op, attempt, ...(attempt === 1 ? { variables: stringifyForLog(variables, 600) } : {}) });
    try {
      const res = await mondayApiClient.post(
        MONDAY_API_URL,
        { query, variables },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      const ms = Date.now() - startedAt;
      const body = res.data;
      lastBody = body;
      // Monday returns GraphQL errors with HTTP 200, so they bypass the axios
      // interceptor — surface them explicitly here.
      if (body?.errors?.length) {
        console.error('[Monday][api] ✗ GraphQL error', { reqId, op, ms, attempt, errors: stringifyForLog(body.errors, 1000) });
        if (hasTransientMondayError(body.errors) && attempt < maxAttempts) {
          await sleep(400 * attempt);
          continue;
        }
      } else {
        console.log('[Monday][api] ←', { reqId, op, ms, dataKeys: body?.data ? Object.keys(body.data) : [] });
      }
      return body;
    } catch (err) {
      const ms = Date.now() - startedAt;
      const status = err?.response?.status || null;
      console.error('[Monday][api] ✗ HTTP error', { reqId, op, ms, attempt, status, message: err?.message || '', responseBody: stringifyForLog(err?.response?.data, 1000) });
      // Retry transient transport failures (5xx, timeout, network) too.
      const transient = !status || status >= 500 || err?.code === 'ECONNABORTED';
      if (transient && attempt < maxAttempts) {
        await sleep(400 * attempt);
        continue;
      }
      throw err;
    }
  }
  return lastBody;
}

// Throw a descriptive error when a GraphQL response carried errors but the caller
// expects data — keeps failures from surfacing as "Cannot read property of undefined".
function assertNoGraphqlErrors(res, context) {
  if (res?.errors?.length) {
    const message = res.errors.map(e => e?.message).filter(Boolean).join('; ') || 'Unknown Monday GraphQL error';
    throw new Error(`Monday ${context} failed: ${message}`);
  }
}

// Monday update/item IDs are numeric. A non-numeric stored thirdPartyLogId (e.g. a
// hash from a stale record) is invalid and must not be sent to the API.
function isNumericMondayId(id) {
  return id != null && /^\d+$/.test(String(id));
}

async function getOrCreateCallLogsColumn({ accessToken, boardId, columnName = 'Call Logs' }) {
  let columnId = await getColumnIdByName({
    accessToken,
    boardId,
    columnName
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
        column_type: long_text
      ) {
        id
      }
    }
    `,
    {
      boardId: Number(boardId),
      title: columnName
    }
  )

  if (!res?.data?.create_column?.id) {
    throw new Error('Failed to create "Call Logs" column in Monday')
  }

  const newColumnId = res.data.create_column.id

  columnIdCache.set(`${boardId}:${columnName}`, newColumnId)

  return newColumnId
}

async function getOrCreateFilesColumn({ accessToken, boardId, columnName = 'Files' }) {
  let columnId = await getColumnIdByName({
    accessToken,
    boardId,
    columnName
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
    }
  )

  if (!res?.data?.create_column?.id) {
    throw new Error('Failed to create "Files" column in Monday')
  }

  const newColumnId = res.data.create_column.id

  // same cache pattern as Call Logs
  columnIdCache.set(`${boardId}:${columnName}`, newColumnId)

  return newColumnId
}

async function getColumnIdByName({ accessToken, boardId, columnName }) {
  if (!columnName) {
    return null
  }
  if (typeof columnName === 'string' && columnName.trim()) {
    const trimmedName = columnName.trim()
    if (trimmedName !== columnName) {
      columnName = trimmedName
    }
  }
  const cacheKey = `${boardId}:${columnName}`
  if (columnIdCache.has(cacheKey)) {
    return columnIdCache.get(cacheKey)
  }

  const res = await mondayRequest(
    accessToken,
    `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        columns {
          id
          title
        }
      }
    }
    `,
    { boardId: Number(boardId) }
  )
  const boardData = res?.data?.boards?.[0]
  const columns = boardData?.columns || []
  if (!columns.length) {
    console.log('Monday board lookup returned no columns', {
      boardId,
      errors: res?.errors,
      boardData
    })
  }

  const normalizedName = columnName?.toLowerCase()
  const matched = columns.find(col => {
    const title = col.title?.trim()?.toLowerCase()
    return title === normalizedName || col.id === columnName
  })

  if (matched?.id) {
    columnIdCache.set(cacheKey, matched.id)
    return matched.id
  }
  console.log('Monday column not found', {
    boardId,
    columnName,
    availableColumns: columns.map(col => ({ id: col.id, title: col.title }))
  })
  return null
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
    scopes: ['me:read', 'users:read', 'boards:read', 'boards:write', 'updates:write']
  };
}

async function getUserInfo({ authHeader, hostname, query }) {
  // OAuth callback already provides `query` with rcAccountId — no framework change needed.
  const rcAccountId = query?.rcAccountId;
  try {
    const accessToken = authHeader.replace('Bearer ', '');
    if (!accessToken) {
      return {
        successful: false,
        returnMessage: { messageType: 'error', message: 'Failed to get access token.', ttl: 3000 }
      };
    }

    console.log('[Monday][api] → query me (getUserInfo)');
    const userDataResponse = await mondayApiClient.post(
      MONDAY_API_URL,
      { query: "query { me { id name email } }" },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const result = userDataResponse.data;
    if (result?.errors?.length) {
      console.error('[Monday][api] ✗ GraphQL error (getUserInfo me)', stringifyForLog(result.errors, 800));
    } else {
      console.log('[Monday][api] ← query me (getUserInfo)', { meId: result?.data?.me?.id });
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
    console.log("User Data: ", userData);

    // Normalize the hostname (admin may enter a full URL in the managed-OAuth form)
    // so it is stored as a bare host — required for the license lookup and for the
    // {hostname} URL templates to resolve correctly.
    const cleanHostname = normalizeHostname(hostname);
    console.log('[Monday][getUserInfo] hostname normalized', { rawHostname: hostname, cleanHostname });

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
        console.log("Company: ", company);
        const existingCustomer = await models.customer.findOne({
          where: { companyId: company.id, sysId: String(userData.id) },
          raw: true
        });
        console.log("Existing Customer: ", existingCustomer);

        if (!existingCustomer) {
          const currentSeatCount = await models.customer.count({
            where: { companyId: company.id }
          });
          console.log("Current Seat Count: ", currentSeatCount);

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
          console.log('[Monday][getUserInfo] customer row created', { sysId: userData.id, companyId: company.id });
        }
      } catch (err) {
        console.error('[Monday][getUserInfo] error enforcing customer seat limits:', err);
      }
    }

    // Discover the connector's single board once, at connect time, and store it so the
    // rest of the system reuses it without re-discovering.
    let boardId = null;
    try {
      const boards = await getCrmBoards({ accessToken, userId: null });
      boardId = pickDefaultBoard(boards)?.id || null;
      console.log('[Monday][getUserInfo] selected board', { boardId, discoveredBoardCount: boards.length });
    } catch (e) {
      console.warn('[Monday][getUserInfo] board discovery failed (will retry lazily):', e.message);
    }

    return {
      successful: true,
      platformUserInfo: {
        id: userData.id,
        name: userData.name,
        email: userData.email,
        overridingApiKey: accessToken,
        ...(cleanHostname ? { overridingHostname: cleanHostname } : {}),
        platformAdditionalInfo: { ...(boardId ? { boardId } : {}) }
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

// Discover the CRM boards a connected user can access — any active board that has a
// Phone column. Results are cached briefly per user to avoid repeated board lookups.
async function getCrmBoards({ accessToken, userId }) {
  const now = Date.now();
  const cached = userId ? boardCache.get(userId) : null;
  if (cached && cached.expiry > now) {
    return cached.boards;
  }

  const res = await mondayRequest(
    accessToken,
    `
    query {
      boards(limit: 200, state: active) {
        id
        name
        columns { id title type }
      }
    }
    `
  );

  const rawBoards = res?.data?.boards || [];
  const boards = rawBoards
    .map(board => {
      const columns = board.columns || [];
      const phoneColumn = columns.find(col => col.type === 'phone')
        || columns.find(col => /phone/i.test(col.title || ''));
      return phoneColumn
        ? { id: String(board.id), name: board.name, phoneColumnId: phoneColumn.id }
        : null;
    })
    .filter(Boolean);

  if (userId) {
    boardCache.set(userId, { boards, expiry: now + BOARD_CACHE_TTL_MS });
  }
  return boards;
}

// Pick a sensible default board for creating new contacts: prefer a board named like
// "Contact"/"Lead", otherwise the first discovered CRM board.
function pickDefaultBoard(boards = []) {
  return boards.find(board => /contact/i.test(board.name))
    || boards.find(board => /lead/i.test(board.name))
    || boards[0]
    || null;
}

function getUserId(user) {
  return user?.dataValues?.id || user?.id || null;
}

// The connector uses a single board for everything. It is discovered once (the default
// board with a Phone column), stored on the user record's platformAdditionalInfo, and
// reused everywhere — no per-contact board lookup.
async function getBoardId({ user, accessToken }) {
  const pai = user?.platformAdditionalInfo || user?.dataValues?.platformAdditionalInfo || {};
  if (pai.boardId) {
    return String(pai.boardId);
  }
  // Not stored yet — discover the default board and persist it on the user record.
  const boards = await getCrmBoards({ accessToken, userId: getUserId(user) });
  const board = pickDefaultBoard(boards);
  const boardId = board?.id || null;
  console.log('[Monday][board] discovered board', { boardId, boardName: board?.name, discoveredBoardCount: boards.length });
  if (boardId && typeof user?.update === 'function') {
    try {
      const nextPai = { ...pai, boardId };
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
  }
  return boardId;
}

// Logging always targets the connector's single board (read stored, else discover).
// This does not depend on contactInfo.type surviving the extension round-trip.
async function resolveBoardId({ accessToken, user }) {
  const boardId = await getBoardId({ user, accessToken });
  console.log('[Monday][board] resolveBoardId ->', { boardId });
  return boardId;
}

// The Phone column id for a board, cached via getColumnIdByName.
async function getPhoneColumnId({ accessToken, boardId }) {
  return getColumnIdByName({ accessToken, boardId, columnName: 'Phone' });
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

async function searchBoardByPhone({ accessToken, boardId, phoneColumnId, phone }) {
  // Try formats in priority order (Monday's "+1 623 201 1816" first) and STOP at the
  // first format that matches — best case is a single query. Each request is bounded by
  // the client timeout and try/caught, so a slow/failed format is skipped, not fatal.
  const phoneFallbacks = generatePhoneFormats(phone)
  for (const searchValue of phoneFallbacks) {
    try {
      const res = await mondayRequest(
        accessToken,
        `
        query ($value: String!) {
          items_page_by_column_values(
            board_id: ${boardId},
            columns: [{ column_id: "${phoneColumnId}", column_values: [$value] }]
          ) {
            items { id name }
          }
        }
        `,
        { value: searchValue }
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
  let boardId = null
  try {
    boardId = await getBoardId({ user, accessToken: resolvedAccessToken })
  } catch (e) {
    // A board-resolution failure (e.g. a slow discovery query hitting the request
    // timeout) should not surface as a hard error — tell the user to retry.
    console.warn('[Monday] findContact: board resolution failed', e.message)
    return { successful: false, returnMessage: { messageType: 'warning', message: 'Monday is taking too long to respond. Please try again.', ttl: 3000 } }
  }
  if (!boardId) {
    return { successful: false, returnMessage: { messageType: 'error', message: 'No Monday board with a Phone column was found. Add a Phone column to your board and try again.', ttl: 3000 } }
  }

  const phone = normalizePhone(phoneNumber)
  const matchedContactInfo = []

  if (phone) {
    const phoneColumnId = await getPhoneColumnId({ accessToken: resolvedAccessToken, boardId })
    if (phoneColumnId) {
      const items = await searchBoardByPhone({ accessToken: resolvedAccessToken, boardId, phoneColumnId, phone })
      for (const item of items) {
        // The extension reads `type` off the contact to build the RC entity's
        // contactType (contacts/match.js), which feeds the {contactType} URL variable
        // for both "view call log" and "open contact". Set both names to be safe.
        matchedContactInfo.push({ id: item.id, name: item.name, phone, type: String(boardId), contactType: String(boardId), boardId })
      }
    }

    if (matchedContactInfo.length === 0 && user?.rcAccountId) {
      try {
        const cachePlatform = user?.dataValues?.platform || user?.platform || 'gate6.monday'
        const deleted = await AccountDataModel.destroy({
          where: { rcAccountId: user.rcAccountId, platformName: cachePlatform, dataKey: `contact-${phoneNumber}` }
        })
        if (deleted > 0) console.log('[Monday] findContact: deleted stale cache for phone:', phoneNumber)
      } catch (err) {
        console.warn('[Monday] findContact: failed to delete stale cache:', err.message)
      }
    }
  }

  matchedContactInfo.push({
    id: 'createNewContact',
    name: 'Create new contact...',
    isNewContact: true
  })

  return { successful: true, matchedContactInfo }
}

async function findContactWithName({ name, accessToken, authHeader, user }) {
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
    boardId = await getBoardId({ user, accessToken: resolvedAccessToken })
  } catch (e) {
    console.warn('[Monday] findContactWithName: board resolution failed', e.message)
    return { successful: true, matchedContactInfo: [] }
  }
  if (!boardId) {
    return { successful: true, matchedContactInfo: [] }
  }

  // Inline the search term via JSON.stringify so it is a safely-escaped GraphQL list
  // literal (e.g. ["O'Brien"]). compare_value is Monday's JSON CompareValue scalar.
  const compareValue = JSON.stringify([term])

  let items = []
  try {
    const res = await mondayRequest(
      resolvedAccessToken,
      `
      query ($boardId: [ID!]) {
        boards(ids: $boardId) {
          items_page(
            limit: 25,
            query_params: { rules: [{ column_id: "name", compare_value: ${compareValue}, operator: contains_text }] }
          ) {
            items { id name }
          }
        }
      }
      `,
      { boardId: [boardId] }
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
  const matchedContactInfo = items.map(item => ({ id: item.id, name: item.name, type: String(boardId), contactType: String(boardId), boardId }))
  console.log('[Monday] findContactWithName', { term, matches: matchedContactInfo.length })

  return { successful: true, matchedContactInfo }
}

async function createContact({ phoneNumber, newContactName, accessToken, authHeader, user }) {
  const licenseError = await validateLicenseOrFail(user, 'createContact');
  if (licenseError) return licenseError;

  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  const boardId = await getBoardId({ user, accessToken: resolvedAccessToken })
  const phoneColumnId = boardId ? await getPhoneColumnId({ accessToken: resolvedAccessToken, boardId }) : null
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

  // Monday "phone"-type columns expect a JSON object { phone, countryShortName }; a
  // plain string is rejected. Text columns named "Phone" accept a plain string. Try
  // the structured format first, then fall back to the plain string.
  const parsed = parsePhoneNumber(phoneNumber || '')
  const e164 = parsed?.valid ? parsed.number.e164 : (phoneNumber || '')
  const countryShortName = parsed?.valid ? parsed.regionCode : ''
  const phoneVariants = [
    countryShortName ? { phone: e164, countryShortName } : { phone: e164 },
    e164
  ]

  let created = null
  let lastError = ''
  for (const variant of phoneVariants) {
    const res = await mondayRequest(
      resolvedAccessToken,
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
        name: newContactName,
        values: JSON.stringify({ [phoneColumnId]: variant })
      }
    )
    if (!res?.errors?.length && res?.data?.create_item?.id) {
      created = res.data.create_item
      break
    }
    lastError = res?.errors?.[0]?.message || 'unknown error'
    console.warn('[Monday][createContact] create_item attempt failed; trying next phone format', { boardId, variant, error: lastError })
  }

  if (!created) {
    return {
      contactInfo: null,
      returnMessage: {
        messageType: 'error',
        message: `Failed to create contact in Monday: ${lastError}`,
        ttl: 3000
      }
    }
  }

  console.log('[Monday][createContact] created item', { itemId: created.id, boardId })

  await trackAnalytics({ user, crm: 'Monday', event: 'contactCreated' });

  return {
    contactInfo: {
      id: created.id,
      name: created.name,
      // `type` feeds the RC entity contactType so logging/URLs target the right board.
      type: String(boardId),
      contactType: String(boardId),
      boardId
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

async function createCallLog({ contactInfo, callLog, note, aiNote, transcript, accessToken, authHeader, user }) {
  const licenseError = await validateLicenseOrFail(user, 'createCallLog');
  if (licenseError) return licenseError;

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  // Log directly against the contact passed in — like ServiceTitan/ServiceNow — instead of
  // re-querying Monday for the board. create_update only needs the item id (contactInfo.id),
  // so no board lookup ("search") is needed on the main path. The board id is carried on the
  // contact (smuggled via `type`); it's only needed for an optional recording upload, which
  // resolves it lazily below. This keeps logging working even if board discovery is slow/down.
  const boardId = String(contactInfo?.boardId || contactInfo?.type || '') || null;
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
    sections.push(`AI Note:<br>${aiNote.replace(/\r?\n/g, '<br>')}`)
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
    footerLines.push(`Start Time: ${moment(callLog.startTime).format("YYYY-MM-DD HH:mm:ss")}`);
    if (callLog.duration) {
      footerLines.push(`End Time: ${moment(callLog.startTime).add(callLog.duration, "seconds").format("YYYY-MM-DD HH:mm:ss")}`);
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
      itemId: Number(contactInfo.id),
      body
    }
  )
  assertNoGraphqlErrors(res, `createCallLog (create_update itemId=${contactInfo.id})`)

  const updateId = res?.data?.create_update?.id
  if (!updateId) {
    throw new Error(`Monday createCallLog: create_update returned no id for itemId=${contactInfo.id}`)
  }
  console.log('[Monday][createCallLog] created update', { updateId, itemId: Number(contactInfo.id), boardId })

  // ---- Recording Upload ----
  // Only here is the board id actually needed. Use the one carried on the contact; resolve
  // it lazily (one query) only if it wasn't provided, so the call log itself never blocks on
  // board discovery.
  if (callLog?.recording?.downloadUrl) {
    const uploadBoardId = boardId || await resolveBoardId({ accessToken: resolvedAccessToken, user })
    const fileName = `Call-${Date.now()}.mp3`
    const s3Key = fileName
    const s3Url = await downloadAudioFile(
      callLog.recording.downloadUrl,
      process.env.S3_BUCKET,
      s3Key
    )

    await uploadToMonday({
      s3Url,
      accessToken: resolvedAccessToken,
      itemId: Number(contactInfo.id),
      fileName,
      boardId: uploadBoardId
    })
  }

  await trackAnalytics({ user, crm: 'Monday', event: 'callLogCreated', eventDate: callLog?.startTime });

  return {
    logId: updateId,
    contactId: Number(contactInfo.id),
    returnMessage: {
      message: "Call log created",
      messageType: "success",
      ttl: 2000
    }
  }
}

async function updateCallLog({ existingCallLog, recordingLink, note, aiNote, transcript, accessToken, authHeader, user, subject, duration, startTime, result }) {
  const licenseError = await validateLicenseOrFail(user, 'updateCallLog');
  if (licenseError) return licenseError;

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  const logId = existingCallLog?.thirdPartyLogId
  const itemId = Number(existingCallLog?.contactId)
  console.log('[Monday][updateCallLog] start', {
    thirdPartyLogId: logId,
    contactId: existingCallLog?.contactId,
    isNumericId: isNumericMondayId(logId)
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
        { updateId: [logId] }
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
    sections.push(`AI Note:<br>${effectiveAiNote.replace(/\r?\n/g, '<br>')}`)
  }
  if (effectiveTranscript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
    sections.push(`Transcript:<br>${effectiveTranscript.replace(/\r?\n/g, '<br>')}`)
  }

  let startTimeToUse = parsed.startTime
  let endTimeToUse = parsed.endTime

  if (startTime) {
    startTimeToUse = moment(startTime).format("YYYY-MM-DD HH:mm:ss")
    if (duration) {
      endTimeToUse = moment(startTime).add(duration, "seconds").format("YYYY-MM-DD HH:mm:ss")
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
        { updateId: logId, body }
      )
      if (!updateRes?.errors?.length && updateRes?.data?.edit_update?.id) {
        await trackAnalytics({ user, crm: 'Monday', event: 'callLogUpdated', eventDate: startTime });
        return {
          logId: updateRes.data.edit_update.id,
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
    { itemId, body }
  )
  assertNoGraphqlErrors(createRes, 'updateCallLog (create_update fallback)')
  const newLogId = createRes?.data?.create_update?.id
  if (!newLogId) {
    throw new Error('Monday updateCallLog: fallback create_update returned no id')
  }
  console.log('[Monday][updateCallLog] recreated update', { oldLogId: logId, newLogId, itemId })
  // Repoint the stored id so the next update edits this new update instead of recreating.
  try {
    if (typeof existingCallLog?.update === 'function') {
      await existingCallLog.update({ thirdPartyLogId: newLogId })
    }
  } catch (e) {
    console.warn('[Monday][updateCallLog] failed to repoint thirdPartyLogId', { newLogId, message: e.message })
  }

  await trackAnalytics({ user, crm: 'Monday', event: 'callLogUpdated', eventDate: startTime });

  return {
    logId: newLogId,
    returnMessage: { message: "Call log updated", messageType: "success", ttl: 2000 }
  }
}

async function getCallLog({ callLogId, accessToken, authHeader, user }) {
  const licenseError = await validateLicenseOrFail(user, 'getCallLog');
  if (licenseError) return licenseError;

  // A non-numeric stored id (e.g. a stale hash) is not a valid Monday update id and
  // makes the API 500 — skip the doomed query and report "not found" cleanly so the
  // caller (updateCallLog) recreates the update instead.
  if (!isNumericMondayId(callLogId)) {
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
    { updateId: [callLogId] }
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

async function createMessageLog({ user, contactInfo, message, recordingLink, faxDocLink, accessToken }) {
  const licenseError = await validateLicenseOrFail(user, 'createMessageLog');
  if (licenseError) return licenseError;

  const resolvedAccessToken = accessToken || user?.accessToken
  const boardId = await resolveBoardId({ accessToken: resolvedAccessToken, user });
  const itemId = Number(contactInfo.id)
  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  })
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
    body += `[${moment(message.creationTime || Date.now()).format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}<br>`

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
    }
  )

  if (!res?.data?.create_update?.id) {
    throw new Error('Failed to create message log')
  }

  const updateId = res.data.create_update.id

  if (callLogsColumnId) {
    await mondayRequest(
      resolvedAccessToken,
      `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(
          board_id: $boardId,
          item_id: $itemId,
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
      `,
      {
        boardId,
        itemId,
        columnId: callLogsColumnId,
        value: body
      }
    )
  }

  if (recordingLink || faxDocLink) {
    const downloadUrl = recordingLink || faxDocLink
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

    await uploadToMonday({
      s3Url,
      accessToken: resolvedAccessToken,
      itemId,
      fileName,
      boardId
    })
  }

  await trackAnalytics({ user, crm: 'Monday', event: 'messageLogCreated', eventDate: message?.creationTime });

  return {
    logId: updateId,
    contactId: itemId,
    returnMessage: {
      message: 'Message thread created',
      messageType: 'success',
      ttl: 1000
    }
  }
}

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, recordingLink, faxDocLink, accessToken }) {
  const licenseError = await validateLicenseOrFail(user, 'updateMessageLog');
  if (licenseError) return licenseError;

  const MAX_THREAD_MESSAGES = 10
  const resolvedAccessToken = accessToken || user?.accessToken
  const boardId = await resolveBoardId({ accessToken: resolvedAccessToken, user });
  const itemId = Number(contactInfo.id)
  const updateId = existingMessageLog.thirdPartyLogId
  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  })
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
      }
    )

    const newUpdateId = res.data.create_update.id

    await trackAnalytics({ user, crm: 'Monday', event: 'messageLogUpdated', eventDate: message?.creationTime });

    return {
      logId: newUpdateId,
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
    { updateId: [updateId] }
  )

  const previousBody =
    existing?.data?.updates?.[0]?.body || ''
  const sender =
    message.direction === 'Inbound'
      ? contactInfo.name
      : 'You'
  const text = message.subject || message.text || ''
  const newLine =
    `<br>[${moment(message.creationTime || Date.now()).format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}<br>`
  const messageLines =
    previousBody
      .split('<br>')
      .filter(l => l.includes(':'))
  const messageCount = messageLines.length
  let updatedBody
  let response
  let newThreadId = updateId

  if (messageCount >= MAX_THREAD_MESSAGES) {
    updatedBody =
      `SMS conversation with ${contactInfo.name}<br>` +
      `[${moment(message.creationTime || Date.now()).format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}<br>`
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
      }
    )

    newThreadId = response.data.create_update.id

  } else {
    updatedBody = previousBody + newLine
    response = await mondayRequest(
      resolvedAccessToken,
      `
      mutation ($updateId: ID!, $body: String!) {
        edit_update(id: $updateId, body: $body) {
          id
        }
      }
      `,
      {
        updateId,
        body: updatedBody
      }
    )
  }

  if (callLogsColumnId) {
    await mondayRequest(
      resolvedAccessToken,
      `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(
          board_id: $boardId,
          item_id: $itemId,
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
      `,
      {
        boardId,
        itemId,
        columnId: callLogsColumnId,
        value: updatedBody
      }
    )
  }

  if (recordingLink || faxDocLink) {
    const downloadUrl = recordingLink || faxDocLink
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

    await uploadToMonday({
      s3Url,
      accessToken: resolvedAccessToken,
      itemId,
      fileName,
      boardId
    })
  }

  await trackAnalytics({ user, crm: 'Monday', event: 'messageLogUpdated', eventDate: message?.creationTime });

  return {
    logId: newThreadId,
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
  const urlObj = new URL(url);
  const accessToken = urlObj.searchParams.get("accessToken");
  const s3Values = {
    accessKeyId: process.env.MEDIA_UPLOAD_KEY_ID,
    secretAccessKey: process.env.MEDIA_UPLOAD_SECRET_KEY,
    region: process.env.AWS_REGION
  };
  const s3 = new AWS.S3(s3Values);
  console.log("Downloading Audio File...");

  try {
    const response = await mondayApiClient.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      responseType: "stream",
    });
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
      boardId
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
      contentType: 'audio/mpeg'
    })

    const response = await mondayApiClient.post(
      `${MONDAY_API_URL}/file`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity
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