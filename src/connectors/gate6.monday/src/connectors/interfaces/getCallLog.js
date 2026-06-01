const { mondayRequest, parseMondayCallLogBody, validateLicenseOrFail } = require('../utils/mondayHelpers');

async function getCallLog({ callLogId, accessToken, authHeader, user }) {
  const licenseError = await validateLicenseOrFail(user)
  if (licenseError) return licenseError

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

  if (!callLogId) {
    return {
      callLogInfo: {},
      returnMessage: {
        messageType: 'error',
        message: 'Missing call log id for Monday fetch.',
        ttl: 3000
      }
    }
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
    { updateId: [callLogId] }
  )

  if (res?.errors?.length || !res?.data?.updates?.length) {
    return {
      callLogInfo: {},
      returnMessage: {
        messageType: 'error',
        message: res?.errors?.[0]?.message || 'Failed to fetch call log in Monday.',
        ttl: 3000
      }
    }
  }

  const update = res.data.updates[0]
  const rawBody = update.body || ''

  const { subject, agentNote } = parseMondayCallLogBody(rawBody)
  console.log('subject', subject)
  console.log('agentNote', agentNote)
  return {
    callLogInfo: {
      subject,           
      note: agentNote,   
      fullBody: rawBody,
      fullLogResponse: update
    },
    returnMessage: {
      messageType: 'success',
      message: 'Call log fetched',
      ttl: 3000
    }
  }
}

module.exports = getCallLog;
