const axios = require('axios');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const { getHostname } = require('../utils/servicenowHelpers');
const models = initModels(sequelize);

async function createContact({ user, authHeader, phoneNumber, newContactName, newContactType }) {
    const userInfo = await getHostname(user.dataValues.hostname);
    const hostname = userInfo.hostname;

    const companyData = await models.companies.findOne({
        where: { hostname: hostname, status: true }
    });

    const postBody = {
        phone: phoneNumber,
        type: newContactType,
    };

    let contactInfoRes;
    const isExtensionNumber = phoneNumber.toString().length <= 8 && phoneNumber.toString().length >= 3;

    if (companyData?.contactTable == 'contact' && !isExtensionNumber) {
        const account = await axios.get(`https://${hostname}/api/now/account`, {
            headers: { 'Authorization': authHeader }
        });

        postBody.account = account.data.result[0].sys_id;
        postBody.name = newContactName?.toLowerCase();
        contactInfoRes = await axios.post(
            `https://${hostname}/api/now/contact`,
            postBody,
            { headers: { 'Authorization': authHeader } }
        );
    } else {
        postBody.user_name = newContactName?.toLowerCase();
        contactInfoRes = await axios.post(
            `https://${hostname}/api/now/table/sys_user`,
            postBody,
            { headers: { 'Authorization': authHeader } }
        );
    }

    return {
        contactInfo: {
            id: contactInfoRes.id,
            name: contactInfoRes?.user_name ? contactInfoRes.user_name : contactInfoRes.name
        },
        returnMessage: {
            message: `New contact created.`,
            messageType: 'success',
            ttl: 3000
        }
    }
}

module.exports = createContact;