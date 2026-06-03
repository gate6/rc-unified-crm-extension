const axios = require('axios');
const moment = require('moment');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { getRefreshedAuthToken, stripHtml, upsertCallRecording, validateLicenseOrFail } = require('../utils/serviceTitanHelpers');

async function updateCallLog({ user, existingCallLog, authHeader, recordingLink, subject, note, startTime, duration, result, aiNote, transcript, additionalSubmission, composedLogDetails, existingCallLogDetails, hashedAccountId }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    let description = composedLogDetails;
    console.log("update description", description)
    console.log("existingCallLog", existingCallLog)
    console.log("existingCallLogDetails", existingCallLogDetails)

    description = stripHtml(description)

    if (note) description += `Agent Notes ${note}\n`;
    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true))
        description += `AI Note ${aiNote}\n`;
    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true))
        description += `\nTranscript ${transcript}\n`;
     if (!!recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) { description = upsertCallRecording({ body: description, recordingLink: decodeURIComponent(recordingLink) }); }

    const contactId = existingCallLog.contactId;

    let [realId, logType] = existingCallLog.thirdPartyLogId.split('_');
    logType = logType || 'note';

    let newLogId;

    if (logType === 'note') {

        const logTime = (startTime && duration) ? `start time: ${moment(startTime).utc().toISOString()} \nend time: ${moment(startTime).utc().add(duration, 'seconds').toISOString()}` : ''

        const postBody = {
            text: `${description}\n\n` + logTime
        }

        const addNoteRes = await axios.post(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
            postBody,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        newLogId = `${addNoteRes.data.id}_note`;

        let logID_db = await CallLogModel.findOne({
            where: {
                thirdPartyLogId: existingCallLog.thirdPartyLogId,
                contactId: contactId
            }
        });

        if (logID_db) {
            logID_db.thirdPartyLogId = newLogId;
            await logID_db.save();
        }
    }

    else {

        const updateBody = { summary: description };

        await axios.patch(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${realId}`,
            updateBody,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        newLogId = `${realId}_job`;

        let logID_db = await CallLogModel.findOne({
            where: {
                thirdPartyLogId: existingCallLog.thirdPartyLogId,
                contactId: contactId
            }
        });

        if (logID_db) {
            logID_db.thirdPartyLogId = newLogId;
            await logID_db.save();
        }
    }

    return {
        logId: newLogId,
        updatedNote: description,
        returnMessage: {
            message: 'Call log updated',
            messageType: 'success',
            ttl: 2000
        },
        extraDataTracking: {
            withSmartNoteLog: !!aiNote,
            withTranscript: !!transcript
        }
    };
}

module.exports = updateCallLog;
