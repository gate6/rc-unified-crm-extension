const axios = require('axios');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const {
  AZ_BASE_URL,
  buildNoteIndex,
  getRefreshedAuthToken,
  validateLicenseOrFail
} = require('../utils/agencyZoomHelpers');

async function getCallLog({ user, callLogId }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  if (!callLogId) {
    return {
      callLogInfo: {},
      returnMessage: {
        messageType: 'error',
        message: 'Missing call log id for AgencyZoom fetch.',
        ttl: 3000
      }
    };
  }

  const auth = await getRefreshedAuthToken(user);

  const log = await CallLogModel.findOne({
    where: { thirdPartyLogId: callLogId }
  });

  if (!log) {
    return {
      callLogInfo: {},
      returnMessage: {
        messageType: 'error',
        message: 'Call log not found',
        ttl: 3000
      }
    };
  }

  const contactId = log.contactId;

  const res = await axios.get(
    `${AZ_BASE_URL}/customers/${contactId}`,
    {
      headers: {
        Authorization: `Bearer ${auth}`
      }
    }
  );

  const notes = res.data.notes || [];
  const noteIndex = buildNoteIndex(notes);
  const matchedNote = noteIndex[callLogId];

  if (!matchedNote) {
    return {
      callLogInfo: {},
      returnMessage: {
        messageType: 'error',
        message: 'Call log note not found in AgencyZoom.',
        ttl: 3000
      }
    };
  }

  const body = matchedNote.body || '';
  const subject = body.match(/Subject:\s*(.*)/)?.[1] || '';

  let agentNote = '';
  const agentMatch = body.match(/Agent Notes:\s*([\s\S]*?)(?:\n(?:AI Note|Transcript|Recording):|$)/);

  if (agentMatch) {
    agentNote = agentMatch[1].trim();
  }

  return {
    callLogInfo: {
      subject,
      note: agentNote,
      fullLogResponse: matchedNote
    },
    returnMessage: {
      messageType: 'success',
      message: 'Call log fetched',
      ttl: 3000
    }
  };
}

module.exports = getCallLog;
