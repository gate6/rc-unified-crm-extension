const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { getRefreshedAuthToken, validateLicenseOrFail, serviceTitanApiClient } = require('../utils/serviceTitanHelpers');

const SERVICE_TITAN_CRM_URL = 'https://api-integration.servicetitan.io/crm/v2/tenant';
const SERVICE_TITAN_JPM_URL = 'https://api-integration.servicetitan.io/jpm/v2/tenant';

async function updateCallLog({ user, existingCallLog, authHeader, recordingLink, subject, note, startTime, duration, result, aiNote, transcript, additionalSubmission, composedLogDetails, existingCallLogDetails, hashedAccountId }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const contactId = existingCallLog.contactId;

    let [realId, logType] = existingCallLog.thirdPartyLogId.split('_');
    logType = logType || 'note';

    // ---------------- FETCH OLD DATA to preserve direction/times ----------------
    let direction = '';
    let savedStartTime = '';
    let savedEndTime = '';
    let savedResult = '';
    let savedDuration = '';
    let subjectToUse = '';
    let body = '';

    if (logType === 'note') {
        const getLogRes = await serviceTitanApiClient.get(
            `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                }
            }
        );

        const targetLog = getLogRes.data.data.find(log => log.id == realId);
        if (targetLog) {
            body = targetLog.text || '';
        }
    } else {
        const jobRes = await serviceTitanApiClient.get(
            `${SERVICE_TITAN_JPM_URL}/${tenantId}/jobs/${realId}`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                }
            }
        );
        body = jobRes.data?.summary || '';
    }

    // Parse preserved fields from the existing note body
    if (body) {
        const normalized = body.replace(/\r\n/g, '\n');

        const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/);
        const extractedSubject = subjectMatch?.[1]?.trim();
        if (extractedSubject && !extractedSubject.toLowerCase().startsWith('direction:')) {
            subjectToUse = extractedSubject;
        }

        direction = normalized.match(/^\s*Direction:\s*(.*)$/m)?.[1]?.trim() || '';
        savedStartTime = normalized.match(/^\s*Start Time:\s*(.*)$/m)?.[1]?.trim() || '';
        savedEndTime = normalized.match(/^\s*End Time:\s*(.*)$/m)?.[1]?.trim() || '';
        savedResult = normalized.match(/^\s*Result:\s*(.*)$/m)?.[1]?.trim() || '';
        savedDuration = normalized.match(/^\s*Duration:\s*(.*)$/m)?.[1]?.trim() || '';
    }

    // Allow subject override if provided
    if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
        subjectToUse = subject.trim();
    }

    // ---------------- BUILD OPTIONAL SECTIONS respecting user settings ----------------
    const sections = [];

    if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
        sections.push(`Agent Notes:\n${note}`);
    }

    if (recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) {
        sections.push(`Recording:\n${decodeURIComponent(recordingLink)}`);
    }

    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
        sections.push(`AI Note:\n${aiNote}`);
    }

    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        sections.push(`Transcript:\n${transcript}`);
    }

    if (user.userSettings?.addCallLogResult?.value ?? true) {
        sections.push(`Result:\n${result || savedResult}`);
    }

    if (user.userSettings?.addCallLogDuration?.value ?? true) {
        sections.push(`Duration:\n${duration ? `${duration} sec` : savedDuration}`);
    }

    const optionalSections = sections.join('\n\n');

    // ---------------- STRUCTURED NOTE BODY ----------------
    const noteText = `Subject: ${subjectToUse}
Direction: ${direction}
Start Time: ${savedStartTime}
End Time: ${savedEndTime}

${optionalSections}`.trim();

    let newLogId;

    // ---------------- UPDATE NOTE ----------------
    if (logType === 'note') {

        const addNoteRes = await serviceTitanApiClient.post(
            `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`,
            { text: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        newLogId = `${addNoteRes.data.id}_note`;

        const logID_db = await CallLogModel.findOne({
            where: {
                thirdPartyLogId: existingCallLog.thirdPartyLogId,
                contactId
            }
        });

        if (logID_db) {
            logID_db.thirdPartyLogId = newLogId;
            await logID_db.save();
        }
    }

    // ---------------- UPDATE JOB ----------------
    else {

        await serviceTitanApiClient.patch(
            `${SERVICE_TITAN_JPM_URL}/${tenantId}/jobs/${realId}`,
            { summary: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        newLogId = `${realId}_job`;

        const logID_db = await CallLogModel.findOne({
            where: {
                thirdPartyLogId: existingCallLog.thirdPartyLogId,
                contactId
            }
        });

        if (logID_db) {
            logID_db.thirdPartyLogId = newLogId;
            await logID_db.save();
        }
    }

    return {
        logId: newLogId,
        updatedNote: noteText,
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
