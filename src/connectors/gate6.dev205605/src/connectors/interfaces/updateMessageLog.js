const axios = require('axios');
const {
    getHostname,
    validateLicenseOrFail,
    findStateValueByName,
    findStateValueById,
    findTypeValueByName,
    findTypeValueById,
    applyClosedDatesIfNeeded,
    downloadAudioFile,
    uploadToServiceNow
} = require('../utils/servicenowHelpers');

// Used to update existing message log so to group message in the same day together
async function updateMessageLog({ user, contactInfo, existingMessageLog, message, authHeader, contactNumber, additionalSubmission, recordingLink, faxDocLink }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;
    
    const existingLogId = existingMessageLog.thirdPartyLogId;

    if (!existingLogId) {
        return {
            logId: null,
            returnMessage: {
                messageType: 'error',
                message: 'Missing message log id for update.',
                ttl: 3000
            }
        };
    }

    const getLogRes = await axios.get(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        { headers: { 'Authorization': authHeader } }
    );

    let originalNote = getLogRes?.data?.result?.work_notes ?? '';

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    const updatedText =
        `${message.direction} ${messageType} - ${message.direction === 'Inbound'
            ? `from ${message.from.name ?? ''} (${message.from.phoneNumber})`
            : `to ${message.to[0].name ?? ''} (${message.to[0].phoneNumber})`
        }\n${message.subject ? `[Message] ${message.subject}` : ''}`
        + (recordingLink ? `\n[Recording link] ${recordingLink}` : '')
        + (faxDocLink ? `\n[Fax document link] ${faxDocLink}` : '');

    const updatedWorkNotes = `${originalNote}\n${updatedText}`;

    const patchBody = {
        short_description: `[${messageType}] ${message.direction} ${messageType} - ${existingMessageLog.contactName ?? ''}`,
        work_notes: updatedWorkNotes
    };

    if (additionalSubmission?.state) {
        const returnedState = await findStateValueById(hostname, authHeader, additionalSubmission.state);
        patchBody.state = returnedState ?? await findStateValueByName(hostname, authHeader, additionalSubmission.state);
        applyClosedDatesIfNeeded(patchBody, patchBody.state, null);
    }

    if (additionalSubmission?.type) {
        const returnedType = await findTypeValueById(hostname, authHeader, additionalSubmission.type);
        patchBody.type = returnedType ?? await findTypeValueByName(hostname, authHeader, additionalSubmission.type);
    }

    const updateLogRes = await axios.patch(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        patchBody,
        {
            headers: { 'Authorization': authHeader }
        });

    if (recordingLink || faxDocLink) {
        const downloadUrl = recordingLink || faxDocLink;
        const fileName = recordingLink
            ? `Voicemail-${Date.now()}.mp3`
            : `Fax-${Date.now()}.pdf`;
        const s3Url = await downloadAudioFile(downloadUrl, process.env.S3_BUCKET, fileName);
        await uploadToServiceNow(s3Url, hostname, authHeader, existingLogId, fileName);
    }

    return {
        logId: existingLogId,
        returnMessage: {
            message: 'Message log updated.',
            messageType: 'success',
            ttl: 3000
        }
    };
}

module.exports = updateMessageLog;
