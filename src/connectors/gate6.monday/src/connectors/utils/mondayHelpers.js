const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const FormData = require('form-data');
const AWS = require('aws-sdk');
const { UserModel } = require('@app-connect/core/models/userModel');
const s3Helper = require('../../monday-core/s3');
const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);

const MONDAY_API_URL = process.env.MONDAY_API_URL || 'https://api.monday.com/v2';
const MONDAY_AUTHORIZE_URL = process.env.MONDAY_AUTHORIZE_URL || 'https://auth.monday.com/oauth2/authorize';
const columnIdCache = new Map();
let mondayOAuthConfig = {};

// ─── API Client ──────────────────────────────────────────────────────────────

const mondayApiClient = axios.create();

function stringifyForLog(value, maxLength = 1200) {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
  } catch (error) {
    return String(value);
  }
}

mondayApiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    console.error('[Monday][apiError]', {
      method: error?.config?.method || '',
      url: error?.config?.url || '',
      status: error?.response?.status || null,
      statusText: error?.response?.statusText || '',
      responseBody: stringifyForLog(error?.response?.data),
      errorMessage: error?.message || ''
    });
    return Promise.reject(error);
  }
);

// ─── OAuth Config ─────────────────────────────────────────────────────────────

function setMondayOAuthConfig(config) {
  mondayOAuthConfig = { ...config };
}

function getMondayOAuthConfig() {
  return mondayOAuthConfig;
}

// ─── Core Request ─────────────────────────────────────────────────────────────

async function mondayRequest(accessToken, query, variables = {}) {
  const res = await mondayApiClient.post(
    MONDAY_API_URL,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return res.data;
}

// ─── Column Helpers ───────────────────────────────────────────────────────────

async function getColumnIdByName({ accessToken, boardId, columnName }) {
  if (!columnName) {
    return null;
  }
  if (typeof columnName === 'string' && columnName.trim()) {
    const trimmedName = columnName.trim();
    if (trimmedName !== columnName) {
      columnName = trimmedName;
    }
  }
  const cacheKey = `${boardId}:${columnName}`;
  if (columnIdCache.has(cacheKey)) {
    return columnIdCache.get(cacheKey);
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
  );
  const boardData = res?.data?.boards?.[0];
  const columns = boardData?.columns || [];
  if (!columns.length) {
    console.log('Monday board lookup returned no columns', {
      boardId,
      errors: res?.errors,
      boardData
    });
  }

  const normalizedName = columnName?.toLowerCase();
  const matched = columns.find(col => {
    const title = col.title?.trim()?.toLowerCase();
    return title === normalizedName || col.id === columnName;
  });

  if (matched?.id) {
    columnIdCache.set(cacheKey, matched.id);
    return matched.id;
  }
  console.log('Monday column not found', {
    boardId,
    columnName,
    availableColumns: columns.map(col => ({ id: col.id, title: col.title }))
  });
  return null;
}

async function getOrCreateCallLogsColumn({ accessToken, boardId, columnName = 'Call Logs' }) {
  let columnId = await getColumnIdByName({ accessToken, boardId, columnName });

  if (columnId) {
    return columnId;
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
  );

  if (!res?.data?.create_column?.id) {
    throw new Error('Failed to create "Call Logs" column in Monday');
  }

  const newColumnId = res.data.create_column.id;
  columnIdCache.set(`${boardId}:${columnName}`, newColumnId);
  return newColumnId;
}

async function getOrCreateFilesColumn({ accessToken, boardId, columnName = 'Files' }) {
  let columnId = await getColumnIdByName({ accessToken, boardId, columnName });

  if (columnId) {
    return columnId;
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
  );

  if (!res?.data?.create_column?.id) {
    throw new Error('Failed to create "Files" column in Monday');
  }

  const newColumnId = res.data.create_column.id;
  columnIdCache.set(`${boardId}:${columnName}`, newColumnId);
  return newColumnId;
}

// ─── Phone Helpers ────────────────────────────────────────────────────────────

function normalizePhone(phone) {
  const p = parsePhoneNumber(phone);
  return p?.valid ? p.number.e164 : null;
}

// Generate all common formats of a phone number for CRM search matching
function generatePhoneFormats(e164Number) {
  if (!e164Number) return [];
  const digits = e164Number.replace(/\D/g, '');
  const parsed = parsePhoneNumber(e164Number);

  // US/Canada numbers: +1XXXXXXXXXX → 11 digits starting with 1
  if (digits.length === 11 && digits.startsWith('1')) {
    const d = digits.slice(1); // 10 significant digits
    return [
      e164Number,                                             // +16232011860
      digits,                                                 // 16232011860
      d,                                                      // 6232011860
      `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`,    // (623) 201-1860
      `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`,      // 623-201-1860
      `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6)}`,      // 623.201.1860
      `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`, // +1 (623) 201-1860
      `+1-${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`,   // +1-623-201-1860
      `(${d.slice(0,3)})${d.slice(3,6)}-${d.slice(6)}`,     // (623)201-1860
    ].filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate
  }

  // International numbers — include library-formatted variants
  const formats = [
    e164Number,                                                     // +6232011860
    digits,                                                         // 6232011860
    parsed?.valid ? parsed.number.international : null,             // +62 320 11860
    parsed?.valid ? parsed.number.national : null,                  // 032-011-860
    parsed?.valid ? parsed.number.significant : null,               // 32011860
  ].filter(Boolean);

  return formats.filter((v, i, arr) => arr.indexOf(v) === i); // deduplicate
}

// ─── Call Log Body Parser ─────────────────────────────────────────────────────

function parseMondayCallLogBody(body = '') {
  const normalized = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+(\>|$)/g, '')
    .trim();

  const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/);
  let subject = subjectMatch ? subjectMatch[1].trim() : '';

  if (!subject || subject.toLowerCase().startsWith('direction:')) {
    subject = '';
  }
  const direction = normalized.match(/Direction:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || '';
  const startTime = normalized.match(/Start Time:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || '';
  const endTime = normalized.match(/End Time:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || '';
  const result = normalized.match(/Result:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || '';
  const duration = normalized.match(/Duration:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || '';
  let agentNote = '';
  const agentMatch = normalized.match(
    /Agent Notes?:\s*([\s\S]*?)(?:\n[A-Z][^\n]*:|$)/i
  );

  if (agentMatch) {
    agentNote = agentMatch[1].trim();
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
  };
}

// ─── Company / License ────────────────────────────────────────────────────────

async function getCompanyByHostname({ hostname, rcAccountId }) {
  const where = { hostname, status: true };
  if (rcAccountId) where.rcAccountId = rcAccountId;

  const company = await models.companies.findOne({ where, raw: true });

  if (!company) {
    throw new Error('Company not found or inactive');
  }
  return company;
}

async function getLicenseStatus({ userId }) {
  try {
    const user = await UserModel.findByPk(userId);
    if (!user) {
      return {
        isLicenseValid: false,
        licenseStatus: 'User Not Found',
        licenseStatusDescription: ''
      };
    }

    const company = await getCompanyByHostname({
      hostname: user.hostname,
      rcAccountId: user.rcAccountId
    });

    if (!company || company.status !== true) {
      return {
        isLicenseValid: false,
        licenseStatus: 'Inactive',
        licenseStatusDescription: 'Purchase license to continue'
      };
    }

    return {
      isLicenseValid: true,
      licenseStatus: 'Active',
      licenseStatusDescription: 'Basic'
    };
  } catch (error) {
    console.error('getLicenseStatus error:', error);
    return {
      isLicenseValid: false,
      licenseStatus: 'Error',
      licenseStatusDescription: 'Error validating license'
    };
  }
}

async function validateLicenseOrFail(user) {
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

  return null;
}

// ─── File Upload ──────────────────────────────────────────────────────────────

async function downloadAudioFile(url, s3Bucket, s3Key) {
  const urlObj = new URL(url);
  const accessToken = urlObj.searchParams.get('accessToken');
  const s3Values = {
    accessKeyId: process.env.MEDIA_UPLOAD_KEY_ID,
    secretAccessKey: process.env.MEDIA_UPLOAD_SECRET_KEY,
    region: process.env.AWS_REGION
  };
  const s3 = new AWS.S3(s3Values);
  console.log('Downloading Audio File...');

  try {
    const response = await mondayApiClient.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      responseType: 'stream',
    });

    const uploadParams = {
      Bucket: s3Bucket,
      Key: s3Key,
      Body: response.data
    };

    const uploadResult = await s3.upload(uploadParams).promise();
    return uploadResult.Location;
  } catch (error) {
    console.log('Error downloading or uploading audio:', error);
  }
}

async function uploadToMonday({ s3Url, accessToken, itemId, fileName, hostname }) {
  console.log('HOSTNAME : ', hostname);

  if (!hostname) {
    throw new Error('uploadToMonday: hostname is missing');
  }
  const company = await getCompanyByHostname({ hostname });
  const boardId = company.tenantId;

  try {
    console.log('Uploading file to Monday...');

    const filesColumnId = await getOrCreateFilesColumn({
      accessToken,
      boardId
    });

    if (!filesColumnId) {
      throw new Error('Files column not found on Monday board');
    }

    const s3Key = decodeURIComponent(new URL(s3Url).pathname.substring(1));
    const fileStream = await s3Helper.getObject(s3Key, 'audio');
    const formData = new FormData();

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
    );

    formData.append('variables[file]', fileStream, {
      filename: fileName,
      contentType: 'audio/mpeg'
    });

    const response = await mondayApiClient.post(
      `${MONDAY_API_URL}/file`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity
      }
    );

    console.log('File uploaded to Monday:', response.data);
    await s3Helper.deleteObject(s3Key, 'audio');
    console.log('File deleted from S3:', s3Key);

    return response.data;
  } catch (error) {
    console.log(
      'Error uploading file to Monday:',
      error?.response?.data || error.message
    );
    throw error;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  MONDAY_API_URL,
  MONDAY_AUTHORIZE_URL,
  moment,
  setMondayOAuthConfig,
  getMondayOAuthConfig,
  mondayApiClient,
  mondayRequest,
  getColumnIdByName,
  getOrCreateCallLogsColumn,
  getOrCreateFilesColumn,
  normalizePhone,
  generatePhoneFormats,
  parseMondayCallLogBody,
  getCompanyByHostname,
  getLicenseStatus,
  validateLicenseOrFail,
  downloadAudioFile,
  uploadToMonday
};
