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
    const activeUsers = await UserModel.findAll({
      where: {
        rcAccountId: user.rcAccountId,
        platform: user.platform,
        accessToken: { [Op.ne]: '' }
      },
      order: [['createdAt', 'ASC']],
      attributes: ['id'],
      raw: true
    });
    const seatIndex = activeUsers.findIndex(u => u.id === userId);
    // Two cases:
    //   - Already an active seat-holder (seatIndex >= 0): must sit within the first
    //     `maxSeats` by createdAt, otherwise they're beyond the purchased allotment.
    //   - Not yet counted (seatIndex === -1): a user connecting for the first time (their
    //     accessToken isn't persisted at check time). Allow them to claim a seat as long
    //     as there's room — they become seat #activeUsers.length. Deny only when full.
    const overLimit = seatIndex === -1
      ? activeUsers.length >= maxSeats
      : seatIndex >= maxSeats;
    if (overLimit) {
      console.warn('[license] seat limit reached', {
        userId, platform: user.platform, rcAccountId: user.rcAccountId,
        usedSeats: activeUsers.length, maxSeats, seatIndex
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

exports.getLicenseStatus = getLicenseStatus;
exports.validateLicenseOrFail = validateLicenseOrFail;
exports.clearLicenseCache = clearLicenseCache;
