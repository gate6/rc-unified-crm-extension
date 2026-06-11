const moment = require('moment');
const { getRefreshedAuthToken, fetchJobs, validateLicenseOrFail, serviceTitanApiClient } = require('../utils/serviceTitanHelpers');

async function createCallLog({ user, contactInfo, callLog, note, additionalSubmission, aiNote, transcript, composedLogDetails, hashedAccountId }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const jobs = await fetchJobs({ user, params: { customerId: contactInfo.id } });

    // Respect the addCallLogSubject user setting
    const subject =
        (user.userSettings?.addCallLogSubject?.value ?? true)
            ? (callLog?.customSubject?.trim() || `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name}`)
            : '';

    // Build optional sections individually, respecting each user setting
    const sections = [];

    if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
        sections.push(`Agent Notes:\n${note}`);
    }

    if (contactInfo?.phone && (user.userSettings?.addCallLogContactNumber?.value ?? true)) {
        sections.push(`Contact Number:\n${contactInfo.phone}`);
    }

    if (callLog?.result && (user.userSettings?.addCallLogResult?.value ?? true)) {
        sections.push(`Result:\n${callLog.result}`);
    }

    if (callLog?.duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
        sections.push(`Duration:\n${callLog.duration} sec`);
    }

    if (callLog?.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) {
        sections.push(`Recording:\n${callLog.recording.link}`);
    }

    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
        sections.push(`AI Note:\n${aiNote}`);
    }

    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        sections.push(`Transcript:\n${transcript}`);
    }

    const optionalSections = sections.join('\n\n');

    // Structured, properly formatted note body
    const noteText = `Subject: ${subject}
Direction: ${callLog.direction}
Start Time: ${moment(callLog.startTime).format('YYYY-MM-DD HH:mm:ss')}
End Time: ${moment(callLog.startTime).add(callLog.duration, 'seconds').format('YYYY-MM-DD HH:mm:ss')}

${optionalSections}`.trim();

    const contactId = contactInfo.id;

    let addNoteRes;
    let logType = 'note';

    if (!jobs || jobs.length === 0) {

        addNoteRes = await serviceTitanApiClient.post(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
            { text: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );

    } else {

        const latestJob = jobs.reduce((max, job) =>
            job.id > max.id ? job : max
        );

        addNoteRes = await serviceTitanApiClient.patch(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${latestJob.id}`,
            { summary: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
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
            message: 'Call log created',
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
