async function unAuthorize({ user }) {
  user.accessToken = '';
  await user.save();

  return {
    returnMessage: {
      messageType: 'success',
      message: 'Logged out of AgencyZoom',
      ttl: 1000
    }
  };
}

module.exports = unAuthorize;
