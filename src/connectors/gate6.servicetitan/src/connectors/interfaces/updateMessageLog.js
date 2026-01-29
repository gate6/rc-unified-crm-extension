const axios = require('axios');
const moment = require('moment');
const { messageLogModel } = require('@app-connect/core/models/messageLogModel');
const { getRefreshedAuthToken } = require('../utils/serviceTitanHelpers');

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, authHeader }) {
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const messageType = message.type;
    let subject = '';
    let description = '';
    switch (messageType) {
        case 'SMS':
            subject = `SMS conversation with ${contactInfo.name}`;
            description = `SMS from ${message.direction === 'Inbound' ? contactInfo.name : 'user'}: ${message.subject}`;
            break;
        case 'Voicemail':
            subject = `Voicemail from ${contactInfo.name}`;
            description = `Voicemail recording link: ${message.recordingLink}`;
            break;
        case 'Fax':
            subject = `Fax from ${contactInfo.name}`;
            description = `Fax document link: ${message.faxDocLink}`;
            break;
    }

    const contactId = contactInfo.id;
    let postBody = JSON.stringify({
        "text": JSON.stringify({
            subject,
            description,
            start_date: moment(message.creationTime).utc().toISOString(),
            end_date: moment(message.creationTime).utc().toISOString(),
        })
    });

    const addLogRes = await axios.post(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
        postBody,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': stAppKey,
                'Content-Type': 'application/json'
            }
        });

    let messageLogID_db = await messageLogModel.findOne({
        where: {
            thirdPartyLogId: existingMessageLog.thirdPartyLogId,
        }
    });

    if (messageLogID_db) {
        messageLogID_db.userId = existingMessageLog.userId;
        messageLogID_db.platform = existingMessageLog.platform;
        messageLogID_db.thirdPartyLogId = addLogRes.data.id;
        await messageLogID_db.save();
    }

    return {
        logId: addLogRes.data.id,
        returnMessage: {
            message: 'Message logged as a note',
            messageType: 'success',
            ttl: 1000
        }
    };
}

module.exports = updateMessageLog;
