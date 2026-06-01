const axios = require('axios');
const { getHostname, validateLicenseOrFail } = require('../utils/servicenowHelpers');

async function getCallLog({ user, callLogId, authHeader }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const hostname = userInfo.hostname;

    const getLogRes = await axios.get(
        `https://${hostname}/api/now/table/interaction/${callLogId}`,
        { headers: { 'Authorization': authHeader } }
    );

    const journalRes = await axios.get(
        `https://${hostname}/api/now/table/sys_journal_field?sysparm_query=element_id=${callLogId}^element=work_notes&sysparm_fields=value,sys_created_on`,
        { headers: { Authorization: authHeader } }
    );

    const latestNote = journalRes.data.result
        .sort((a, b) => new Date(b.sys_created_on) - new Date(a.sys_created_on))[0]?.value || '';
    const agentNoteMatch = latestNote.match(/- Agent note:\s*(.*)/i);
    const agentNote = agentNoteMatch ? agentNoteMatch[1].trim() : '';

    return {
        callLogInfo: {
            subject: getLogRes.data.result.short_description,
            note: agentNote,
        },
        returnMessage: {
            message: 'Call log fetched.',
            messageType: 'success',
            ttl: 3000
        }
    }
}

module.exports = getCallLog;
