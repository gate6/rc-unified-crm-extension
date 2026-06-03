const axios = require('axios');
const {
  AZ_BASE_URL,
  getRefreshedAuthToken,
  normalizePhone,
  validateLicenseOrFail
} = require('../utils/agencyZoomHelpers');

async function createContact({ user, phoneNumber, newContactName }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  if (!newContactName?.trim()) {
    return {
      contactInfo: null,
      returnMessage: {
        messageType: 'error',
        message: 'Contact name is required.',
        ttl: 3000
      }
    };
  }

  const auth = await getRefreshedAuthToken(user);
  const phone = normalizePhone(phoneNumber);

  const [firstName, ...rest] = newContactName.split(' ');
  const lastName = rest.join(' ') || firstName;

  const email = `${phone}@ringcentral.local`;

  let agentId;
  try {
    const jwtPayload = JSON.parse(
      Buffer.from(auth.split('.')[1], 'base64').toString()
    );
    agentId = parseInt(
      Buffer.from(jwtPayload?.jti?.agent || '', 'base64').toString(),
      10
    );
  } catch (err) {
    agentId = undefined;
  }

  const res = await axios.post(
    `${AZ_BASE_URL}/customers/create`,
    {
      firstname: firstName,
      lastname: lastName,
      phone,
      email,
      agentId
    },
    {
      headers: {
        Authorization: `Bearer ${auth}`
      }
    }
  );

  return {
    contactInfo: {
      id: res.data.id,
      name: `${firstName} ${lastName}`
    },
    returnMessage: {
      message: 'Contact created.',
      messageType: 'success',
      ttl: 2000
    }
  };
}

module.exports = createContact;
