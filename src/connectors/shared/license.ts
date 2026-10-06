// @ts-nocheck
// Shared license + seat-enforcement logic for all Gate6 connectors.
//
// Licensing model (companies table, provisioned per RC tenant):
//   - One `companies` row per `rcAccountId` (the RC tenant). `status === true` = active.
//   - `maxAllowedUsers` = purchased seats. A "seat" is held by an actively-connected
//     user (non-empty `accessToken`); disconnect (unAuthorize blanks the token) frees it.
//     Seats are allocated first-come, ordered by `createdAt`.
//
// Every connector delegates getLicenseStatus / validateLicenseOrFail here so the model
// is consistent and lives in one place.

const { Op } = require('sequelize');
const { UserModel } = require('@app-connect/core/models/userModel');

// Short-lived per-user cache — the license check runs on every connector operation.
const licenseCache = new Map(); // userId -> { status, expiry }
const LICENSE_CACHE_TTL_MS = 60 * 1000;

async function computeLicenseStatus({ models, userId }) {
  if (!models) {
    return { isLicenseValid: false, licenseStatus: 'DB not configured', licenseStatusDescription: '' };
  }
  const user = await UserModel.findByPk(userId);
  if (!user) {
    return { isLicenseValid: false, licenseStatus: 'User Not Found', licenseStatusDescription: '' };
  }

  // Resolve the company row, most-specific match first, degrading gracefully so we
  // stay backward compatible with customers provisioned before rcAccountId was captured:
  //   1. rcAccountId + hostname — disambiguates accounts that have a row per connector
  //   2. rcAccountId only       — fixed-hostname connectors / rows without a hostname
  //   3. hostname only          — legacy rows that predate rcAccountId
  let company = null;
  if (user.rcAccountId && user.hostname) {
    company = await models.companies.findOne({ where: { rcAccountId: user.rcAccountId, hostname: user.hostname }, raw: true });
  }
  if (!company && user.rcAccountId) {
    company = await models.companies.findOne({ where: { rcAccountId: user.rcAccountId }, raw: true });
  }
  if (!company && user.hostname) {
    company = await models.companies.findOne({ where: { hostname: user.hostname }, raw: true });
  }
  if (!company || company.status !== true) {
    return { isLicenseValid: false, licenseStatus: 'Inactive', licenseStatusDescription: 'Purchase license to continue' };
  }

  // Seat enforcement only when we have an rcAccountId to count seats per tenant. Legacy
  // accounts (no rcAccountId) keep the prior status-only behaviour — no seat caps.
  const maxSeats = Number(company.maxAllowedUsers);
  if (user.rcAccountId && Number.isFinite(maxSeats) && maxSeats > 0) {
    const activeCustomers = await models.customer.findAll({
        where: { companyId: company.id },
        order: [['createdAt', 'ASC']],
        attributes: ['sysId'],
        raw: true
    });
    
    const seatIndex = activeCustomers.findIndex(c => c.sysId === userId);
    const overLimit = seatIndex === -1
        ? activeCustomers.length >= maxSeats
        : seatIndex >= maxSeats;
        
    if (overLimit) {
        console.warn('[license] seat limit reached', {
            userId, platform: user.platform, rcAccountId: user.rcAccountId,
            usedSeats: activeCustomers.length, maxSeats, seatIndex
        });
        return {
            isLicenseValid: false,
            licenseStatus: 'Inactive',
            licenseStatusDescription: `License seat limit reached (${maxSeats} of ${maxSeats} in use). Contact your admin.`
        };
    }
  }

  return { isLicenseValid: true, licenseStatus: 'Active', licenseStatusDescription: 'Basic' };
}

// Cached license status. `models` is the connector's sequelize models (with `companies`).
async function getLicenseStatus({ models, userId }) {
  try {
    const now = Date.now();
    const cached = userId != null ? licenseCache.get(userId) : null;
    if (cached && cached.expiry > now) {
      return cached.status;
    }
    const status = await computeLicenseStatus({ models, userId });
    if (userId != null) {
      licenseCache.set(userId, { status, expiry: now + LICENSE_CACHE_TTL_MS });
    }
    return status;
  } catch (error) {
    console.error('[license] getLicenseStatus error:', error);
    return { isLicenseValid: false, licenseStatus: 'Error', licenseStatusDescription: 'Error validating license' };
  }
}

// Standard license gate used at the top of connector operations.
// Returns null when valid, or a { successful:false, returnMessage } object when not.
async function validateLicenseOrFail({ models, user }) {
  const userId = user?.dataValues?.id ?? user?.id;
  const licenseStatus = await getLicenseStatus({ models, userId });
  if (!licenseStatus.isLicenseValid) {
    return {
      successful: false,
      returnMessage: {
        message: 'License validation failed',
        messageType: 'error',
        details: [
          {
            title: 'License Issue',
            items: [
              {
                id: '1',
                type: 'text',
                text: licenseStatus.licenseStatusDescription || 'Please go to user settings page and refresh license status'
              }
            ]
          }
        ],
        ttl: 5000
      }
    };
  }
  return null;
}

// Clear a user's cached status (e.g. after disconnect) so the next check is fresh.
function clearLicenseCache(userId) {
  if (userId != null) licenseCache.delete(userId);
}

// ---------------------------------------------------------------------------------------------
// Plan tier (premium / basic) — opt-in. Nothing above reads it, so getLicenseStatus and
// validateLicenseOrFail behave exactly as before for every connector. A connector that has
// premium-only features calls isPremium() for them (today: Monday project boards only).
// ---------------------------------------------------------------------------------------------
const TIER_BASIC = 'basic';
const TIER_PREMIUM = 'premium';
const tierCache = new Map(); // userId -> { tier, expiry }
// Kept short so an admin's basic <-> premium change reaches the server within seconds; a read is
// one small query, and the cache still spares the several checks a single log operation makes.
const TIER_CACHE_TTL_MS = 10 * 1000;
// A tier that could not be read on a passing DB hiccup is kept only briefly, so a premium company
// is not pinned to basic for a whole cache period.
const TIER_ERROR_CACHE_TTL_MS = 5 * 1000;
// A database without the column is re-checked this often, so running
// the crmconnect-admin migration (npm run migrate there) takes effect without a server restart.
const MISSING_COLUMN_RECHECK_MS = 5 * 60 * 1000;
let licenseTierColumnMissingUntil = 0;

// Same company resolution as computeLicenseStatus: rcAccountId + hostname, then rcAccountId,
// then hostname.
async function findCompanyForUser({ models, userId }) {
  const user = await UserModel.findByPk(userId);
  if (!user) return null;
  let company = null;
  if (user.rcAccountId && user.hostname) {
    company = await models.companies.findOne({ where: { rcAccountId: user.rcAccountId, hostname: user.hostname }, raw: true });
  }
  if (!company && user.rcAccountId) {
    company = await models.companies.findOne({ where: { rcAccountId: user.rcAccountId }, raw: true });
  }
  if (!company && user.hostname) {
    company = await models.companies.findOne({ where: { hostname: user.hostname }, raw: true });
  }
  return company;
}

// `companies.licenseTier` is read with its own query rather than through the model, so a database
// that has not had the column added yet reads every company as basic instead of failing.
async function readLicenseTier({ models, companyId }) {
  if (!models?.companies?.sequelize || Date.now() < licenseTierColumnMissingUntil) {
    return { tier: TIER_BASIC, transientError: false };
  }
  try {
    const [rows] = await models.companies.sequelize.query(
      'SELECT "licenseTier" FROM companies WHERE id = :companyId',
      { replacements: { companyId } }
    );
    const tier = String(rows?.[0]?.licenseTier ?? '').trim().toLowerCase() === TIER_PREMIUM ? TIER_PREMIUM : TIER_BASIC;
    return { tier, transientError: false };
  } catch (error) {
    // 42703 = undefined_column (Postgres): the migration has not run on this database.
    if (error?.parent?.code === '42703' || error?.original?.code === '42703') {
      licenseTierColumnMissingUntil = Date.now() + MISSING_COLUMN_RECHECK_MS;
      console.warn('[license] companies.licenseTier column not found — treating every company as basic until it is added (run npm run migrate in crmconnect-admin).');
      return { tier: TIER_BASIC, transientError: false };
    }
    console.error('[license] could not read licenseTier — treating as basic for now:', error.message);
    return { tier: TIER_BASIC, transientError: true };
  }
}

// Whether the user's company is on the premium plan. Requires a valid license first (an inactive
// or over-seat company is never premium), then reads the company's tier; cached per user.
async function isPremium({ models, user }) {
  const userId = user?.dataValues?.id ?? user?.id;
  if (userId == null || !models) return false;
  const licenseStatus = await getLicenseStatus({ models, userId });
  if (!licenseStatus.isLicenseValid) return false;

  const now = Date.now();
  const cached = tierCache.get(userId);
  if (cached && cached.expiry > now) return cached.tier === TIER_PREMIUM;

  try {
    const company = await findCompanyForUser({ models, userId });
    const { tier, transientError } = company
      ? await readLicenseTier({ models, companyId: company.id })
      : { tier: TIER_BASIC, transientError: false };
    tierCache.set(userId, { tier, expiry: now + (transientError ? TIER_ERROR_CACHE_TTL_MS : TIER_CACHE_TTL_MS) });
    return tier === TIER_PREMIUM;
  } catch (error) {
    console.error('[license] isPremium error — treating as basic:', error.message);
    return false;
  }
}

exports.getLicenseStatus = getLicenseStatus;
exports.validateLicenseOrFail = validateLicenseOrFail;
exports.clearLicenseCache = clearLicenseCache;
exports.isPremium = isPremium;

export {};
