const moment = require('moment');
const { MessageLogModel } = require('@app-connect/core/models/messageLogModel');
const { getRefreshedAuthToken, validateLicenseOrFail, serviceTitanApiClient } = require('../utils/serviceTitanHelpers');

const SERVICE_TITAN_CRM_URL = "https://api-integration.servicetitan.io/crm/v2/tenant";

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, authHeader, recordingLink, faxDocLink }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const contactId = contactInfo.id;
    const noteId = existingMessageLog.thirdPartyLogId;

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');
    let noteText = "";

    if (messageType === "SMS") {
        const getLogRes = await serviceTitanApiClient.get(
            `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey
                }
            }
        );

        const targetLog = getLogRes.data.data.find(log => log.id == noteId);
        let previousConversation = "";

        if (targetLog?.text) {
            const match = targetLog.text.match(/Conversation:\s*([\s\S]*)/);
            if (match) {
                previousConversation = match[1].trim();
            }
        }

        const direction = message.direction === "Inbound" ? contactInfo.name : "Agent";
        const newLine = `[${moment(message.creationTime).format("YYYY-MM-DD HH:mm:ss")}] ${direction}: ${message.subject}`;
        const updatedConversation = previousConversation
            ? `${previousConversation}\n${newLine}`
            : newLine;

        const MAX_NOTE_SIZE = 30000;
        if (updatedConversation.length > MAX_NOTE_SIZE) {
            const lines = previousConversation.trim().split("\n");
            const lastMessage = lines[lines.length - 1] || "";
            noteText = `Conversation:\n${lastMessage}\n${newLine}`.trim();
        } else {
            noteText = `Conversation:\n${updatedConversation}`.trim();
        }
    } else if (messageType === "Voicemail") {
        noteText = `Voicemail from ${contactInfo.name}\n\nRecording:\n${recordingLink}`.trim();
    } else if (messageType === "Fax") {
        noteText = `Fax from ${contactInfo.name}\n\nDocument:\n${faxDocLink}`.trim();
    }

    const addLogRes = await serviceTitanApiClient.post(
        `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`,
        { text: noteText },
        {
            headers: {
                Authorization: `Bearer ${auth}`,
                "ST-App-Key": stAppKey,
                "Content-Type": "application/json"
            }
        });

    const messageLogID_db = await MessageLogModel.findOne({
        where: {
            thirdPartyLogId: existingMessageLog.thirdPartyLogId
        }
    });

    if (messageLogID_db) {
        messageLogID_db.thirdPartyLogId = addLogRes.data.id;
        await messageLogID_db.save();
    }

    return {
        logId: addLogRes.data.id,
        returnMessage: {
            message: 'Message log updated',
            messageType: 'success',
            ttl: 1000
        }
    };
}

module.exports = updateMessageLog;
