const axios = require('axios');
const { getHostname } = require('../utils/servicenowHelpers');

// Used to update existing message log so to group message in the same day together
async function updateMessageLog({ user, contactInfo, existingMessageLog, message, authHeader, contactNumber }) {
    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;
    
    const existingLogId = existingMessageLog.thirdPartyLogId;
    const getLogRes = await axios.get(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        {
            headers: { 'Authorization': authHeader }
        });
    const originalNote = getLogRes.data.body;
    const updateNote = originalNote.replace();

    const patchBody = {
        data: {
            body: updateNote,
        }
    };
    const updateLogRes = await axios.patch(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        patchBody,
        {
            headers: { 'Authorization': authHeader }
        });
}

module.exports = updateMessageLog;