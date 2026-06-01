const axios = require('axios');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const { getHostname, validateLicenseOrFail } = require('../utils/servicenowHelpers');
const models = initModels(sequelize);

async function createContact({ user, authHeader, phoneNumber, newContactName, newContactType, additionalSubmission }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const hostname = userInfo.hostname;

    const companyData = await models.companies.findOne({
        where: { hostname: hostname }
    });

    const postBody = {
        phone: phoneNumber,
        type: newContactType,
    };

    let contactInfoRes;
    const isExtensionNumber = phoneNumber.toString().length <= 8 && phoneNumber.toString().length >= 3;

    if (companyData?.contactTable == 'contact' && !isExtensionNumber) {
        const selectedAccountId = (additionalSubmission?.account || '').trim();

        if (selectedAccountId) {
            postBody.account = selectedAccountId;
        } else {
            const account = await axios.get(
                `https://${hostname}/api/now/account?sysparm_limit=1`,
                { headers: { Authorization: authHeader } }
            );
            const fallbackAccountId = account?.data?.result?.[0]?.sys_id;
            if (fallbackAccountId) {
                postBody.account = fallbackAccountId;
            }
        }

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
