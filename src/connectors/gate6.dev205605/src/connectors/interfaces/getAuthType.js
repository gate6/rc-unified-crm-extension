function getAuthType() {
    return 'oauth'; // Return either 'oauth' OR 'apiKey'
}

module.exports = getAuthType;