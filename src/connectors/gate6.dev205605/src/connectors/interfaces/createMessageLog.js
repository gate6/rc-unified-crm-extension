const axios = require('axios');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const { getHostname } = require('../utils/servicenowHelpers');
const models = initModels(sequelize);

async function createMessageLog({ user, contactInfo, authHeader, message, additionalSubmission, recordingLink, faxDocLink }) {
    const userInfo = await getHostname(user.dataValues.hostname);
    const hostname = userInfo.hostname;

    const { userDetailsPath } = await models.companies.findOne({
        where: { hostname: hostname, status: true },
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
    
    const postBody = {
        data: {
            short_description: `[SMS] ${message.direction} SMS - ${message.from.name ?? ''}(${message.from.phoneNumber}) to ${message.to[0].name ?? ''}(${message.to[0].phoneNumber})`,
            work_notes: `${message.direction} SMS - ${message.direction == 'Inbound' ? `from ${message.from.name ?? ''}(${message.from.phoneNumber})` : `to ${message.to[0].name ?? ''}(${message.to[0].phoneNumber})`} \n${!!message.subject ? `[Message] ${message.subject}` : ''} ${!!recordingLink ? `\n[Recording link] ${recordingLink}` : ''}\n\n--- Created via RingCentral CRM Extension`,
            type: "Chat",
            caller_id: caller_id.data.result.id
        }
    };

    const addLogRes = await axios.post(
        `https://${hostname}/api/now/table/interaction`,
        postBody,
        { headers: { 'Authorization': authHeader } }
    );

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