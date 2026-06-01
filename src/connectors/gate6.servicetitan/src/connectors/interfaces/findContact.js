const axios = require('axios');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { getRefreshedAuthToken, formatContact, validateLicenseOrFail } = require('../utils/serviceTitanHelpers');

async function findContact({ user, phoneNumber, isExtension }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    if (isExtension === 'true') {
        return {
            successful: false,
            matchedContactInfo: []
        }
    }
    const matchedContactInfo = [];
    phoneNumber = phoneNumber.replace(' ', '+')
    const phoneNumberObj = parsePhoneNumber(phoneNumber);
    let phoneNumberWithoutCountryCode = phoneNumber;
    if (phoneNumberObj.valid) {
        phoneNumberWithoutCountryCode = phoneNumberObj.number.significant;
    }
    const personInfo = await axios.get(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers?phone=${phoneNumberWithoutCountryCode}`,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': user.dataValues.platformAdditionalInfo.st_app_key
            }
        });

    if (personInfo.data && personInfo.data.data) {
        for (let rawPersonInfo of personInfo.data.data) {
            rawPersonInfo['phoneNumber'] = phoneNumber;
            matchedContactInfo.push(formatContact(rawPersonInfo));
        }
    }
    matchedContactInfo.push({
        id: 'createNewContact',
        name: 'Create new contact...',
        isNewContact: true
    });
    return {
        successful: true,
        matchedContactInfo
    };
}

module.exports = findContact;
