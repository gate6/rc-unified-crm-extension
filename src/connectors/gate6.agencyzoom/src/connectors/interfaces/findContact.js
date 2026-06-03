const axios = require('axios');
const {
  AZ_BASE_URL,
  getRefreshedAuthToken,
  normalizePhone,
  validateLicenseOrFail
} = require('../utils/agencyZoomHelpers');

async function findContact({ user, phoneNumber }) {
  try {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const phone = normalizePhone(phoneNumber);

    const res = await axios.post(
      `${AZ_BASE_URL}/customers`,
      { phone },
      {
        headers: {
          Authorization: `Bearer ${auth}`
        }
      }
    );

    const customers = res.data?.customers || [];

    let matchedContactInfo = customers.map(c => ({
      id: c.id,
      name: `${c.firstname || ''} ${c.lastname || ''}`.trim(),
      phone: c.phone,
      type: 'contact'
    }));

    if (matchedContactInfo.length > 1) {
      matchedContactInfo = [matchedContactInfo[0]];
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
  } catch (err) {
    return {
      successful: false,
      returnMessage: {
        messageType: 'error',
        message: err?.response?.data?.message || 'Failed to find AgencyZoom contacts.',
        ttl: 3000
      }
    };
  }
}

module.exports = findContact;
