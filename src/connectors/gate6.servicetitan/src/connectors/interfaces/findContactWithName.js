const axios = require('axios');
const { getRefreshedAuthToken, formatContact } = require('../utils/serviceTitanHelpers');

async function findContactWithName({ user, name }) {
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const matchedContactInfo = [];

    if (!name || name.trim() === '') {
        return {
            successful: false,
            matchedContactInfo: [],
            message: 'Name is required.'
        };
    }

    try {
        const personInfo = await axios.get(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers?name=${name}`,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                }
            }
        );

        if (personInfo.data && personInfo.data.data) {
            for (let rawPersonInfo of personInfo.data.data) {
                const phone = rawPersonInfo.phones?.find(p => p.type === 'Primary')?.phone ?? '';
                rawPersonInfo['phoneNumber'] = phone;
                matchedContactInfo.push(formatContact(rawPersonInfo));
            }
        }
        return {
            successful: true,
            matchedContactInfo
        };
    } catch (err) {
        console.error('Error finding contact by name:', err.message);
        return {
            successful: false,
            matchedContactInfo: [],
            message: 'Failed to fetch contact information.'
        };
    }
}

module.exports = findContactWithName;
