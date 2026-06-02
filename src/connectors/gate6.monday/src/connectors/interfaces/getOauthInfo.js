const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const { MONDAY_AUTHORIZE_URL, setMondayOAuthConfig } = require('../utils/mondayHelpers');
const models = initModels(sequelize);

async function getOauthInfo({ hostname, rcAccountId }) {
  const where = { hostname, status: true }
  if (rcAccountId) {
    where.rcAccountId = rcAccountId
  }
  const company = await models.companies.findOne({
    where
  })

  if (!company) {
    throw new Error('Company not found or inactive')
  }
  setMondayOAuthConfig({
    clientId: company.clientId,
    clientSecret: company.clientSecret,
    redirectUri: company.crmRedirectUrl
  })
  return {
    clientId: company.clientId,
    clientSecret: company.clientSecret,
    authorizationUri: MONDAY_AUTHORIZE_URL,
    accessTokenUri: company.tokenUrl,
    redirectUri: company.crmRedirectUrl,
    scopes: ['me:read', 'users:read', 'boards:read', 'boards:write', 'updates:write'],
  }
}

module.exports = getOauthInfo;