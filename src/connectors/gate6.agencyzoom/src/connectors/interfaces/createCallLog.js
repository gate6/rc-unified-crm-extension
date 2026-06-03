const axios = require('axios');
const moment = require('moment');
const {
  AZ_BASE_URL,
  getRefreshedAuthToken,
  validateLicenseOrFail
} = require('../utils/agencyZoomHelpers');

async function createCallLog({ user, contactInfo, callLog, note, aiNote, transcript }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const auth = await getRefreshedAuthToken(user);
  const logId = `az-log-${Date.now().toString(36)}`;
  const subject =
    callLog.customSubject ??
    `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name}`;

  let description = '';

  if (note && (user.userSettings?.addCallLogNote?.value ?? true))
    description += `Agent Notes: ${note}\n`;

  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true))
    description += `AI Note: ${aiNote}\n`;

  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true))
    description += `Transcript: ${transcript}\n`;

  if (callLog.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true))
    description += `Recording: ${callLog.recording.link}\n`;

  const noteBody = `
[RingCentral Call Log]
RC_LOG_ID: ${logId}

Subject: ${subject}
Direction: ${callLog.direction}
Duration: ${callLog.duration} sec
Start Time: ${moment(callLog.startTime).format('YYYY-MM-DD HH:mm:ss')}
End Time: ${moment(callLog.startTime).add(callLog.duration, 'seconds').format('YYYY-MM-DD HH:mm:ss')}

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
      messageType: 'success',
      message: 'Call log created',
      ttl: 3000
    }
  };
}

module.exports = createCallLog;
