const axios = require('axios');
const { parsePhoneNumber } = require('awesome-phonenumber');
const getLicenseStatus = require('../interfaces/getLicenseStatus');

const AZ_BASE_URL = process.env.AZ_BASE_URL || 'https://api.agencyzoom.com/v1/api';

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

function extractLogId(noteBody) {
  const match = noteBody.match(/RC_LOG_ID:\s*(\S+)/);
  return match ? match[1] : null;
}

function buildNoteIndex(notes) {
  const index = {};

  for (const note of notes) {
    const logId = extractLogId(note.body || '');

    if (logId) {
      if (!index[logId] || new Date(note.createDate) > new Date(index[logId].createDate)) {
        index[logId] = note;
      }
    }
  }

  return index;
}

async function authenticate(username, password) {
  const res = await axios.post(
    `${AZ_BASE_URL}/auth/login`,
    {
      username,
      password
    },
    {
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

  return res.data?.jwt || res.data?.token;
}

async function getRefreshedAuthToken(user) {
  if (user.accessToken) return user.accessToken;

  const username = user.platformAdditionalInfo?.username || user.platformAdditionalInfo?.email;
  const password = user.platformAdditionalInfo?.password;

  if (!username || !password) {
    throw new Error('AgencyZoom credentials are missing for token refresh');
  }

  const token = await authenticate(username, password);

  user.accessToken = token;
  await user.save();

  return token;
}

function normalizePhone(phone) {
  phone = (phone || '').replace(' ', '+');

  const parsed = parsePhoneNumber(phone);

  return parsed.valid ? parsed.number.significant : phone;
}

module.exports = {
  AZ_BASE_URL,
  validateLicenseOrFail,
  extractLogId,
  buildNoteIndex,
  authenticate,
  getRefreshedAuthToken,
  normalizePhone
};
