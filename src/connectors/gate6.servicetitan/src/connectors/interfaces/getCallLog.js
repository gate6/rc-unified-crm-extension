const axios = require('axios');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { getRefreshedAuthToken } = require('../utils/serviceTitanHelpers');

async function getCallLog({ user, callLogId, authHeader }) {
    const [realId, logType = 'note'] = callLogId.split('_');

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    let subject = '';
    let note = '';
    let full_data = {};

    try {
        if (logType === 'job') {
            const jobRes = await axios.get(
                `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${realId}`,
                {
                    headers: { 'Authorization': `Bearer ${auth}`, 'ST-App-Key': stAppKey },
                }
            );

            const jobData = jobRes.data;
            if (jobData) {
                const summary = jobData.summary || '';

                const subjectMarker = '<b>Subject</b><br>';
                const subjectIndex = summary.indexOf(subjectMarker);
                const agentNotesMarker = '<b>Agent Notes</b><br>';
                const notesIndex = summary.indexOf(agentNotesMarker);
                if (subjectIndex !== -1) {
                    const subjectSection = summary.substring(subjectIndex + subjectMarker.length);
                    const subjectSectionIndex = subjectSection.indexOf('\n\n<b>');
                    subject = (subjectSectionIndex !== -1 ? subjectSection.substring(0, subjectSectionIndex) : subjectSection).trim();
                }
                if (notesIndex !== -1) {
                    const notesSection = summary.substring(notesIndex + agentNotesMarker.length);
                    const nextSectionIndex = notesSection.indexOf('\n\n<b>');
                    note = (nextSectionIndex !== -1 ? notesSection.substring(0, nextSectionIndex) : notesSection).trim();
                }

                full_data = { subject, description: summary };
            }
        } else {
            const existingCallLogDetails = await CallLogModel.findOne({
                where: { thirdPartyLogId: callLogId },
            });

            if (!existingCallLogDetails) {
                console.error(`Could not find call log with thirdPartyLogId: ${callLogId}`);
                return { callLogInfo: { subject: '', note: '', fullLogResponse: {} } };
            }

            const { contactId } = existingCallLogDetails.dataValues;
            const getLogRes = await axios.get(
                `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
                {
                    headers: { 'Authorization': `Bearer ${auth}`, 'ST-App-Key': stAppKey },
                }
            );

            const logData = getLogRes.data;
            if (Array.isArray(logData.data)) {
                const targetLog = logData.data.find(log => log.id == realId);
                if (targetLog) {
                    try {
                        let parsedText = targetLog.text;
                        try { parsedText = JSON.parse(targetLog.text); } catch {}
                        subject = parsedText.subject || '';
                        const description = parsedText.description || '';

                        const agentNotesMarker = '<b>Agent Notes</b><br>';
                        const notesIndex = description.indexOf(agentNotesMarker);

                        if (notesIndex !== -1) {
                            const notesSection = description.substring(notesIndex + agentNotesMarker.length);
                            const nextSectionIndex = notesSection.indexOf('\n\n<b>');
                            note = (nextSectionIndex !== -1 ? notesSection.substring(0, nextSectionIndex) : notesSection).trim();
                        } else {
                            note = description;
                        }

                        full_data = parsedText;
                    } catch (err) {
                        console.error('Error parsing note text:', err);
                        note = targetLog.text;
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Failed to get call log for ${callLogId}:`, error?.response?.data || error.message);
    }

    return {
        callLogInfo: {
            subject,
            fullLogResponse: full_data,
            note,
        },
    };
}

module.exports = getCallLog;
