const {
  moment,
  mondayRequest,
  getCompanyByHostname,
  getOrCreateCallLogsColumn,
  downloadAudioFile,
  uploadToMonday,
  validateLicenseOrFail
} = require('../utils/mondayHelpers');

const MAX_THREAD_MESSAGES = 10;

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, recordingLink, faxDocLink, accessToken, authHeader }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken;

  if (!existingMessageLog?.thirdPartyLogId) {
    throw new Error('Missing message log id for Monday update');
  }

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
  });
  const boardId = company.tenantId;
  const itemId = Number(contactInfo.id);
  const updateId = existingMessageLog.thirdPartyLogId;

  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  });

  const messageType =
    recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

  // ── Voicemail or Fax → always create a new update ────────────────────────────
  if (messageType !== 'SMS') {
    let body = '';
    if (messageType === 'Voicemail') {
      body = `Voicemail from ${contactInfo.name}<br><br>Recording:<br>${recordingLink}`;
    }
    if (messageType === 'Fax') {
      body = `Fax from ${contactInfo.name}<br><br>Document:<br>${faxDocLink}`;
    }

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
        itemId,
        body
      }
    );

    const newUpdateId = res.data.create_update.id;

    return {
      logId: newUpdateId,
      returnMessage: {
        message: 'Message logged',
        messageType: 'success',
        ttl: 1000
      }
    };
  }

  // ── SMS Thread ───────────────────────────────────────────────────────────────
  const existing = await mondayRequest(
    resolvedAccessToken,
    `
    query ($updateId: [ID!]) {
      updates(ids: $updateId) {
        id
        body
      }
    }
    `,
    { updateId: [updateId] }
  );

  const previousBody = existing?.data?.updates?.[0]?.body || '';
  const sender =
    message.direction === 'Inbound'
      ? contactInfo.name
      : 'You';
  const text = message.subject || message.text || '';
  const newLine =
    `<br>[${moment(message.creationTime || Date.now()).format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}<br>`;

  const messageLines = previousBody
    .split('<br>')
    .filter(l => l.includes(':'));
  const messageCount = messageLines.length;

  let updatedBody;
  let response;
  let newThreadId = updateId;

  if (messageCount >= MAX_THREAD_MESSAGES) {
    // Start a new thread
    updatedBody =
      `SMS conversation with ${contactInfo.name}<br>` +
      `[${moment(message.creationTime || Date.now()).format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}<br>`;
    response = await mondayRequest(
      resolvedAccessToken,
      `
      mutation ($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) {
          id
        }
      }
      `,
      {
        itemId,
        body: updatedBody
      }
    );

    newThreadId = response.data.create_update.id;
  } else {
    // Append to existing thread
    updatedBody = previousBody + newLine;
    response = await mondayRequest(
      resolvedAccessToken,
      `
      mutation ($updateId: ID!, $body: String!) {
        edit_update(id: $updateId, body: $body) {
          id
        }
      }
      `,
      {
        updateId,
        body: updatedBody
      }
    );
  }

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
        itemId,
        columnId: callLogsColumnId,
        value: updatedBody
      }
    );
  }

  if (recordingLink || faxDocLink) {
    const downloadUrl = recordingLink || faxDocLink;
    const fileName =
      recordingLink
        ? `Voicemail-${Date.now()}.mp3`
        : `Fax-${Date.now()}.pdf`;
    const s3Key = fileName;
    const s3Url = await downloadAudioFile(
      downloadUrl,
      process.env.S3_BUCKET,
      s3Key
    );

    await uploadToMonday({
      s3Url,
      accessToken: resolvedAccessToken,
      itemId,
      fileName,
      hostname: user.dataValues.hostname
    });
  }

  return {
    logId: newThreadId,
    returnMessage: {
      message: 'Message appended',
      messageType: 'success',
      ttl: 1000
    }
  };
}

module.exports = updateMessageLog;
