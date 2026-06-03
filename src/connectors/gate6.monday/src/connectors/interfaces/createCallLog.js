const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);
const { mondayRequest, getOrCreateCallLogsColumn, getCompanyByHostname, downloadAudioFile, uploadToMonday, validateLicenseOrFail } = require('../utils/mondayHelpers');
const s3Helper = require('../../monday-core/s3');

async function createCallLog({ contactInfo, callLog, note, aiNote, transcript, composedLogDetails, accessToken, authHeader, user }) {
  const licenseError = await validateLicenseOrFail(user)
  if (licenseError) return licenseError

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname,
    models
  })
  const boardId = company.tenantId

  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  })

  const activityTitle =
    composedLogDetails ||
    callLog?.subject ||
    callLog?.activity ||
    `${callLog?.direction || 'Call'} Call`

  let body = `${activityTitle}\n`
  body += `Result: ${callLog?.result || ''}\n`
  body += `Duration: ${callLog?.duration ?? ''}s\n`

  if (note) body += `\nAgent Note:\n${note}\n`
  if (aiNote) body += `\nAI Note:\n${aiNote}\n`
  if (transcript) body += `\nTranscript:\n${transcript}\n`

  if (callLog?.recording?.link) {
    body += `Recording:\n${callLog.recording.link}\n`
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
      itemId: Number(contactInfo.id),
      body
    }
  )

  if (res?.errors?.length || !res?.data?.create_update?.id) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: res?.errors?.[0]?.message || 'Failed to create call log in Monday.',
        ttl: 3000
      }
    }
  }

  const updateId = res.data.create_update.id

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
    )
  }

  if (callLog?.recording?.downloadUrl) {
    const fileName = `Call-${Date.now()}.mp3`
    const s3Key = fileName

    const s3Url = await downloadAudioFile(
      callLog.recording.downloadUrl,
      process.env.S3_BUCKET,
      s3Key
    )

    await uploadToMonday({
      s3Url,
      accessToken: resolvedAccessToken,
      itemId: Number(contactInfo.id),
      fileName,
      hostname: user.dataValues.hostname,
      models,
      s3Helper
    })
  }

  return {
    logId: updateId,
    contactId: Number(contactInfo.id),
    returnMessage: {
      messageType: 'success',
      message: 'Call log created',
      ttl: 3000
    }
  }
}

module.exports = createCallLog;