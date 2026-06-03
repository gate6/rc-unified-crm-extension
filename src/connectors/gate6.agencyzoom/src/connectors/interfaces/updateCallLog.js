const axios = require('axios');
const moment = require('moment');
const {
  AZ_BASE_URL,
  getRefreshedAuthToken,
  validateLicenseOrFail
} = require('../utils/agencyZoomHelpers');

async function updateCallLog({
  user,
  existingCallLog,
  subject,
  startTime,
  duration,
  result,
  note,
  aiNote,
  transcript,
  recordingLink,
  composedLogDetails,
  existingCallLogDetails
}) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const auth = await getRefreshedAuthToken(user);

  if (!existingCallLog?.thirdPartyLogId) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: 'Missing call log id for AgencyZoom update.',
        ttl: 3000
      }
    };
  }

  const contactId = existingCallLog.contactId;
  const logId = existingCallLog.thirdPartyLogId;

  const oldBody =
    existingCallLogDetails?.body ||
    existingCallLogDetails?.note ||
    existingCallLogDetails?.fullBody ||
    '';

  const oldDirection =
    typeof oldBody === 'string'
      ? (oldBody.match(/Direction:\s*(.*?)(?:\n|$)/)?.[1] || '').trim()
      : '';

  const resolvedDirection = oldDirection || existingCallLog?.direction || '';
  const resolvedDuration = duration ?? existingCallLog?.duration ?? 0;
  const resolvedStartTime = startTime || existingCallLog?.startTime || null;
  const resolvedSubject =
    subject ||
    composedLogDetails ||
    existingCallLog?.subject ||
    `${resolvedDirection || 'Call'} Call`;

  let description = '';

  if (note && (user.userSettings?.addCallLogNote?.value ?? true))
    description += `Agent Notes: ${note}\n`;

  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true))
    description += `AI Note: ${aiNote}\n`;

  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true))
    description += `Transcript: ${transcript}\n`;

  if (recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) {
    let decodedLink = recordingLink;
    try {
      decodedLink = decodeURIComponent(recordingLink);
    } catch (err) {
      decodedLink = recordingLink;
    }
    description += `Recording: ${decodedLink}\n`;
  }

  const startTimeText = resolvedStartTime
    ? moment(resolvedStartTime).format('YYYY-MM-DD HH:mm:ss')
    : '';
  const endTimeText = resolvedStartTime
    ? moment(resolvedStartTime).add(Number(resolvedDuration) || 0, 'seconds').format('YYYY-MM-DD HH:mm:ss')
    : '';

  const noteBody = `
[RingCentral Call Log]
RC_LOG_ID: ${logId}

Subject: ${resolvedSubject}
Direction: ${resolvedDirection}
Result: ${result ?? existingCallLog?.result ?? ''}
Duration: ${resolvedDuration} sec
Start Time: ${startTimeText}
End Time: ${endTimeText}

${description}
`;

  await axios.post(
    `${AZ_BASE_URL}/customers/${contactId}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` } }
  );

  return {
    logId,
    returnMessage: {
      messageType: 'success',
      message: 'Call log updated',
      ttl: 3000
    }
  };
}

module.exports = updateCallLog;
