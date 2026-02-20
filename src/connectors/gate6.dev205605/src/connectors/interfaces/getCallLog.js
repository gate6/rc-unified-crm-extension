const axios = require('axios');
const { getHostname } = require('../utils/servicenowHelpers');

async function getCallLog({ user, callLogId, authHeader }) {
    const userInfo = await getHostname(user.dataValues.hostname);
    const hostname = userInfo.hostname;

    const getLogRes = await axios.get(
        `https://${hostname}/api/now/table/interaction/${callLogId}`,
        { headers: { 'Authorization': authHeader } }
    );

    return {
        callLogInfo: {
            subject: getLogRes.data.result.short_description,
            note: getLogRes.data.result.work_notes,
        },
        returnMessage: {
            message: 'Call log fetched.',
            messageType: 'success',
            ttl: 3000
        }
    }
}

module.exports = getCallLog;