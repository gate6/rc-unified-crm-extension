const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);
const { mondayRequest, getCompanyByHostname, downloadAudioFile, uploadToMonday } = require('../utils/mondayHelpers');
const s3Helper = require('../../monday-core/s3');

async function createMessageLog({
  user,
  contactInfo,
  message,
  recordingLink,
  faxDocLink,
  accessToken
}) {
  const resolvedAccessToken = accessToken || user?.accessToken

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname,
    models
  })

  const boardId = company.tenantId
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
      body = `Voicemail received`
      break

    case 'Fax':
      subject = `Fax from ${contactInfo.name}`
      body = `Fax document received`
      break
  }

  const fullBody = `${subject}\n${body}`

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
      body: fullBody
    }
  )

  if (!res?.data?.create_update?.id) {
    throw new Error('Failed to create message log in Monday')
  }

  const updateId = res.data.create_update.id

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
    logId: updateId,
    contactId: itemId,
    returnMessage: {
      message: 'Message logged in Monday',
      messageType: 'success',
      ttl: 1000
    }
  }
}

module.exports = createMessageLog;