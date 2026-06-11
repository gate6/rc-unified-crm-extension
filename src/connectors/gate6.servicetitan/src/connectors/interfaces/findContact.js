const { parsePhoneNumber } = require('awesome-phonenumber');
const { AccountDataModel } = require('@app-connect/core/models/accountDataModel');
const { getRefreshedAuthToken, formatContact, validateLicenseOrFail, serviceTitanApiClient } = require('../utils/serviceTitanHelpers');

const SERVICE_TITAN_CRM_URL = 'https://api-integration.servicetitan.io/crm/v2/tenant';

async function findContact({ user, phoneNumber, isExtension }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    if (isExtension === 'true') {
        return {
            successful: false,
            matchedContactInfo: []
        };
    }

    const matchedContactInfo = [];
    phoneNumber = phoneNumber.replace(' ', '+');
    const phoneNumberObj = parsePhoneNumber(phoneNumber);
    let phoneNumberWithoutCountryCode = phoneNumber;
    if (phoneNumberObj.valid) {
        phoneNumberWithoutCountryCode = phoneNumberObj.number.significant;
    }

    const personInfo = await serviceTitanApiClient.get(
        `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers?phone=${phoneNumberWithoutCountryCode}`,
        {
            headers: {
                Authorization: `Bearer ${auth}`,
                'ST-App-Key': stAppKey
            }
        }
    );

    if (personInfo.data && personInfo.data.data) {
        for (let rawPersonInfo of personInfo.data.data) {
            rawPersonInfo['phoneNumber'] = phoneNumber;
            matchedContactInfo.push(formatContact(rawPersonInfo));
        }
    }

    // No contacts found — delete stale cache entry if it exists
    if (matchedContactInfo.length === 0 && user?.rcAccountId) {
        try {
            const deleted = await AccountDataModel.destroy({
                where: {
                    rcAccountId: user.rcAccountId,
                    platformName: 'servicetitan',
                    dataKey: `contact-${phoneNumber}`
                }
            });
            if (deleted > 0) {
                console.log('[ServiceTitan] findContact: deleted stale cache for phone:', phoneNumber);
            }
        } catch (err) {
            console.warn('[ServiceTitan] findContact: failed to delete stale cache:', err.message);
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
