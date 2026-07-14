/* eslint-disable no-param-reassign */

const axios = require("axios");
const moment = require("moment");
const { encode, decoded } = require("@app-connect/core/lib/encode");
const { parsePhoneNumber } = require("awesome-phonenumber");
const { UserModel } = require('@app-connect/core/models/userModel');
const { AccountDataModel } = require('@app-connect/core/models/accountDataModel');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');
const models = sequelize ? initModels(sequelize) : null;

const licenseHelper = require('../shared/license');
const apiLog = require('../shared/apiLogger');

const AZ_BASE_URL = "https://api.agencyzoom.com/v1/api";

const agencyZoomApiClient = axios.create();

function stringifyForLog(value, maxLength = 1200) {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
  } catch (error) {
    return String(value);
  }
}

apiLog.installErrorInterceptor(agencyZoomApiClient, 'AgencyZoom');

async function getLicenseStatus({ userId }) {
  return licenseHelper.getLicenseStatus({ models, userId });
}

async function validateLicenseOrFail(user) {
  return licenseHelper.validateLicenseOrFail({ models, user });
}

function extractLogId(noteBody) {

  const match = noteBody.match(/RC_LOG_ID:\s*(\S+)/);

  return match ? match[1] : null;
}

function buildNoteIndex(notes) {
  const index = {};

  for (const note of notes) {
    const logId = extractLogId(note.body);

    if (logId) {
      if (!index[logId] || new Date(note.createDate) > new Date(index[logId].createDate)) {
        index[logId] = note;
      }
    }
  }

  return index;
}

/* ---------------- AUTH TYPE ---------------- */

function getAuthType() {
  return "apiKey";
}

function getBasicAuth({ apiKey }) {
  return Buffer.from(`${apiKey}`).toString("base64");
}

/* ---------------- AUTHENTICATION ---------------- */

async function authenticate(username, password) {
  apiLog.logStart('AgencyZoom', 'authenticate', { username });

  const res = await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/auth/login`,
    {
      username,
      password
    },
    {
      headers: {
        "Content-Type": "application/json"
      },
      _operation: 'authenticate'
    }
  );

  apiLog.logSuccess('AgencyZoom', 'authenticate', { username, apiEndpoint: `${AZ_BASE_URL}/auth/login` });

  return res.data?.jwt || res.data?.token;
}

async function getRefreshedAuthToken(user) {

  if (user.accessToken) return user.accessToken;

  const username = user.platformAdditionalInfo?.username;
  const encodedPassword = user.platformAdditionalInfo?.password;
  const password = encodedPassword ? decoded(encodedPassword) : null;
  if (!username || !password) {
    throw new Error("AgencyZoom credentials are missing for token refresh");
  }

  const token = await authenticate(username, password);

  user.accessToken = token;
  await user.save();

  return token;
}

/* ---------------- USER INFO ---------------- */

async function getUserInfo({ hostname, additionalInfo }) {
  // rcAccountId arrives via the manifest's rcAdditionalSubmission (auto from RC cached
  // data — no user prompt, no framework change).
  const { username, password, rcAccountId, } = additionalInfo ?? {};

  if (!hostname || !username || !password) {
    return {
      successful: false,
      platformUserInfo: { id: "", name: "", platformAdditionalInfo: {} },
      returnMessage: { messageType: "error", message: "Missing AgencyZoom login details.", ttl: 3000 }
    };
  }

  // Tenant-scope the id so the same AgencyZoom username under different RC accounts
  // never collides (AgencyZoom uses one fixed URL for all tenants). The username is the
  // per-user key (no RC extension id needed here); sanitize it the same way ServiceTitan
  // sanitizes its email key — AZ usernames are often emails, so the raw value can carry
  // '@'/'.'/spaces and produce an unstable id.
  if (!rcAccountId) {
    console.warn('[AgencyZoom][getUserInfo] missing rcAccountId — falling back to non-tenant-scoped id');
  }
  const userKey = String(username).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const userId = rcAccountId ? `az-user-${rcAccountId}-${userKey}` : `az-user-${userKey}`;

  apiLog.logStart('AgencyZoom', 'getUserInfo', { userId, username, rcAccountId });

  try {
    const token = await authenticate(username, password);

    // License / seat enforcement (mirrors ServiceTitan getUserInfo). Runs after a successful
    // login so a failed authentication never consumes a seat; a DB error degrades gracefully
    // (logged, login still allowed) so it can't lock out an otherwise-licensed user.
    if (models && models.companies && models.customer && rcAccountId) {
      try {
        const company = await models.companies.findOne({
          where: { rcAccountId: String(rcAccountId), status: true },
          raw: true
        });
        if (!company) {
          return {
            successful: false,
            returnMessage: {
              messageType: 'error',
              message: 'No active subscription found for this account. Please contact Gate6 support.',
              ttl: 5000
            }
          };
        }

        const existingCustomer = await models.customer.findOne({
          where: { companyId: company.id, sysId: String(userId) },
          raw: true
        });

        if (!existingCustomer) {
          const currentSeatCount = await models.customer.count({
            where: { companyId: company.id }
          });

          const maxSeats = Number(company.maxAllowedUsers);
          if (Number.isFinite(maxSeats) && maxSeats >= 0 && currentSeatCount >= maxSeats) {
            return {
              successful: false,
              returnMessage: {
                messageType: 'error',
                message: `License seat limit reached (${maxSeats} of ${maxSeats} in use). Contact your admin.`,
                ttl: 5000
              }
            };
          }

          await models.customer.create({
            sysId: String(userId),
            companyId: company.id,
            email: username || '',
            firstname: username || 'AgencyZoom User',
            platform: 'gate6.agencyzoom',
            hostname,
            rcAccountId
          });
        }
      } catch (err) {
        console.error('Error enforcing customer seat limits:', err);
      }
    }

    apiLog.logSuccess('AgencyZoom', 'getUserInfo', { userId, apiEndpoint: `${AZ_BASE_URL}/auth/login` });

    return {
      successful: true,
      platformUserInfo: {
        id: userId,
        name: username,
        email: username,
        overridingApiKey: token,
        platformAdditionalInfo: {
          username,
          password: encode(password)
        }
      },
      returnMessage: { messageType: "success", message: "Successfully connected to AgencyZoom.", ttl: 3000 }
    };
  } catch (err) {
    console.error("AgencyZoom login error:", err?.response?.data || err.message);
    return {
      successful: false,
      returnMessage: { messageType: "error", message: "AgencyZoom authentication failed.", ttl: 3000 }
    };
  }
}

/* ---------------- UNAUTHORIZE ---------------- */

async function unAuthorize({ user }) {

  user.accessToken = "";
  await user.save();
  licenseHelper.clearLicenseCache(user.id ?? user.dataValues?.id);

  return {
    returnMessage: {
      messageType: "success",
      message: "Logged out of AgencyZoom",
      ttl: 1000
    }
  };
}

/* ---------------- PHONE HELPER ---------------- */

function normalizePhone(phone) {

  phone = phone.replace(" ", "+");

  const parsed = parsePhoneNumber(phone);

  return parsed.valid ? parsed.number.significant : phone;
}

/* ---------------- FIND CONTACT ---------------- */

async function findContact({ user, phoneNumber }) {
  try {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('AgencyZoom', 'findContact', { phoneNumber });

    const auth = await getRefreshedAuthToken(user);
    const phone = normalizePhone(phoneNumber);

    const res = await agencyZoomApiClient.post(
      `${AZ_BASE_URL}/customers`,
      {
        phone
      },
      {
        headers: {
          Authorization: `Bearer ${auth}`
        },
        _operation: 'findContact'
      }
    );

    const customers = res.data?.customers || [];

    let matchedContactInfo = customers.map(c => ({
      id: c.id,
      name: c.housename || [c.firstname, c.middlename, c.lastname].filter(Boolean).join(" "),
      phone: c.phone,
      type: "contact"
    }));

    // If multiple contacts found, pick first for auto logging
    if (matchedContactInfo.length > 1) {
      matchedContactInfo = [matchedContactInfo[0]];
    }

    // No contacts found in AgencyZoom — delete stale cache entry if it exists
    if (matchedContactInfo.length === 0 && user?.rcAccountId) {
      try {
        const deleted = await AccountDataModel.destroy({
          where: {
            rcAccountId: user.rcAccountId,
            platformName: 'agencyzoom',
            dataKey: `contact-${phoneNumber}`
          }
        });
        if (deleted > 0) {
          console.log('[AgencyZoom] findContact: deleted stale cache for phone:', phoneNumber);
        }
      } catch (err) {
        console.warn('[AgencyZoom] findContact: failed to delete stale cache:', err.message);
      }
    }

    matchedContactInfo.push({
      id: "createNewContact",
      name: "Create new contact...",
      isNewContact: true
    });

    apiLog.logSuccess('AgencyZoom', 'findContact', { phoneNumber, matchedCount: customers.length, apiEndpoint: `${AZ_BASE_URL}/customers` });

    return {
      successful: true,
      matchedContactInfo
    };
  } catch (err) {
    return {
      successful: false,
      returnMessage: {
        messageType: "error",
        message: err?.response?.data?.message || "Failed to find AgencyZoom contacts.",
        ttl: 3000
      }
    };
  }
}

/* ---------------- FIND CONTACT WITH NAME ---------------- */

async function findContactWithName({ user, name }) {
  try {

    apiLog.logStart('AgencyZoom', 'findContactWithName', { name });

    const auth = await getRefreshedAuthToken(user);
    const encodedName = encodeURIComponent(name || "");

    const res = await agencyZoomApiClient.get(
      `${AZ_BASE_URL}/customers?name=${encodedName}`,
      {
        headers: {
          Authorization: `Bearer ${auth}`
        },
        _operation: 'findContactWithName'
      }
    );

    const customers = res.data?.customers || [];

    const matchedContactInfo = customers.map(c => ({
      id: c.id,
      name: c.housename || [c.firstname, c.middlename, c.lastname].filter(Boolean).join(" "),
      type: "contact"
    }));

    apiLog.logSuccess('AgencyZoom', 'findContactWithName', { name, matchedCount: customers.length, apiEndpoint: `${AZ_BASE_URL}/customers?name=${encodedName}` });

    return {
      successful: true,
      matchedContactInfo
    };
  } catch (err) {
    return {
      successful: false,
      matchedContactInfo: [],
      returnMessage: {
        messageType: "error",
        message: err?.response?.data?.message || "Failed to search AgencyZoom contacts.",
        ttl: 3000
      }
    };
  }
}

/* ---------------- CREATE CONTACT ---------------- */

async function createContact({ user, phoneNumber, newContactName }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  if (!newContactName?.trim()) {
    return {
      contactInfo: null,
      returnMessage: {
        messageType: "error",
        message: "Contact name is required.",
        ttl: 3000
      }
    };
  }

  apiLog.logStart('AgencyZoom', 'createContact', { phoneNumber });

  const auth = await getRefreshedAuthToken(user);

  const phone = normalizePhone(phoneNumber);

  const [firstName, ...rest] = newContactName.split(" ");
  const lastName = rest.join(" ") || firstName;

  const email = `${phone}@ringcentral.local`;

  let agentId;
  try {
    const jwtPayload = JSON.parse(
      Buffer.from(auth.split(".")[1], "base64").toString()
    );
    agentId = parseInt(
      Buffer.from(jwtPayload?.jti?.agent || "", "base64").toString(),
      10
    );
  } catch (err) {
    agentId = undefined;
  }

  const res = await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/customers/create`,
    {
      firstname: firstName,
      lastname: lastName,
      phone,
      email,
      agentId
    },
    {
      headers: {
        Authorization: `Bearer ${auth}`
      },
      _operation: 'createContact'
    }
  );

  apiLog.logSuccess('AgencyZoom', 'createContact', { contactId: res.data.id, phoneNumber, apiEndpoint: `${AZ_BASE_URL}/customers/create` });

  return {
    contactInfo: {
      id: res.data.id,
      name: `${firstName} ${lastName}`
    },
    returnMessage: {
      message: "Contact created.",
      messageType: "success",
      ttl: 2000
    }
  };
}

/* ---------------- CREATE CALL LOG ---------------- */

async function createCallLog({ user, contactInfo, callLog, note, aiNote, transcript }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const auth = await getRefreshedAuthToken(user);
  const logId = `az-log-${Date.now().toString(36)}`;

  apiLog.logStart('AgencyZoom', 'createCallLog', { contactId: contactInfo?.id, logId, direction: callLog?.direction, duration: callLog?.duration });

  const subject =
    (user.userSettings?.addCallLogSubject?.value ?? true)
      ? (callLog?.customSubject?.trim() || "")
      : ""

  let description = "";

  if (note && (user.userSettings?.addCallLogNote?.value ?? true))
    description += `Agent Notes: ${note}\n`;

  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true))
    description += `AI Note: ${aiNote}\n`;

  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true))
    description += `Transcript: ${transcript}\n`;

  if (callLog.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true))
    description += `Recording: ${callLog.recording.link}\n`;

  const noteBody = `
[RingCentral Call Log]
RC_LOG_ID: ${logId}

Subject: ${subject}
Direction: ${callLog.direction}
Duration: ${callLog.duration} sec
Start Time: ${moment(callLog.startTime).format("YYYY-MM-DD HH:mm:ss")}
End Time: ${moment(callLog.startTime).add(callLog.duration, "seconds").format("YYYY-MM-DD HH:mm:ss")}

${description}
`;

  await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/customers/${contactInfo.id}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` }, _operation: 'createCallLog' }
  );

  apiLog.logSuccess('AgencyZoom', 'createCallLog', { logId, contactId: Number(contactInfo.id), apiEndpoint: `${AZ_BASE_URL}/customers/${contactInfo.id}/notes` });

  return {
    logId,
    contactId: Number(contactInfo.id),
    returnMessage: {
      messageType: 'success',
      message: 'Call log created',
      ttl: 3000
    }
  }
}

/* ---------------- UPDATE CALL LOG ---------------- */

async function updateCallLog({ user, existingCallLog, subject, startTime, duration, result, note, aiNote, transcript, recordingLink, composedLogDetails, existingCallLogDetails }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const auth = await getRefreshedAuthToken(user);

  if (!existingCallLog?.thirdPartyLogId) {
    return {
      logId: null,
      returnMessage: {
        messageType: "error",
        message: "Missing call log id for AgencyZoom update.",
        ttl: 3000
      }
    };
  }

  const contactId = existingCallLog.contactId;
  const logId = existingCallLog.thirdPartyLogId;

  apiLog.logStart('AgencyZoom', 'updateCallLog', { contactId, logId, duration });

  const oldBody =
    existingCallLogDetails?.body ||
    existingCallLogDetails?.note ||
    existingCallLogDetails?.fullBody ||
    "";
  const oldDirection =
    typeof oldBody === "string"
      ? (oldBody.match(/Direction:\s*(.*?)(?:\n|$)/)?.[1] || "").trim()
      : "";
  const resolvedDirection = oldDirection || existingCallLog?.direction || "";
  const resolvedDuration = duration ?? existingCallLog?.duration ?? 0;
  const resolvedStartTime = startTime || existingCallLog?.startTime || null;
  const subjectMatch = typeof oldBody === "string" ? oldBody.match(/Subject:\s*(.*?)(?:\n|$)/)?.[1] || "" : "";
  let subjectToUse = subjectMatch || "";
  if (!subjectToUse || subjectToUse.toLowerCase().startsWith("direction:")) {
    subjectToUse = "";
  }

  let description = "";

  if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
    subjectToUse = subject.trim();
  }

  if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
    description += `Agent Notes: ${note}\n`;
  }

  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
    description += `AI Note: ${aiNote}\n`;
  }

  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
    description += `Transcript: ${transcript}\n`;
  }

  if (recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) {
    let decodedLink = recordingLink;
    try {
      decodedLink = decodeURIComponent(recordingLink);
    } catch (err) {
      decodedLink = recordingLink;
    }
    description += `Recording: ${decodedLink}\n`;
  }

  const startTimeText = resolvedStartTime
    ? moment(resolvedStartTime).format("YYYY-MM-DD HH:mm:ss")
    : "";
  const endTimeText = resolvedStartTime
    ? moment(resolvedStartTime).add(Number(resolvedDuration) || 0, "seconds").format("YYYY-MM-DD HH:mm:ss")
    : "";

  const noteBody = `
[RingCentral Call Log]
RC_LOG_ID: ${logId}

Subject: ${subjectToUse}
Direction: ${resolvedDirection}
Result: ${result ?? existingCallLog?.result ?? ""}
Duration: ${resolvedDuration} sec
Start Time: ${startTimeText}
End Time: ${endTimeText}

${description}
`;

  await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/customers/${contactId}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` }, _operation: 'updateCallLog' }
  );

  apiLog.logSuccess('AgencyZoom', 'updateCallLog', { logId, contactId, apiEndpoint: `${AZ_BASE_URL}/customers/${contactId}/notes` });

  return {
    logId,
    returnMessage: {
      messageType: "success",
      message: "Call log updated",
      ttl: 3000
    }
  };
}
/* ---------------- GET CALL LOG ---------------- */

async function getCallLog({ user, callLogId }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  if (!callLogId) {
    return {
      callLogInfo: {},
      returnMessage: {
        messageType: "error",
        message: "Missing call log id for AgencyZoom fetch.",
        ttl: 3000
      }
    };
  }

  apiLog.logStart('AgencyZoom', 'getCallLog', { logId: callLogId });

  const auth = await getRefreshedAuthToken(user);

  // Fetch contactId from DB
  const log = await CallLogModel.findOne({
    where: { thirdPartyLogId: callLogId }
  });

  if (!log) {
    return {
      callLogInfo: {},
      returnMessage: {
        messageType: "error",
        message: "Call log not found",
        ttl: 3000
      }
    };
  }

  const contactId = log.contactId;

  const res = await agencyZoomApiClient.get(
    `${AZ_BASE_URL}/customers/${contactId}`,
    {
      headers: {
        Authorization: `Bearer ${auth}`
      },
      _operation: 'getCallLog'
    }
  );

  const notes = res.data.notes || [];

  const noteIndex = buildNoteIndex(notes);

  const matchedNote = noteIndex[callLogId];

  if (!matchedNote) {
    return {
      callLogInfo: {},
      returnMessage: {
        messageType: "error",
        message: "Call log note not found in AgencyZoom.",
        ttl: 3000
      }
    };
  }

  const body = matchedNote.body;

  const normalized = (body || "").replace(/\r\n/g, '\n');

  const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/);
  let subject = subjectMatch ? subjectMatch[1].trim() : '';

  if (!subject || subject.toLowerCase().startsWith('direction:')) {
    subject = '';
  }

  let agentNote = "";
  const agentMatch = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n(?:AI Note|Transcript|Recording):|$)/);

  if (agentMatch) {
    agentNote = agentMatch[1].trim();
  }

  apiLog.logSuccess('AgencyZoom', 'getCallLog', { logId: callLogId, contactId, apiEndpoint: `${AZ_BASE_URL}/customers/${contactId}` });

  return {
    callLogInfo: {
      subject,
      note: agentNote,
      fullLogResponse: matchedNote
    },
    returnMessage: {
      messageType: "success",
      message: "Call log fetched",
      ttl: 3000
    }
  };
}

/* ---------------- MESSAGE LOG ---------------- */

async function createMessageLog({ user, contactInfo, message, recordingLink, faxDocLink }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  if (!contactInfo?.id) {
    return {
      logId: null,
      returnMessage: {
        messageType: "error",
        message: "Missing contact id for AgencyZoom message log create.",
        ttl: 3000
      }
    };
  }

  const auth = await getRefreshedAuthToken(user);
  const logId = `az-msg-${Date.now().toString(36)}`;
  const messageType =
    recordingLink ? "Voicemail" :
      (faxDocLink ? "Fax" : "SMS");

  apiLog.logStart('AgencyZoom', 'createMessageLog', { contactId: contactInfo?.id, logId, messageType, direction: message?.direction });

  let subject = "";
  let description = "";

  switch (messageType) {

    case "SMS":
      subject = `SMS conversation with ${contactInfo.name}`;
      description =
        `SMS from ${message.direction === "Inbound" ? contactInfo.name : "user"}: ${message.subject}`;
      break;

    case "Voicemail":
      subject = `Voicemail from ${contactInfo.name}`;
      description = `Voicemail recording link: ${recordingLink}`;
      break;

    case "Fax":
      subject = `Fax from ${contactInfo.name}`;
      description = `Fax document link: ${faxDocLink}`;
      break;
  }

  const noteBody = `
[RingCentral Message Log]
RC_LOG_ID: ${logId}

Subject: ${subject}

Conversation:
${description}
`;

  await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/customers/${contactInfo.id}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` }, _operation: 'createMessageLog' }
  );

  apiLog.logSuccess('AgencyZoom', 'createMessageLog', { logId, contactId: Number(contactInfo.id), apiEndpoint: `${AZ_BASE_URL}/customers/${contactInfo.id}/notes` });

  return {
    logId,
    contactId: Number(contactInfo.id),
    returnMessage: {
      message: "Message logged in AgencyZoom",
      messageType: "success",
      ttl: 1000
    }
  };
}

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, recordingLink, faxDocLink }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const auth = await getRefreshedAuthToken(user);

  if (!existingMessageLog?.thirdPartyLogId) {
    return {
      logId: null,
      returnMessage: {
        messageType: "error",
        message: "Missing message log id for AgencyZoom update.",
        ttl: 3000
      }
    };
  }
  if (!contactInfo?.id) {
    return {
      logId: null,
      returnMessage: {
        messageType: "error",
        message: "Missing contact id for AgencyZoom message log update.",
        ttl: 3000
      }
    };
  }

  const contactId = contactInfo.id;
  const logId = existingMessageLog.thirdPartyLogId;

  apiLog.logStart('AgencyZoom', 'updateMessageLog', { contactId, logId, direction: message?.direction });

  const res = await agencyZoomApiClient.get(
    `${AZ_BASE_URL}/customers/${contactId}`,
    {
      headers: {
        Authorization: `Bearer ${auth}`
      },
      _operation: 'updateMessageLog'
    }
  );

  const notes = res.data?.notes || [];

  const noteIndex = buildNoteIndex(notes);

  const matchedNote = noteIndex[logId];

  const messageType =
    recordingLink ? "Voicemail" :
      (faxDocLink ? "Fax" : "SMS");

  let newLine = "";

  switch (messageType) {

    case "SMS":
      newLine =
        `[${moment(message.creationTime).format("YYYY-MM-DD HH:mm:ss")}] SMS ${message.direction === "Inbound" ? "from" : "to"
        } ${contactInfo.name}: ${message.subject}`;
      break;

    case "Voicemail":
      newLine =
        `[${moment(message.creationTime).format("YYYY-MM-DD HH:mm:ss")}] Voicemail recording link: ${recordingLink}`;
      break;

    case "Fax":
      newLine =
        `[${moment(message.creationTime).format("YYYY-MM-DD HH:mm:ss")}] Fax document link: ${faxDocLink}`;
      break;
  }

  /* -------- APPEND MESSAGE -------- */

  let conversation = "";

  const match = matchedNote?.body?.match(/Conversation:\s*([\s\S]*)/);

  if (match) conversation = match[1].trim();

  const updatedConversation = `${conversation}\n${newLine}`;

  const noteBody = `
[RingCentral Message Log]
RC_LOG_ID: ${logId}

Conversation:
${updatedConversation}
`;

  await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/customers/${contactId}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` }, _operation: 'updateMessageLog' }
  );

  apiLog.logSuccess('AgencyZoom', 'updateMessageLog', { logId, contactId, apiEndpoint: `${AZ_BASE_URL}/customers/${contactId}/notes` });

  return {
    logId,
    returnMessage: {
      message: "Message updated in AgencyZoom",
      messageType: "success",
      ttl: 1000
    }
  };
}

/* ---------------- DISPOSITION ---------------- */

async function upsertCallDisposition({ existingCallLog }) {
  return { logId: existingCallLog?.thirdPartyLogId };
}

/* ---------------- USER LIST ---------------- */

async function getUserList() {
  return {
    successful: true,
    userList: []
  };
}

/* ---------------- LOG FORMAT ---------------- */

function getLogFormatType() {
  return "text/plain";
}

/* ---------------- EXPORTS ---------------- */

exports.getAuthType = getAuthType;
exports.getBasicAuth = getBasicAuth;
exports.getUserInfo = getUserInfo;
exports.getUserList = getUserList;
exports.createCallLog = createCallLog;
exports.updateCallLog = updateCallLog;
exports.upsertCallDisposition = upsertCallDisposition;
exports.createMessageLog = createMessageLog;
exports.updateMessageLog = updateMessageLog;
exports.getCallLog = getCallLog;
exports.findContact = findContact;
exports.createContact = createContact;
exports.unAuthorize = unAuthorize;
exports.findContactWithName = findContactWithName;
exports.getLogFormatType = getLogFormatType;
exports.getRefreshedAuthToken = getRefreshedAuthToken;
exports.getLicenseStatus = getLicenseStatus
export { };
