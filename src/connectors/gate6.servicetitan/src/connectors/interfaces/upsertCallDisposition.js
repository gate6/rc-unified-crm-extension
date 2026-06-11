async function upsertCallDisposition({ user, existingCallLog, authHeader, dispositions }) {
    return {
        returnMessage: {
            message: 'Call log note updated with disposition',
            messageType: 'success',
            ttl: 2000
        }
    };
}

module.exports = upsertCallDisposition;
