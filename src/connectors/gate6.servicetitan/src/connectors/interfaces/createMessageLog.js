const axios = require('axios');
const moment = require('moment');
const { getRefreshedAuthToken } = require('../utils/serviceTitanHelpers');

async function createMessageLog({ user, contactInfo, authHeader, message, additionalSubmission, recordingLink, faxDocLink }) {
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');
    let subject = '';
    let description = '';
    switch (messageType) {
        case 'SMS':
            subject = `SMS conversation with ${contactInfo.name}`;
            description = `SMS from ${message.direction === 'Inbound' ? contactInfo.name : 'user'}: ${message.subject}`;
            break;
        case 'Voicemail':
            subject = `Voicemail from ${contactInfo.name}`;
            description = `Voicemail recording link: ${recordingLink}\n`;
            break;
        case 'Fax':
            subject = `Fax from ${contactInfo.name}`;
            description = `Fax document link: ${faxDocLink}`;
            break;
    }

    const contactId = contactInfo.id;
    let postBody = JSON.stringify({
        "text": JSON.stringify({
            start_date: moment(message.creationTime).utc().toISOString(),
            end_date: moment(message.creationTime).utc().toISOString(),
            subject,
            description,
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

    return {
        logId: addLogRes.data.id,
        returnMessage: {
            message: 'Message logged as a note',
            messageType: 'success',
            ttl: 1000
        }
    };
}

module.exports = createMessageLog;
