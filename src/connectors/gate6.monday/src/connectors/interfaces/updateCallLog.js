const {
  moment,
  mondayRequest,
  parseMondayCallLogBody,
  getCompanyByHostname,
  getOrCreateCallLogsColumn,
  downloadAudioFile,
  uploadToMonday,
  validateLicenseOrFail
} = require('../utils/mondayHelpers');

async function updateCallLog({ existingCallLog, recordingLink, note, aiNote, transcript, accessToken, authHeader, user, subject, duration, startTime }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken;

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
  });
  const boardId = company.tenantId;

  if (!existingCallLog?.thirdPartyLogId) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: 'Missing call log id for Monday update.',
        ttl: 3000
      }
    };
  }

  const res = await mondayRequest(
    resolvedAccessToken,
    `
    query ($updateId: [ID!]) {
      updates(ids: $updateId) {
        id
        body
      }
    }
    `,
    { updateId: [existingCallLog.thirdPartyLogId] }
  );

  const oldBody = res?.data?.updates?.[0]?.body || '';
  const parsed = parseMondayCallLogBody(oldBody);
  let subjectToUse = parsed.subject;

  if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
    subjectToUse = subject.trim();
  }

  let sections = [];

  if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
    sections.push(`Agent Notes:<br>${note.replace(/\r?\n/g, '<br>')}`);
  }
  if (parsed.result && (user.userSettings?.addCallLogResult?.value ?? true)) {
    sections.push(`Result:<br>${parsed.result}`);
  }
  if (duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
    sections.push(`Duration:<br>${duration} sec`);
  }
  if (recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) {
    sections.push(`Recording:<br>${recordingLink}`);
  }
  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
    sections.push(`AI Note:<br>${aiNote.replace(/\r?\n/g, '<br>')}`);
  }
  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
    sections.push(`Transcript:<br>${transcript.replace(/\r?\n/g, '<br>')}`);
  }

  let startTimeToUse = parsed.startTime;
  let endTimeToUse = parsed.endTime;

  if (startTime) {
    startTimeToUse = moment(startTime).format('YYYY-MM-DD HH:mm:ss');
    if (duration) {
      endTimeToUse = moment(startTime).add(duration, 'seconds').format('YYYY-MM-DD HH:mm:ss');
    }
  }

  const optionalSections = sections.join('<br><br>');
  const lines = [
    `Subject: ${subjectToUse}`,
    `Direction: ${parsed.direction}`,
    `Start Time: ${startTimeToUse}`,
    `End Time: ${endTimeToUse}`,
    '',
    optionalSections
  ].filter(Boolean);

  const body = lines.join('<br>');

  const updateRes = await mondayRequest(
    resolvedAccessToken,
    `
    mutation ($updateId: ID!, $body: String!) {
      edit_update(id: $updateId, body: $body) {
        id
      }
    }
    `,
    {
      updateId: existingCallLog.thirdPartyLogId,
      body
    }
  );

  if (updateRes?.errors?.length || !updateRes?.data?.edit_update?.id) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: updateRes?.errors?.[0]?.message || 'Failed to update call log in Monday.',
        ttl: 3000
      }
    };
  }

  // ---- Sync body to Call Logs column ----
  if (existingCallLog.contactId) {
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
          itemId: Number(existingCallLog.contactId),
          columnId: callLogsColumnId,
          value: body
        }
      );
    }
  }

  return {
    logId: updateRes.data.edit_update.id,
    returnMessage: {
      message: 'Call log updated',
      messageType: 'success',
      ttl: 2000
    }
  };
}

module.exports = updateCallLog;
