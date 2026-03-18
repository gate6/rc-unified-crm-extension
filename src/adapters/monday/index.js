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


async function getLicenseStatus({ userId }) {
  try {
    console.log("License check hit", userId);

    const user = await UserModel.findByPk(userId);

    if (!user) {
      return {
        isLicenseValid: false,
        licenseStatus: "User Not Found",
        licenseStatusDescription: ""
      };
    }

    const company = await getCompanyByHostname({
      hostname: user.hostname,
      rcAccountId: user.rcAccountId
    });

    if (!company || company.status !== true) {
      return {
        isLicenseValid: false,
        licenseStatus: "Inactive",
        licenseStatusDescription: "Purchase license to continue"
      };
    }

    return {
      isLicenseValid: true,
      licenseStatus: "Active",
      licenseStatusDescription: "Basic"
    };

  } catch (error) {
    console.error("getLicenseStatus error:", error);

    return {
      isLicenseValid: false,
      licenseStatus: "Error",
      licenseStatusDescription: "Error validating license"
    };
  }
}

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
  const where = { hostname }
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
    const where = { hostname }
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
          messageType: 'warning',
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
        "Authorization": `Bearer ${accessToken}`,
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
            messageType: 'warning',
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
  const where = { hostname };
  if (rcAccountId) where.rcAccountId = rcAccountId;

  const company = await models.companies.findOne({ where, raw: true });

  return company || null;
}

function parseMondayCallLogBody(body = '') {

  const normalized = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .trim()

  const subject = normalized.match(/Subject:\s*(.*)/)?.[1]?.trim() || ''
  const direction = normalized.match(/Direction:\s*(.*)/)?.[1]?.trim() || ''
  const startTime = normalized.match(/Start Time:\s*(.*)/)?.[1]?.trim() || ''
  const endTime = normalized.match(/End Time:\s*(.*)/)?.[1]?.trim() || ''

  const result = normalized.match(/Result:\s*(.*)/)?.[1]?.trim() || ''
  const duration = normalized.match(/Duration:\s*(.*)/)?.[1]?.trim() || ''

  let agentNote = ''

  const agentMatch = normalized.match(
    /Agent Notes?:\s*([\s\S]*?)(?:\n[A-Z][^\n]*:|$)/i
  )

  if (agentMatch) {
    agentNote = agentMatch[1].trim()
  }

  return {
    subject,
    direction,
    startTime,
    endTime,
    result,
    duration,
    agentNote,
    normalizedBody: normalized
  }
}

async function findContact({ phoneNumber, accessToken, authHeader, user }) {

  const licenseStatus = await getLicenseStatus({ userId: user.dataValues.id });

    if (!licenseStatus.isLicenseValid) {
        return {
            successful: false,
            returnMessage: {
                message: 'License validation failed',
                messageType: 'error',
                details: [
                    {
                        title: 'License Issue',
                        items: [
                            {
                                id: '1',
                                type: 'text',
                                text: 'Please go to user settings page and refresh license status'
                            }
                        ]
                    }
                ],
                ttl: 5000
            }
        };
    }
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

  const licenseStatus = await getLicenseStatus({ userId: user.dataValues.id });

    if (!licenseStatus.isLicenseValid) {
        return {
            successful: false,
            returnMessage: {
                message: 'License validation failed',
                messageType: 'error',
                details: [
                    {
                        title: 'License Issue',
                        items: [
                            {
                                id: '1',
                                type: 'text',
                                text: 'Please go to user settings page and refresh license status'
                            }
                        ]
                    }
                ],
                ttl: 5000
            }
        };
    }

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

async function createCallLog({
  contactInfo,
  callLog,
  note,
  aiNote,
  transcript,
  accessToken,
  authHeader,
  user
}) {

  const licenseStatus = await getLicenseStatus({ userId: user.dataValues.id });

    if (!licenseStatus.isLicenseValid) {
        return {
            successful: false,
            returnMessage: {
                message: 'License validation failed',
                messageType: 'error',
                details: [
                    {
                        title: 'License Issue',
                        items: [
                            {
                                id: '1',
                                type: 'text',
                                text: 'Please go to user settings page and refresh license status'
                            }
                        ]
                    }
                ],
                ttl: 5000
            }
        };
    }

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
  })

  const boardId = company.tenantId

  const subject =
    callLog.customSubject ??
    `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name}`

  let sections = []

  if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
    sections.push(`Agent Notes:\n${note}`)
  }

  if (callLog?.result && (user.userSettings?.addCallLogResult?.value ?? true)) {
    sections.push(`Result:\n${callLog.result}`)
  }

  if (callLog?.duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
    sections.push(`Duration:\n${callLog.duration} sec`)
  }

  if (callLog?.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) {
    sections.push(`Recording:\n${callLog.recording.link}`)
  }

  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
    sections.push(`AI Note:\n${aiNote}`)
  }

  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
    sections.push(`Transcript:\n${transcript}`)
  }

  const optionalSections = sections.join("\n\n")

  const body = `
Subject: ${subject}
Direction: ${callLog.direction}
Start Time: ${moment(callLog.startTime).format("YYYY-MM-DD HH:mm:ss")}
End Time: ${moment(callLog.startTime).add(callLog.duration, "seconds").format("YYYY-MM-DD HH:mm:ss")}

${optionalSections}
`.trim()

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

  const updateId = res.data.create_update.id

  // ---- Recording Upload ----
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
      message: "Call log created",
      messageType: "success",
      ttl: 2000
    }
  }
}

async function updateCallLog({
  existingCallLog,
  recordingLink,
  note,
  aiNote,
  transcript,
  accessToken,
  authHeader,
  user
}) {

  const licenseStatus = await getLicenseStatus({ userId: user.dataValues.id });

    if (!licenseStatus.isLicenseValid) {
        return {
            successful: false,
            returnMessage: {
                message: 'License validation failed',
                messageType: 'error',
                details: [
                    {
                        title: 'License Issue',
                        items: [
                            {
                                id: '1',
                                type: 'text',
                                text: 'Please go to user settings page and refresh license status'
                            }
                        ]
                    }
                ],
                ttl: 5000
            }
        };
    }

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

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
  )

  const oldBody = res?.data?.updates?.[0]?.body || ''

  const parsed = parseMondayCallLogBody(oldBody)

  let sections = []

  if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
    sections.push(`Agent Notes:\n${note}`)
  }

  if (parsed.result && (user.userSettings?.addCallLogResult?.value ?? true)) {
    sections.push(`Result:\n${parsed.result}`)
  }

  if (parsed.duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
    sections.push(`Duration:\n${parsed.duration}`)
  }

  if (recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) {
    sections.push(`Recording:\n${recordingLink}`)
  }

  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
    sections.push(`AI Note:\n${aiNote}`)
  }

  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
    sections.push(`Transcript:\n${transcript}`)
  }

  const optionalSections = sections.join("\n\n")

  const body = `
Subject: ${parsed.subject}
Direction: ${parsed.direction}
Start Time: ${parsed.startTime}
End Time: ${parsed.endTime}

${optionalSections}
`.trim()

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
  )

  return {
    logId: updateRes.data.edit_update.id,
    returnMessage: {
      message: "Call log updated",
      messageType: "success",
      ttl: 2000
    }
  }
}

async function getCallLog({ callLogId, accessToken, authHeader, user }) {

  const resolvedAccessToken =
    authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken

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

  if (!res?.data?.updates?.length) {
    return {
      callLogInfo: {},
      returnMessage: {
        messageType: 'error',
        message: 'Failed to fetch call log',
        ttl: 3000
      }
    }
  }

  const update = res.data.updates[0]
  const rawBody = update.body || ''

  const parsed = parseMondayCallLogBody(rawBody)

  return {
    callLogInfo: {
      subject: parsed.subject,
      note: parsed.agentNote,
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

  const licenseStatus = await getLicenseStatus({ userId: user.dataValues.id });

    if (!licenseStatus.isLicenseValid) {
        return {
            successful: false,
            returnMessage: {
                message: 'License validation failed',
                messageType: 'error',
                details: [
                    {
                        title: 'License Issue',
                        items: [
                            {
                                id: '1',
                                type: 'text',
                                text: 'Please go to user settings page and refresh license status'
                            }
                        ]
                    }
                ],
                ttl: 5000
            }
        };
    }

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

  const messageType =
    recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS')

  let body = ""

  if (messageType === "SMS") {

    const sender =
      message.direction === 'Inbound'
        ? contactInfo.name
        : 'You'

    const text = message.subject || message.text || ''

    body = `SMS conversation with ${contactInfo.name}\n`
    body += `[${moment(message.creationTime || Date.now()).format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}\n`

  }

  else if (messageType === "Voicemail") {

    body =
      `Voicemail from ${contactInfo.name}

Recording:
${recordingLink}
`

  }

  else if (messageType === "Fax") {

    body =
      `Fax from ${contactInfo.name}

Document:
${faxDocLink}
`

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

  const licenseStatus = await getLicenseStatus({ userId: user.dataValues.id });

    if (!licenseStatus.isLicenseValid) {
        return {
            successful: false,
            returnMessage: {
                message: 'License validation failed',
                messageType: 'error',
                details: [
                    {
                        title: 'License Issue',
                        items: [
                            {
                                id: '1',
                                type: 'text',
                                text: 'Please go to user settings page and refresh license status'
                            }
                        ]
                    }
                ],
                ttl: 5000
            }
        };
    }

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

  const messageType =
    recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS')

  // ------------------------------------------------
  // VOICEMAIL OR FAX → always create new update
  // ------------------------------------------------

  if (messageType !== "SMS") {

    let body = ""

    if (messageType === "Voicemail") {

      body =
        `Voicemail from ${contactInfo.name}

Recording:
${recordingLink}
`

    }

    if (messageType === "Fax") {

      body =
        `Fax from ${contactInfo.name}

Document:
${faxDocLink}
`

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

    const newUpdateId = res.data.create_update.id

    return {
      logId: newUpdateId,
      returnMessage: {
        message: 'Message logged',
        messageType: 'success',
        ttl: 1000
      }
    }
  }

  // ------------------------------------------------
  // SMS THREAD
  // ------------------------------------------------

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

  const newLine =
    `\n[${moment(message.creationTime || Date.now()).format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}\n`

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
      `[${moment(message.creationTime || Date.now()).format('YYYY-MM-DD HH:mm:ss')}] ${sender}: ${text}\n`

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
exports.getLicenseStatus = getLicenseStatus;