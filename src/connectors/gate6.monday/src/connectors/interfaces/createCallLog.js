const {
  moment,
  mondayRequest,
  getOrCreateCallLogsColumn,
  getCompanyByHostname,
  downloadAudioFile,
  uploadToMonday,
  validateLicenseOrFail
} = require('../utils/mondayHelpers');

async function createCallLog({ contactInfo, callLog, note, aiNote, transcript, accessToken, authHeader, user }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken;

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
  });
  const boardId = company.tenantId;

  const subject =
    (user.userSettings?.addCallLogSubject?.value ?? true)
      ? (callLog?.customSubject?.trim() || '')
      : '';

  let sections = [];

  if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
    sections.push(`Agent Notes:<br>${note.replace(/\r?\n/g, '<br>')}`);
  }
  if (callLog?.result && (user.userSettings?.addCallLogResult?.value ?? true)) {
    sections.push(`Result:<br>${callLog.result}`);
  }
  if (callLog?.duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
    sections.push(`Duration:<br>${callLog.duration} sec`);
  }
  if (callLog?.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) {
    sections.push(`Recording:<br>${callLog.recording.link}`);
  }
  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
    sections.push(`AI Note:<br>${aiNote.replace(/\r?\n/g, '<br>')}`);
  }
  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
    sections.push(`Transcript:<br>${transcript.replace(/\r?\n/g, '<br>')}`);
  }

  const optionalSections = sections.join('<br><br>');
  const lines = [
    `Subject: ${subject}`,
    `Direction: ${callLog.direction}`,
    `Start Time: ${moment(callLog.startTime).format('YYYY-MM-DD HH:mm:ss')}`,
    `End Time: ${moment(callLog.startTime).add(callLog.duration, 'seconds').format('YYYY-MM-DD HH:mm:ss')}`,
    '',
    optionalSections
  ].filter(Boolean);

  const body = lines.join('<br>');

  const res = await mondayRequest(
    resolvedAccessToken,
    `
    mutation ($itemId: ID!, $body: String!) {
      create_update(item_id: $itemId, body: $body) {
        id
      }
    }
    `,
    {
      itemId: Number(contactInfo.id),
      body
    }
  );

  if (res?.errors?.length || !res?.data?.create_update?.id) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: res?.errors?.[0]?.message || 'Failed to create call log in Monday.',
        ttl: 3000
      }
    };
  }

  const updateId = res.data.create_update.id;

  // ---- Sync body to Call Logs column ----
  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  });
  if (callLogsColumnId) {
    await mondayRequest(
      resolvedAccessToken,
      `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(
          board_id: $boardId,
          item_id: $itemId,
          column_id: $columnId,
          value: $value
        ) {
          id
        }
      }
      `,
      {
        boardId,
        itemId: Number(contactInfo.id),
        columnId: callLogsColumnId,
        value: body
      }
    );
  }

  // ---- Recording Upload ----
  if (callLog?.recording?.downloadUrl) {
    const fileName = `Call-${Date.now()}.mp3`;
    const s3Key = fileName;
    const s3Url = await downloadAudioFile(
      callLog.recording.downloadUrl,
      process.env.S3_BUCKET,
      s3Key
    );

    await uploadToMonday({
      s3Url,
      accessToken: resolvedAccessToken,
      itemId: Number(contactInfo.id),
      fileName,
      hostname: user.dataValues.hostname
    });
  }

  return {
    logId: updateId,
    contactId: Number(contactInfo.id),
    returnMessage: {
      message: 'Call log created',
      messageType: 'success',
      ttl: 2000
    }
  };
}

module.exports = createCallLog;