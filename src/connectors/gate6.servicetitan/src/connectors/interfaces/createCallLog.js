const axios = require('axios');
const moment = require('moment');
const { getRefreshedAuthToken, stripHtml, fetchJobs, upsertCallRecording } = require('../utils/serviceTitanHelpers');

async function createCallLog({ user, contactInfo, callLog, note, additionalSubmission, aiNote, transcript, composedLogDetails, hashedAccountId }) {

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const jobs = await fetchJobs({ user, params: { customerId: contactInfo.id } });

    const subject = callLog.customSubject
        ?? `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name}`;

    let description = composedLogDetails;
    console.log("description", description)

    description = stripHtml(description)

    if (note) description += `Agent Notes ${note}\n`;
    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true))
        description += `AI Note ${aiNote}\n`;
    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true))
        description += `\nTranscript ${transcript}\n`;
    if (!!callLog.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) { description = upsertCallRecording({ body: description, recordingLink: callLog.recording.link }); }

    const contactId = contactInfo.id;

    const logTime = (callLog?.startTime && callLog?.duration) ? `start time: ${moment(callLog.startTime).utc().toISOString()} \nend time: ${moment(callLog.startTime).utc().add(callLog.duration, 'seconds').toISOString()}` : ''

    const noteBody = {
        text: `${subject}\n\n` + `${description}\n\n` + logTime
    }

    let addNoteRes;
    let logType = 'note';

    if (!jobs || jobs.length === 0) {

        addNoteRes = await axios.post(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
            noteBody,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );
    }

    else {
        const latestJob = jobs.reduce((max, job) =>
            job.id > max.id ? job : max
        );

        const updateBody = {
            summary: description
        };

        addNoteRes = await axios.patch(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${latestJob.id}`,
            updateBody,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );
        logType = 'job';
    }

    return {
        logId: `${addNoteRes.data.id}_${logType}`,
        returnMessage: {
            message: 'Call log handled',
            messageType: 'success',
            ttl: 2000
        },
        extraDataTracking: {
            withSmartNoteLog: !!aiNote,
            withTranscript: !!transcript
        }
    };
}

module.exports = createCallLog;
