const axios = require('axios');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
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
const models = initModels(sequelize);

async function createMessageLog({ user, contactInfo, authHeader, message, additionalSubmission, recordingLink, faxDocLink }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const hostname = userInfo.hostname;

    const { userDetailsPath } = await models.companies.findOne({
        where: { hostname: hostname },
        raw: true
    });

    if (!userDetailsPath) {
        return {
            successful: false,
            returnMessage: {
                messageType: 'danger',
                message: `You are not having an active license. Please contact us.`,
                ttl: 3000
            }
        };
    }
    
    const caller_id = await axios.get(`https://${hostname}/api/${userDetailsPath}`, {
        headers: { 'Authorization': authHeader }
    });
    
    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    const workNotes =
        `${message.direction} ${messageType} - ${message.direction === 'Inbound'
            ? `from ${message.from.name ?? ''} (${message.from.phoneNumber})`
            : `to ${message.to[0].name ?? ''} (${message.to[0].phoneNumber})`
        }\n${message.subject ? `[Message] ${message.subject}` : ''}`
        + (recordingLink ? `\n[Recording link] ${recordingLink}` : '')
        + (faxDocLink ? `\n[Fax document link] ${faxDocLink}` : '')
        + `\n\n--- Created via RingCentral CRM Extension`;

    const postBody = {
        short_description: `[${messageType}] ${message.direction} ${messageType} - ${contactInfo.name}`,
        work_notes: workNotes,
        assigned_to: caller_id.data.result.id,
        opened_for: contactInfo.id
    };

    if (message?.startTime) {
        postBody.opened_at = message.startTime;
    }

    if (additionalSubmission?.state) {
        const returnedState = await findStateValueById(hostname, authHeader, additionalSubmission.state);
        postBody.state = returnedState ?? await findStateValueByName(hostname, authHeader, additionalSubmission.state);
        applyClosedDatesIfNeeded(postBody, postBody.state, null);
    }

    if (additionalSubmission?.type) {
        const returnedType = await findTypeValueById(hostname, authHeader, additionalSubmission.type);
        postBody.type = returnedType ?? await findTypeValueByName(hostname, authHeader, additionalSubmission.type);
    }

    const addLogRes = await axios.post(
        `https://${hostname}/api/now/table/interaction`,
        postBody,
        { headers: { 'Authorization': authHeader } }
    );

    if (recordingLink || faxDocLink) {
        const downloadUrl = recordingLink || faxDocLink;
        const fileName = recordingLink
            ? `Voicemail-${Date.now()}.mp3`
            : `Fax-${Date.now()}.pdf`;
        const s3Url = await downloadAudioFile(downloadUrl, process.env.S3_BUCKET, fileName);
        await uploadToServiceNow(s3Url, hostname, authHeader, addLogRes?.data?.result?.sys_id, fileName);
    }

    return {
        logId: addLogRes.data.result.sys_id,
        returnMessage: {
            message: 'Message log added.',
            messageType: 'success',
            ttl: 3000
        }
    };
}

module.exports = createMessageLog;
