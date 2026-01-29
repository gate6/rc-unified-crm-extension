const axios = require('axios');
const { parsePhoneNumber } = require('awesome-phonenumber');
const FormData = require('form-data');
const AWS = require('aws-sdk');
const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_AUTHORIZE_URL = 'https://auth.monday.com/oauth2/authorize';
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

async function getCompanyByHostname({ hostname, rcAccountId }) {
  const where = { hostname, status: "true" }
  if (rcAccountId) where.rcAccountId = rcAccountId

  const company = await models.companies.findOne({ where, raw: true })

  if (!company) {
    throw new Error('Company not found or inactive')
  }
  return company
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
  console.log('HOSTNAME : ', hostname)

  if (!hostname) {
    throw new Error('uploadToMonday: hostname is missing')
  }
  const company = await getCompanyByHostname({ hostname })
  const boardId = company.tenantId

  try {
    console.log('Uploading file to Monday...')

    const filesColumnId = await getColumnIdByName({
      accessToken,
      boardId,
      columnName: 'Files'
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

module.exports = {
  MONDAY_API_URL,
  MONDAY_AUTHORIZE_URL,
  mondayRequest,
  getOrCreateCallLogsColumn,
  getColumnIdByName,
  normalizePhone,
  parseMondayCallLogBody,
  getCompanyByHostname,
  downloadAudioFile,
  uploadToMonday
};
