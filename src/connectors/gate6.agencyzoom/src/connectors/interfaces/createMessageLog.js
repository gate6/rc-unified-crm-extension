const axios = require('axios');
const {
  AZ_BASE_URL,
  getRefreshedAuthToken,
  validateLicenseOrFail
} = require('../utils/agencyZoomHelpers');

async function createMessageLog({ user, contactInfo, message, recordingLink, faxDocLink }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  if (!contactInfo?.id) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: 'Missing contact id for AgencyZoom message log create.',
        ttl: 3000
      }
    };
  }

  const auth = await getRefreshedAuthToken(user);
  const logId = `az-msg-${Date.now().toString(36)}`;
  const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

  let subject = '';
  let description = '';

  switch (messageType) {
    case 'SMS':
      subject = `SMS conversation with ${contactInfo.name}`;
      description = `SMS from ${message.direction === 'Inbound' ? contactInfo.name : 'user'}: ${message.subject}`;
      break;

    case 'Voicemail':
      subject = `Voicemail from ${contactInfo.name}`;
      description = `Voicemail recording link: ${recordingLink}`;
      break;

    case 'Fax':
      subject = `Fax from ${contactInfo.name}`;
      description = `Fax document link: ${faxDocLink}`;
      break;
  }

  const noteBody = `
[RingCentral Message Log]
RC_LOG_ID: ${logId}

Subject: ${subject}

Conversation:
${description}
`;

  await axios.post(
    `${AZ_BASE_URL}/customers/${contactInfo.id}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` } }
  );

  return {
    logId,
    contactId: Number(contactInfo.id),
    returnMessage: {
      message: 'Message logged in AgencyZoom',
      messageType: 'success',
      ttl: 1000
    }
  };
}

module.exports = createMessageLog;
