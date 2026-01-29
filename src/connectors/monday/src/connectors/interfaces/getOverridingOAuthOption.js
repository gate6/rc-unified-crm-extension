const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);

function getOverridingOAuthOption({ code }) {
  return {
    query: {
      grant_type: 'authorization_code',
      client_id: MONDAY_CLIENT_ID,
      client_secret: MONDAY_CLIENT_SECRET,
      redirect_uri: MONDAY_REDIRECT_URI,
      code: code,
    },
    headers: {
      Authorization: ''
    }
  }
}

module.exports = getOverridingOAuthOption;
