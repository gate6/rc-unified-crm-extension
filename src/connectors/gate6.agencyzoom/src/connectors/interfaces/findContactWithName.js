const axios = require('axios');
const { AZ_BASE_URL, getRefreshedAuthToken } = require('../utils/agencyZoomHelpers');

async function findContactWithName({ user, name }) {
  try {
    const auth = await getRefreshedAuthToken(user);
    const encodedName = encodeURIComponent(name || '');

    const res = await axios.get(
      `${AZ_BASE_URL}/customers?name=${encodedName}`,
      {
        headers: {
          Authorization: `Bearer ${auth}`
        }
      }
    );

    const customers = res.data?.customers || [];

    const matchedContactInfo = customers.map(c => ({
      id: c.id,
      name: `${c.firstname || ''} ${c.lastname || ''}`.trim(),
      type: 'contact'
    }));

    return {
      successful: true,
      matchedContactInfo
    };
  } catch (err) {
    return {
      successful: false,
      matchedContactInfo: [],
      returnMessage: {
        messageType: 'error',
        message: err?.response?.data?.message || 'Failed to search AgencyZoom contacts.',
        ttl: 3000
      }
    };
  }
}

module.exports = findContactWithName;
