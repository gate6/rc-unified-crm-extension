/**
 * Reset connector test data so you can re-test connectors from a clean slate.
 *
 * Clears (per the platforms below):
 *   - Managed OAuth credentials      (AccountData dataKey 'managed-oauth-account')
 *   - Managed auth org/user values   (AccountData 'managed-auth-org' / 'managed-auth-user:*')
 *   - Managed-auth login-failure flags
 *   - Cached matched contacts        (AccountData 'contact-*')
 *   - Connected user records         (UserModel)
 *   - Pending managed OAuth cache    (CacheModel)
 *
 * It does NOT touch the `companies` (license) table.
 *
 * SAFETY: scope to a single RC account with RESET_RC_ACCOUNT_ID. Only pass
 * RESET_ALL_ACCOUNTS=true if you are CERTAIN this DB has no production data
 * (it would delete connected users for ALL accounts — including real ServiceNow users).
 *
 * Usage:
 *   RESET_RC_ACCOUNT_ID=765770035 node scripts/reset-connector-data.js
 *   RESET_ALL_ACCOUNTS=true       node scripts/reset-connector-data.js     # dangerous
 */
require('dotenv').config();
const { Op } = require('sequelize');
const { AccountDataModel } = require('../packages/core/models/accountDataModel');
const { UserModel } = require('../packages/core/models/userModel');
const { CacheModel } = require('../packages/core/models/cacheModel');

// Both the bare and gate6-prefixed platform keys.
const PLATFORMS = [
  'monday', 'gate6.monday',
  'servicetitan', 'gate6.servicetitan',
  'agencyzoom', 'gate6.agencyzoom',
  'servicenow', 'gate6.servicenow',
];

(async () => {
  const rcAccountId = process.env.RESET_RC_ACCOUNT_ID;
  const allAccounts = process.env.RESET_ALL_ACCOUNTS === 'true';

  if (!rcAccountId && !allAccounts) {
    console.error('Refusing to run. Set RESET_RC_ACCOUNT_ID=<id> to scope to one account,');
    console.error('or RESET_ALL_ACCOUNTS=true to wipe all accounts (DANGEROUS — production-unsafe).');
    process.exit(1);
  }

  const scope = rcAccountId ? { rcAccountId } : {};
  console.log(allAccounts
    ? 'Resetting connector data for ALL accounts'
    : `Resetting connector data for rcAccountId=${rcAccountId}`);

  // 1. AccountData: managed oauth/auth values, login-failure flags, contact cache.
  const accountData = await AccountDataModel.destroy({
    where: { ...scope, platformName: { [Op.in]: PLATFORMS } },
  });
  console.log('  AccountData rows deleted:', accountData);

  // 2. Connected user records.
  const users = await UserModel.destroy({
    where: { ...scope, platform: { [Op.in]: PLATFORMS } },
  });
  console.log('  User rows deleted:', users);

  // 3. Pending managed OAuth cache (id is `${rcAccountId}-managed-oauth-account`).
  const cacheWhere = rcAccountId
    ? { id: `${rcAccountId}-managed-oauth-account` }
    : { cacheKey: 'managed-oauth-account' };
  const cache = await CacheModel.destroy({ where: cacheWhere });
  console.log('  Pending OAuth cache rows deleted:', cache);

  console.log('Done. Now disconnect/reconnect in the extension so it drops its stored JWT.');
  process.exit(0);
})().catch((e) => {
  console.error('Reset failed:', e.message);
  process.exit(1);
});
