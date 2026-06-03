const { getMondayOAuthConfig } = require('../utils/mondayHelpers');

function getOverridingOAuthOption({ code }) {
  const { clientId, clientSecret, redirectUri } = getMondayOAuthConfig()

  return {
    query: {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code: code,
    },
    headers: {
      Authorization: ''
    }
  }
}

module.exports = getOverridingOAuthOption;
