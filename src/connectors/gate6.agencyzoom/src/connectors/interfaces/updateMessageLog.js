const axios = require('axios');
const moment = require('moment');
const {
  AZ_BASE_URL,
  buildNoteIndex,
  getRefreshedAuthToken,
  validateLicenseOrFail
} = require('../utils/agencyZoomHelpers');

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, recordingLink, faxDocLink }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const auth = await getRefreshedAuthToken(user);

  if (!existingMessageLog?.thirdPartyLogId) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: 'Missing message log id for AgencyZoom update.',
        ttl: 3000
      }
    };
  }
  if (!contactInfo?.id) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: 'Missing contact id for AgencyZoom message log update.',
        ttl: 3000
      }
    };
  }

  const contactId = contactInfo.id;
  const logId = existingMessageLog.thirdPartyLogId;

  const res = await axios.get(
    `${AZ_BASE_URL}/customers/${contactId}`,
    {
      headers: {
        Authorization: `Bearer ${auth}`
      }
    }
  );

  const notes = res.data?.notes || [];
  const noteIndex = buildNoteIndex(notes);
  const matchedNote = noteIndex[logId];

  const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');
  let newLine = '';

  switch (messageType) {
    case 'SMS':
      newLine = `[${moment(message.creationTime).format('YYYY-MM-DD HH:mm:ss')}] SMS ${message.direction === 'Inbound' ? 'from' : 'to'} ${contactInfo.name}: ${message.subject}`;
      break;

    case 'Voicemail':
      newLine = `[${moment(message.creationTime).format('YYYY-MM-DD HH:mm:ss')}] Voicemail recording link: ${recordingLink}`;
      break;

    case 'Fax':
      newLine = `[${moment(message.creationTime).format('YYYY-MM-DD HH:mm:ss')}] Fax document link: ${faxDocLink}`;
      break;
  }

  let conversation = '';
  const match = matchedNote?.body?.match(/Conversation:\s*([\s\S]*)/);
  if (match) conversation = match[1].trim();

  const updatedConversation = `${conversation}\n${newLine}`;

  const noteBody = `
[RingCentral Message Log]
RC_LOG_ID: ${logId}

Conversation:
${updatedConversation}
`;

  await axios.post(
    `${AZ_BASE_URL}/customers/${contactId}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` } }
  );

  return {
    logId,
    returnMessage: {
      message: 'Message updated in AgencyZoom',
      messageType: 'success',
      ttl: 1000
    }
  };
}

module.exports = updateMessageLog;
