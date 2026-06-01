const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);
const { mondayRequest, getCompanyByHostname, downloadAudioFile, uploadToMonday, validateLicenseOrFail } = require('../utils/mondayHelpers');
const s3Helper = require('../../monday-core/s3');

async function updateMessageLog({
  user,
  contactInfo,
  existingMessageLog,
  message,
  recordingLink,
  faxDocLink,
  accessToken,
  authHeader
}) {
  const licenseError = await validateLicenseOrFail(user)
  if (licenseError) return licenseError

  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

  if (!existingMessageLog?.thirdPartyLogId) {
    throw new Error('Missing message log id for Monday update')
  }

  const itemId = Number(contactInfo.id)

  const messageType = recordingLink
    ? 'Voicemail'
    : faxDocLink
      ? 'Fax'
      : 'SMS'

  let subject = ''
  let body = ''

  switch (messageType) {
    case 'SMS':
      subject = `SMS conversation with ${contactInfo.name}`
      body =
        `SMS ${message.direction === 'Inbound' ? 'from' : 'to'} ${contactInfo.name}\n` +
        `Message: ${message.subject || message.text || ''}`
      break

    case 'Voicemail':
      subject = `Voicemail from ${contactInfo.name}`
      body = `Voicemail updated`
      break

    case 'Fax':
      subject = `Fax from ${contactInfo.name}`
      body = `Fax document updated`
      break
  }

  const fullBody = `${subject}\n${body}`

  
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
      updateId: existingMessageLog.thirdPartyLogId,
      body: fullBody
    }
  )

  if (!res?.data?.edit_update?.id) {
    throw new Error('Failed to update message log in Monday')
  }

  if (recordingLink || faxDocLink) {
    const downloadUrl = recordingLink || faxDocLink
    const fileName =
      messageType === 'Voicemail'
        ? `Voicemail-${Date.now()}.mp3`
        : `Fax-${Date.now()}.pdf`

    const s3Key = fileName

    const s3Url = await downloadAudioFile(
      downloadUrl,
      process.env.S3_BUCKET,
      s3Key
    )

    await uploadToMonday({
      s3Url,
      accessToken: resolvedAccessToken,
      itemId,
      fileName,
      hostname: user.dataValues.hostname,
      models,
      s3Helper
    })
  }

  return {
    logId: res.data.edit_update.id,
    returnMessage: {
      message: 'Message updated in Monday',
      messageType: 'success',
      ttl: 1000
    }
  }
}

module.exports = updateMessageLog;
