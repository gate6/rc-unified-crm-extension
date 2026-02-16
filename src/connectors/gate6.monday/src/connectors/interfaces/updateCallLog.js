const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);
const { mondayRequest, getOrCreateCallLogsColumn, getCompanyByHostname, downloadAudioFile, uploadToMonday } = require('../utils/mondayHelpers');
const s3Helper = require('../../monday-core/s3');

async function updateCallLog({ existingCallLog, callLog, note, aiNote, transcript, recordingLink, duration, result, composedLogDetails, accessToken, authHeader, user }) {
  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname,
    models
  })
  const boardId = company.tenantId
  
  if (!existingCallLog?.thirdPartyLogId) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: 'Missing call log id for Monday update.',
        ttl: 3000
      }
    }
  }

  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  })

  const activityTitle =
    composedLogDetails ||
    callLog?.subject ||
    callLog?.activity ||
    `${callLog?.direction || existingCallLog?.direction || 'Call'} Call`

  let body = `${activityTitle}\n`

  const resolvedResult = callLog?.result ?? result ?? existingCallLog?.result
  const resolvedDuration =
    callLog?.duration ?? duration ?? existingCallLog?.duration

  body += `Result: ${resolvedResult || ''}\n`
  body += `Duration: ${resolvedDuration ?? ''}s\n`

  if (note) body += `\nAgent Note:\n${note}\n`
  if (aiNote) body += `\nAI Note:\n${aiNote}\n`
  if (transcript) body += `\nTranscript:\n${transcript}\n`

  const resolvedRecordingLink =
    callLog?.recording?.downloadUrl ||
    recordingLink ||
    existingCallLog?.recording?.downloadUrl

  if (resolvedRecordingLink) {
    body += `Recording:\n${resolvedRecordingLink}\n`
  }

  const res = await mondayRequest(
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
  )

  if (res?.errors?.length || !res?.data?.edit_update?.id) {
    return {
      logId: null,
      returnMessage: {
        messageType: 'error',
        message: res?.errors?.[0]?.message || 'Failed to update call log in Monday.',
        ttl: 3000
      }
    }
  }

  if (callLogsColumnId && existingCallLog.contactId) {
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
    )
  }

  if (resolvedRecordingLink && existingCallLog.contactId) {
    const fileName = `Call-${Date.now()}.mp3`
    const s3Key = fileName

    const s3Url = await downloadAudioFile(
      resolvedRecordingLink,
      process.env.S3_BUCKET,
      s3Key
    )

    await uploadToMonday({
      s3Url,
      accessToken: resolvedAccessToken,
      itemId: Number(existingCallLog.contactId),
      fileName,
      hostname: user.dataValues.hostname,
      models,
      s3Helper
    })
  }

  return {
    logId: res.data.edit_update.id,
    returnMessage: {
      messageType: 'success',
      message: 'Call log updated',
      ttl: 3000
    }
  }
}

module.exports = updateCallLog;