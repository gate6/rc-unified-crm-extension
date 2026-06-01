const axios = require('axios');
const moment = require('moment');
const { getRefreshedAuthToken, validateLicenseOrFail } = require('../utils/serviceTitanHelpers');

async function createMessageLog({ user, contactInfo, authHeader, message, additionalSubmission, recordingLink, faxDocLink }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;
    const contactId = contactInfo.id;

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');
    let noteText = "";

    if (messageType === "SMS") {
        const direction = message.direction === "Inbound" ? contactInfo.name : "Agent";
        const line = `[${moment(message.creationTime).format("YYYY-MM-DD HH:mm:ss")}] ${direction}: ${message.subject}`;
        noteText = `Conversation:\n${line}`.trim();
    } else if (messageType === "Voicemail") {
        noteText = `Voicemail from ${contactInfo.name}\n\nRecording:\n${recordingLink}`.trim();
    } else if (messageType === "Fax") {
        noteText = `Fax from ${contactInfo.name}\n\nDocument:\n${faxDocLink}`.trim();
    }

    const addLogRes = await axios.post(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
        { text: noteText },
        {
            headers: {
                Authorization: `Bearer ${auth}`,
                'ST-App-Key': stAppKey,
                'Content-Type': 'application/json'
            }
        });

    return {
        logId: addLogRes.data.id,
        contactId,
        returnMessage: {
            message: 'Message logged as a note',
            messageType: 'success',
            ttl: 1000
        }
    };
}

module.exports = createMessageLog;
