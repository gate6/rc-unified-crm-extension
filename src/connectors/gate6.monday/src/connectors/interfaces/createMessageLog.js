const {
  moment,
  mondayRequest,
  getCompanyByHostname,
  getOrCreateCallLogsColumn,
  downloadAudioFile,
  uploadToMonday,
  validateLicenseOrFail
} = require('../utils/mondayHelpers');

async function createMessageLog({ user, contactInfo, message, recordingLink, faxDocLink, accessToken, authHeader }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken;

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
  });
  const boardId = company.tenantId;
  const itemId = Number(contactInfo.id);

  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  });

  const messageType =
    recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');
  let body = '';

  if (messageType === 'SMS') {
    const sender =
      message.direction === 'Inbound'
        ? contactInfo.name
        : 'You';
    const text = message.subject || message.text || '';
    body = `SMS conversation with ${contactInfo.name}<br>`;
    body += `[${moment(message.creationTime || Date.now()).format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}<br>`;
  } else if (messageType === 'Voicemail') {
    body = `Voicemail from ${contactInfo.name}<br><br>Recording:<br>${recordingLink}`;
  } else if (messageType === 'Fax') {
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

  if (!res?.data?.create_update?.id) {
    throw new Error('Failed to create message log');
  }

  const updateId = res.data.create_update.id;

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
        value: body
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
    logId: updateId,
    contactId: itemId,
    returnMessage: {
      message: 'Message thread created',
      messageType: 'success',
      ttl: 1000
    }
  };
}

module.exports = createMessageLog;
