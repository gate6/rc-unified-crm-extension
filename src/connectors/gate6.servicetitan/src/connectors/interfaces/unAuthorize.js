async function unAuthorize({ user }) {
    user.accessToken = '';
    user.refreshToken = '';
    await user.save();
    return {
        returnMessage: {
            messageType: 'success',
            message: 'Logged out of Service Titan',
            ttl: 1000
        }
    }
}

module.exports = unAuthorize;