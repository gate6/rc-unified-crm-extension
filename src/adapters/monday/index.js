const axios = require('axios')
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber')
const { saveUserInfo } = require('../servicenow-core/auth');
const { initModels } = require('../servicenow-models/init-models');
const { sequelize } = require('../servicenow-models/sequelize');
const { UserModel } = require('@app-connect/core/models/userModel');
const models = initModels(sequelize);
const Sequelize = require('sequelize');
const { env } = require('shelljs');
const Op = require('sequelize').Op;
const FormData = require('form-data')
const s3Helper = require('../servicenow-core/s3');
const AWS = require('aws-sdk');


const MONDAY_API_URL = process.env.MONDAY_API_URL;
const MONDAY_AUTHORIZE_URL = process.env.MONDAY_AUTHORIZE_URL;
var MONDAY_CLIENT_SECRET = '';
var MONDAY_CLIENT_ID = '';
var MONDAY_REDIRECT_URI = '';
const columnIdCache = new Map();

async function mondayRequest(accessToken, query, variables = {}) {
  const res = await axios.post(
    MONDAY_API_URL,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  )
  return res.data
}

async function getOrCreateCallLogsColumn({
  accessToken,
  boardId,
  columnName = 'Call Logs'
}) {
  let columnId = await getColumnIdByName({
    accessToken,
    boardId,
    columnName
  })

  if (columnId) {
    return columnId
  }

  const res = await mondayRequest(
    accessToken,
    `
    mutation ($boardId: ID!, $title: String!) {
      create_column(
        board_id: $boardId,
        title: $title,
        column_type: long_text
      ) {
        id
      }
    }
    `,
    {
      boardId: Number(boardId),
      title: columnName
    }
  )

  if (!res?.data?.create_column?.id) {
    throw new Error('Failed to create "Call Logs" column in Monday')
  }

  const newColumnId = res.data.create_column.id

  columnIdCache.set(`${boardId}:${columnName}`, newColumnId)

  return newColumnId
}

async function getOrCreateFilesColumn({
  accessToken,
  boardId,
  columnName = 'Files'
}) {
  let columnId = await getColumnIdByName({
    accessToken,
    boardId,
    columnName
  })

  if (columnId) {
    return columnId
  }

  const res = await mondayRequest(
    accessToken,
    `
    mutation ($boardId: ID!, $title: String!) {
      create_column(
        board_id: $boardId,
        title: $title,
        column_type: file
      ) {
        id
      }
    }
    `,
    {
      boardId: Number(boardId),
      title: columnName
    }
  )

  if (!res?.data?.create_column?.id) {
    throw new Error('Failed to create "Files" column in Monday')
  }

  const newColumnId = res.data.create_column.id

  // same cache pattern as Call Logs
  columnIdCache.set(`${boardId}:${columnName}`, newColumnId)

  return newColumnId
}

async function getColumnIdByName({ accessToken, boardId, columnName }) {
  if (!columnName) {
    return null
  }
  if (typeof columnName === 'string' && columnName.trim()) {
    const trimmedName = columnName.trim()
    if (trimmedName !== columnName) {
      columnName = trimmedName
    }
  }
  const cacheKey = `${boardId}:${columnName}`
  if (columnIdCache.has(cacheKey)) {
    return columnIdCache.get(cacheKey)
  }

  const res = await mondayRequest(
    accessToken,
    `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        columns {
          id
          title
        }
      }
    }
    `,
    { boardId: Number(boardId) }
  )
  const boardData = res?.data?.boards?.[0]
  const columns = boardData?.columns || []
  if (!columns.length) {
    console.log('Monday board lookup returned no columns', {
      boardId,
      errors: res?.errors,
      boardData
    })
  }

  const normalizedName = columnName?.toLowerCase()
  const matched = columns.find(col => {
    const title = col.title?.trim()?.toLowerCase()
    return title === normalizedName || col.id === columnName
  })

  if (matched?.id) {
    columnIdCache.set(cacheKey, matched.id)
    return matched.id
  }
  console.log('Monday column not found', {
    boardId,
    columnName,
    availableColumns: columns.map(col => ({ id: col.id, title: col.title }))
  })
  return null
}

function normalizePhone(phone) {
  const p = parsePhoneNumber(phone)
  return p?.valid ? p.number.e164 : null
}

function getAuthType() {
  return 'oauth'
}

async function getOauthInfo({ hostname, rcAccountId }) {
  const where = { hostname, status: "true" }
  if (rcAccountId) {
    where.rcAccountId = rcAccountId
  }
  const company = await models.companies.findOne({
    where
  })

  if (!company) {
    throw new Error('Company not found or inactive')
  }
  MONDAY_CLIENT_SECRET = company.clientSecret
  MONDAY_CLIENT_ID = company.clientId
  MONDAY_REDIRECT_URI = company.crmRedirectUrl 
  return {
    clientId: company.clientId,
    clientSecret: company.clientSecret,
    authorizationUri: MONDAY_AUTHORIZE_URL,
    accessTokenUri: company.tokenUrl,
    redirectUri: company.crmRedirectUrl,
    scopes: ['me:read', 'users:read', 'boards:read', 'boards:write', 'updates:write'],
  }
}

function getOverridingOAuthOption({ code }) {
  return {
    query: {
      grant_type: 'authorization_code',
      client_id: MONDAY_CLIENT_ID,
      client_secret: MONDAY_CLIENT_SECRET,
      redirect_uri: MONDAY_REDIRECT_URI,
      code: code,
    },
    headers: {
      Authorization: ''
    }
  }
}

async function getUserInfo({ authHeader, hostname, query }) {
  try {
    const callbackUri = query.callbackUri;
    const code = new URL(callbackUri).searchParams.get('code');
    const where = { hostname, status: "true" }
    if (query.rcAccountId) {
      where.rcAccountId = query.rcAccountId
    }
    const company = await models.companies.findOne({
      where,
      include: [{ model: models.customer, as: 'customers', required: false }],
      raw: false,
      logging: false
    });

    // Company not found
    if (!company) {
      return {
        successful: false,
        platformUserInfo: {
          id: "",
          name: "",
          timezoneName: "",
          timezoneOffset: "",
          platformAdditionalInfo: {}
        },
        returnMessage: {
          messageType: 'danger',
          message: 'Could not find the company details.',
          ttl: 3000
        }
      };
    }

    const {
      clientId,
      clientSecret,
      maxAllowedUsers,
      status,
      customers = []
    } = company;

    // Config validation
    if (!clientId || !clientSecret) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: 'Monday configuration incomplete.',
          ttl: 3000
        }
      };
    }

    // License inactive
    if (status !== true) {
      return {
        successful: false,
        platformUserInfo: {
          id: "",
          name: "",
          timezoneName: "",
          timezoneOffset: "",
          platformAdditionalInfo: {}
        },
        returnMessage: {
          messageType: 'danger',
          message: 'You do not have an active license. Please contact us.',
          ttl: 3000
        }
      };
    }
    const accessToken = authHeader.replace('Bearer ', '');
    if (!accessToken) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: 'Failed to get access token.',
          ttl: 3000
        }
      };
    }

    const userDataResponse = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`, // 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: "query { me { id name email } }"
      })
    });

    const result = await userDataResponse.json();

    // 
    if (!result?.data?.me) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: 'Failed to get user data.',
          ttl: 3000
        }
      };
    }

    // 
    const userData = {
      id: result.data.me.id,
      name: result.data.me.name,
      email: result.data.me.email
    };

    let customer = customers.find(c => c.email === userData.email);
    // Create user if not exists
    if (!customer) {
      if (customers.length >= maxAllowedUsers) {
        return {
          successful: false,
          platformUserInfo: {
            id: "",
            name: "",
            timezoneName: "",
            timezoneOffset: "",
            platformAdditionalInfo: {}
          },
          returnMessage: {
            messageType: 'danger',
            message: `You are not having an active license. Please contact us.`,
            ttl: 3000
          }
        };
      }

      await models.customer.create({
        sysId: userData.id,
        email: userData.email,
        companyId: company.id,
        hostname: hostname,
        accessToken: accessToken,
        tokenExpiry: Date.now() + (365 * 24 * 60 * 60 * 1000),
        platformAdditionalInfo: {
          client_id: clientId,
          client_secret: clientSecret,
          expiresAt: Date.now() + (365 * 24 * 60 * 60 * 1000)
        },
        status: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    return {
      successful: true,
      platformUserInfo: {
        id: userData.id,
        name: userData.name,
        email: userData.email,
        overridingApiKey: accessToken,

        platformAdditionalInfo: {
          client_id: clientId,
          client_secret: clientSecret,
          expiresAt: Date.now() + ((900 - 60) * 1000) // 15 min - 1 min buffer
        }
      },
      returnMessage: {
        messageType: 'success',
        message: 'Successfully connected to Monday.',
        ttl: 3000
      }
    };

  } catch (err) {
    console.error('AUTO MONDAY LOGIN ERROR:', err?.response?.data || err.message);

    return {
      successful: false,
      returnMessage: {
        messageType: 'error',
        message: 'Automatic Monday authentication failed.',
        ttl: 3000
      }
    };
  }
}

async function unAuthorize() {
  return {
    returnMessage: {
      messageType: 'success',
      message: 'Disconnected from Monday',
      ttl: 3000
    }
  }
}

async function getCompanyByHostname({ hostname, rcAccountId }) {
  const where = { hostname, status: "true" }
  if (rcAccountId) where.rcAccountId = rcAccountId

  const company = await models.companies.findOne({ where, raw: true })

  if (!company) {
    throw new Error('Company not found or inactive')
  }
  return company
}

function parseMondayCallLogBody(body = '') {
  
  const normalized = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+(>|$)/g, '') 
    .trim()

  const lines = normalized
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  
  const subject = lines[0] || ''

  
  let agentNote = ''
  const agentNoteIndex = lines.findIndex(l =>
    /^agent note:/i.test(l)
  )

  if (agentNoteIndex !== -1) {
    for (let i = agentNoteIndex + 1; i < lines.length; i++) {
      const line = lines[i]

      // Stop at next known section
      if (
        /^result:/i.test(line) ||
        /^duration:/i.test(line) ||
        /^recording:/i.test(line) ||
        /^ai note:/i.test(line) ||
        /^transcript:/i.test(line)
      ) {
        break
      }

      agentNote += (agentNote ? '\n' : '') + line
    }
  }

  return {
    subject,
    agentNote,
    normalizedBody: normalized
  }
}

async function findContact({ phoneNumber, accessToken, authHeader, user }) {
  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
  })
  const boardId = company.tenantId
  const phone = normalizePhone(phoneNumber)
  const matchedContactInfo = []
  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  const phoneColumnId = await getColumnIdByName({
    accessToken: resolvedAccessToken,
    boardId: boardId,
    columnName: 'Phone'
  })
  if (!phoneColumnId) {
    return {
      successful: false,
      returnMessage: {
        messageType: 'error',
        message: 'Monday phone column not found. Set MONDAY_PHONE_COLUMN_ID or MONDAY_PHONE_COLUMN_NAME.',
        ttl: 3000
      }
    }
  }

  if (phone) {
    const res = await mondayRequest(
      resolvedAccessToken,

      `
      query ($value: String!) {
        items_page_by_column_values(
          board_id: ${boardId},
          columns: [{ column_id: "${phoneColumnId}", column_values: [$value] }]
        ) {
          items {
            id
            name
          }
        }
      }
      `,
      { value: phone }
    )
    const items = res?.data?.items_page_by_column_values?.items
    if (res?.errors?.length || !items) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: res?.errors?.[0]?.message || 'Failed to fetch contacts from Monday.',
          ttl: 3000
        }
      }
    }

    for (const item of items || []) {
      matchedContactInfo.push({
        id: item.id,
        name: item.name,
        phone
      })
    }
  }

  matchedContactInfo.push({
    id: 'createNewContact',
    name: 'Create new contact...',
    isNewContact: true
  })

  return {
    successful: true,
    matchedContactInfo
  }
}

async function findContactWithName() {
  return {
    successful: true,
    matchedContactInfo: []
  }
}

async function createContact({ phoneNumber, newContactName, accessToken, authHeader, user }) {
  const company = await getCompanyByHostname({
  hostname: user.dataValues.hostname
})
const boardId = company.tenantId

  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  const phoneColumnId = await getColumnIdByName({
    accessToken: resolvedAccessToken,
    boardId: boardId,
    columnName: 'Phone'
  })
  if (!phoneColumnId) {
    return {
      contactInfo: null,
      returnMessage: {
        messageType: 'error',
        message: 'Monday phone column not found. Set MONDAY_PHONE_COLUMN_ID or MONDAY_PHONE_COLUMN_NAME.',
        ttl: 3000
      }
    }
  }

  const res = await mondayRequest(
    resolvedAccessToken,

    `
    mutation ($name: String!, $values: JSON!) {
      create_item(
        board_id: ${boardId},
        item_name: $name,
        column_values: $values
      ) {
        id
        name
      }
    }
    `,
    {
      name: newContactName,
      values: JSON.stringify({
        [phoneColumnId]: phoneNumber
      })
    }
  )

  return {
    contactInfo: {
      id: res.data.create_item.id,
      name: res.data.create_item.name
    },
    returnMessage: {
      messageType: 'success',
      message: 'New contact created',
      ttl: 3000
    }
  }
}

async function createCallLog({contactInfo, callLog, note, aiNote, transcript, composedLogDetails, accessToken, authHeader, user}) {
  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

  const company = await getCompanyByHostname({
  hostname: user.dataValues.hostname
})
const boardId = company.tenantId

  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  })


  // -----------------------------
  // Activity title (RC parity)
  // -----------------------------
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

  // -----------------------------
  // Create update (comment)
  // -----------------------------
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


  // -----------------------------
  // Upload recording to Files column
  // -----------------------------
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
      hostname: user.dataValues.hostname
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

async function updateCallLog({existingCallLog, callLog, note, aiNote, transcript, recordingLink, duration, result, composedLogDetails, accessToken, authHeader, user}) {
  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
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
      hostname: user.dataValues.hostname
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

async function getCallLog({ callLogId, accessToken, authHeader, user }) {
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

async function upsertCallDisposition({ existingCallLog }) {
  return { logId: existingCallLog.thirdPartyLogId }
}

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
    hostname: user.dataValues.hostname
  })

  const boardId = company.tenantId
  const itemId = Number(contactInfo.id)

  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  })

  const sender =
    message.direction === 'Inbound'
      ? contactInfo.name
      : 'You'

  const text = message.subject || message.text || ''

  let body = `SMS conversation with ${contactInfo.name}\n`

  body += `[${moment().format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}\n`

  if (recordingLink) {
    body += `Recording:\n${recordingLink}\n`
  }

  if (faxDocLink) {
    body += `Fax Document:\n${faxDocLink}\n`
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
  )

  if (!res?.data?.create_update?.id) {
    throw new Error('Failed to create message log')
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
        itemId,
        columnId: callLogsColumnId,
        value: body
      }
    )
  }

  if (recordingLink || faxDocLink) {

    const downloadUrl = recordingLink || faxDocLink

    const fileName =
      recordingLink
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
      hostname: user.dataValues.hostname
    })
  }

  return {
    logId: updateId,
    contactId: itemId,
    returnMessage: {
      message: 'Message thread created',
      messageType: 'success',
      ttl: 1000
    }
  }
}




async function updateMessageLog({
  user,
  contactInfo,
  existingMessageLog,
  message,
  recordingLink,
  faxDocLink,
  accessToken
}) {

  const MAX_THREAD_MESSAGES = 10
  const resolvedAccessToken = accessToken || user?.accessToken

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
  })

  const boardId = company.tenantId
  const itemId = Number(contactInfo.id)
  const updateId = existingMessageLog.thirdPartyLogId

  const callLogsColumnId = await getOrCreateCallLogsColumn({
    accessToken: resolvedAccessToken,
    boardId,
    columnName: 'Call Logs'
  })

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
  )

  const previousBody =
    existing?.data?.updates?.[0]?.body || ''

  const sender =
    message.direction === 'Inbound'
      ? contactInfo.name
      : 'You'

  const text = message.subject || message.text || ''

  let newLine =
`\n[${moment().format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}\n`

  if (recordingLink) {
    newLine += `Recording:\n${recordingLink}\n`
  }

  if (faxDocLink) {
    newLine += `Fax Document:\n${faxDocLink}\n`
  }

  const messageLines =
    previousBody
      .split('\n')
      .filter(l => l.includes(':'))

  const messageCount = messageLines.length

  let updatedBody
  let response
  let newThreadId = updateId

  if (messageCount >= MAX_THREAD_MESSAGES) {

    updatedBody =
      `SMS conversation with ${contactInfo.name}\n` +
      `[${moment().format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}\n`

    if (recordingLink) {
      updatedBody += `Recording:\n${recordingLink}\n`
    }

    if (faxDocLink) {
      updatedBody += `Fax Document:\n${faxDocLink}\n`
    }

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
    )

    newThreadId = response.data.create_update.id

  } else {

    updatedBody = previousBody + newLine

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
    )
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
    )
  }

  if (recordingLink || faxDocLink) {

    const downloadUrl = recordingLink || faxDocLink

    const fileName =
      recordingLink
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
      hostname: user.dataValues.hostname
    })
  }

  return {
    logId: newThreadId,
    returnMessage: {
      message: 'Message appended',
      messageType: 'success',
      ttl: 1000
    }
  }
}

async function getUserList() {
  return {
    successful: true,
    userList: []
  }
}

async function downloadAudioFile(url, s3Bucket, s3Key) {
    const urlObj = new URL(url);
    const accessToken = urlObj.searchParams.get("accessToken");
    const s3Values = {
        accessKeyId: process.env.MEDIA_UPLOAD_KEY_ID,
        secretAccessKey: process.env.MEDIA_UPLOAD_SECRET_KEY,
        region: process.env.AWS_REGION
    };
    const s3 = new AWS.S3(s3Values);

    console.log("Downloading Audio File...");

    try {

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            responseType: "stream",
        });

        const uploadParams = {
            Bucket: s3Bucket,
            Key: s3Key,
            Body: response.data
          };

        const uploadResult = await s3.upload(uploadParams).promise();

        return uploadResult.Location;

    } catch (error) {
        console.log("Error downloading or uploading audio:", error);
    }
}

async function uploadToMonday({
  s3Url,
  accessToken,
  itemId,
  fileName,
  hostname
}) {

  if (!hostname) {
    throw new Error('uploadToMonday: hostname is missing')
  }
  const company = await getCompanyByHostname({ hostname })
  const boardId = company.tenantId

  try {
    console.log('Uploading file to Monday...')

    const filesColumnId = await getOrCreateFilesColumn({
      accessToken,
      boardId
    })

    if (!filesColumnId) {
      throw new Error('Files column not found on Monday board')
    }

    const s3Key = decodeURIComponent(new URL(s3Url).pathname.substring(1))
    const fileStream = await s3Helper.getObject(s3Key, 'audio')

    const formData = new FormData()

    formData.append(
      'query',
      `
      mutation ($file: File!) {
        add_file_to_column(
          item_id: ${Number(itemId)},
          column_id: "${filesColumnId}",
          file: $file
        ) {
          id
        }
      }
      `
    )

    formData.append('variables[file]', fileStream, {
      filename: fileName,
      contentType: 'audio/mpeg'
    })

    const response = await axios.post(
      'https://api.monday.com/v2/file',
      formData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity
      }
    )

    console.log('File uploaded to Monday:', response.data)

    await s3Helper.deleteObject(s3Key, 'audio')
    console.log('File deleted from S3:', s3Key)

    return response.data
  } catch (error) {
    console.log(
      'Error uploading file to Monday:',
      error?.response?.data || error.message
    )
    throw error
  }
}


exports.getAuthType = getAuthType;
exports.getOauthInfo = getOauthInfo;
exports.getUserInfo = getUserInfo;
exports.unAuthorize = unAuthorize;
exports.findContact = findContact;
exports.findContactWithName = findContactWithName;
exports.createContact = createContact;
exports.createCallLog = createCallLog;
exports.updateCallLog = updateCallLog;
exports.getCallLog = getCallLog;
exports.upsertCallDisposition = upsertCallDisposition;
exports.createMessageLog = createMessageLog;
exports.updateMessageLog = updateMessageLog;
exports.getUserList = getUserList;
exports.getOverridingOAuthOption = getOverridingOAuthOption;