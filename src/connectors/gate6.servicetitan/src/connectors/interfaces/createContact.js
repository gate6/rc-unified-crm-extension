const axios = require('axios');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { getRefreshedAuthToken } = require('../utils/serviceTitanHelpers');

async function createContact({ user, phoneNumber, newContactName }) {
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const cleanedPhone = phoneNumber.replace(' ', '+');
    const phoneNumberObj = parsePhoneNumber(cleanedPhone);
    const parsedPhone = phoneNumberObj.valid ? phoneNumberObj.number.significant : cleanedPhone;

    const [firstName, ...lastNameParts] = newContactName.trim().split(' ');
    const lastName = lastNameParts.join(' ') || firstName;
    try {
        const payload = {
            name: `${firstName} ${lastName}`.trim(),
            doNotMail: false,
            doNotService: false,
            locations: [
                {
                    name: `${firstName} ${lastName}`.trim(),
                    address: {
                        street: 'street',
                        city: 'Phoenix',
                        state: 'AZ',
                        zip: '85001',
                        country: 'USA'
                    },
                    contacts: [
                        {
                            type: 'phone',
                            value: parsedPhone,
                            memo: 'Primary contact number',
                        }
                    ],
                },
            ],
            address: {
                street: 'street',
                city: 'Phoenix',
                state: 'AZ',
                zip: '85001',
                country: 'USA'
            },
            contacts: [
                {
                    type: 'phone',
                    value: parsedPhone,
                    memo: 'Primary contact number',
                }
            ],
        };

        const response = await axios.post(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json',
                },
            }
        );

        const createdContact = response.data;

        return {
            contactInfo: {
                id: createdContact.id,
                name: createdContact.name
            },
            returnMessage: {
                message: `Contact created.`,
                messageType: 'success',
                ttl: 2000
            }
        };
    } catch (error) {
        console.error('Failed to create contact:', error?.response?.data || error.message);
        return {
            contactInfo: null,
            returnMessage: {
                message: `Failed to create contact.`,
                messageType: 'error',
                ttl: 3000
            }
        };
    }
}

module.exports = createContact;
