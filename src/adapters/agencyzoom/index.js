/* eslint-disable no-param-reassign */

const axios = require("axios");
const moment = require("moment");
const { parsePhoneNumber } = require("awesome-phonenumber");
const { UserModel } = require('@app-connect/core/models/userModel');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { messageLogModel } = require('@app-connect/core/models/messageLogModel');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');
const models = initModels(sequelize);

const AZ_BASE_URL = "https://api.agencyzoom.com/v1/api";

async function getLicenseStatus({ userId }) {
  try {
    const user = await UserModel.findByPk(userId);
    if (!user) {
      return {
        isLicenseValid: false,
        licenseStatus: "User Not Found",
        licenseStatusDescription: ""
      };
    }

    const company = await models.companies.findOne({
      where: {
        hostname: user.hostname
      },
      raw: true
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
  const res = await axios.post(
    `${AZ_BASE_URL}/auth/login`,
    {
      username,
      password
    },
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  return res.data?.jwt || res.data?.token;
}

async function getRefreshedAuthToken(user) {

  if (user.accessToken) return user.accessToken;

  const username = user.platformAdditionalInfo?.username;
  const password = user.platformAdditionalInfo?.password;
  if (!username || !password) {
    throw new Error("AgencyZoom credentials are missing for token refresh");
  }

  const token = await authenticate(username, password);

  user.accessToken = token;
  await user.save();

  return token;
}

/* ---------------- USER INFO ---------------- */

async function getUserInfo(authHeader) {

  const { hostname, additionalInfo } = authHeader;
  const { username, password } = additionalInfo;

  try {
    if (!hostname || !username || !password) {
      return {
        successful: false,
        platformUserInfo: {
          id: "",
          name: "",
          platformAdditionalInfo: {}
        },
        returnMessage: {
          messageType: "error",
          message: "Missing AgencyZoom login details.",
          ttl: 3000
        }
      };
    }

    const token = await authenticate(username, password);

    // Find company
    const company = await models.companies.findOne({
      where: { hostname },
      include: [{ model: models.customer, as: 'customers', required: false }],
      raw: false,
      logging: false
    });

    if (!company) {
      return {
        successful: false,
        platformUserInfo: {
          id: "",
          name: "",
          platformAdditionalInfo: {}
        },
        returnMessage: {
          messageType: "danger",
          message: "Could not find the company details.",
          ttl: 3000
        }
      };
    }

    const {
      maxAllowedUsers,
      customers = []
    } = company;

    // Check existing user
    let customer = customers.find(c => c.email === username);

    // Check user limit
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

    // Success response
    return {
      successful: true,
      platformUserInfo: {
        id: `az-user-${username}`,
        name: username,
        email: username,
        overridingApiKey: token,
        platformAdditionalInfo: {
          username,
          password
        }
      },
      returnMessage: {
        messageType: "success",
        message: "Successfully connected to AgencyZoom.",
        ttl: 3000
      }
    };

  } catch (err) {

    console.error("AgencyZoom login error:", err?.response?.data || err.message);

    return {
      successful: false,
      returnMessage: {
        messageType: "error",
        message: "AgencyZoom authentication failed.",
        ttl: 3000
      }
    };
  }
}

/* ---------------- UNAUTHORIZE ---------------- */

async function unAuthorize({ user }) {

  user.accessToken = "";
  await user.save();

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

    const auth = await getRefreshedAuthToken(user);
    const phone = normalizePhone(phoneNumber);

    const res = await axios.post(
      `${AZ_BASE_URL}/customers`,
      {
        phone
      },
      {
        headers: {
          Authorization: `Bearer ${auth}`
        }
      }
    );

    const customers = res.data?.customers || [];

    let matchedContactInfo = customers.map(c => ({
      id: c.id,
      name: `${c.firstname || ""} ${c.lastname || ""}`.trim(),
      phone: c.phone,
      type: "contact"
    }));

    // If multiple contacts found, pick first for auto logging
    if (matchedContactInfo.length > 1) {
      matchedContactInfo = [matchedContactInfo[0]];
    }

    matchedContactInfo.push({
      id: "createNewContact",
      name: "Create new contact...",
      isNewContact: true
    });

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

    const auth = await getRefreshedAuthToken(user);
    const encodedName = encodeURIComponent(name || "");

    const res = await axios.get(
      `${AZ_BASE_URL}/customers?name=${encodedName}`,
      {
        headers: {
          Authorization: `Bearer ${auth}`
        }
      }
    );

    const customers = res.data?.customers || [];

    const matchedContactInfo = customers.map(c => ({
      id: c.id,
      name: `${c.firstname || ""} ${c.lastname || ""}`.trim(),
      type: "contact"
    }));

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

  const res = await axios.post(
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
      }
    }
  );

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
  const subject =
    callLog.customSubject ??
    `${callLog.direction} Call ${callLog.direction === "Outbound" ? "to" : "from"} ${contactInfo.name}`;

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

  await axios.post(
    `${AZ_BASE_URL}/customers/${contactInfo.id}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` } }
  );

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

async function updateCallLog({
  user,
  existingCallLog,
  subject,
  startTime,
  duration,
  result,
  note,
  aiNote,
  transcript,
  recordingLink,
  composedLogDetails,
  existingCallLogDetails
}) {
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
  const resolvedSubject =
    subject ||
    composedLogDetails ||
    existingCallLog?.subject ||
    `${resolvedDirection || "Call"} Call`;

  let description = "";

  if (note && (user.userSettings?.addCallLogNote?.value ?? true))
    description += `Agent Notes: ${note}\n`;

  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true))
    description += `AI Note: ${aiNote}\n`;

  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true))
    description += `Transcript: ${transcript}\n`;

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

Subject: ${resolvedSubject}
Direction: ${resolvedDirection}
Result: ${result ?? existingCallLog?.result ?? ""}
Duration: ${resolvedDuration} sec
Start Time: ${startTimeText}
End Time: ${endTimeText}

${description}
`;

  await axios.post(
    `${AZ_BASE_URL}/customers/${contactId}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` } }
  );

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
        messageType: "error",
        message: "Call log note not found in AgencyZoom.",
        ttl: 3000
      }
    };
  }

  const body = matchedNote.body;

  const subject = body.match(/Subject:\s*(.*)/)?.[1] || "";

  let agentNote = "";
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

  await axios.post(
    `${AZ_BASE_URL}/customers/${contactInfo.id}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` } }
  );

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

  const res = await axios.get(
    `${AZ_BASE_URL}/customers/${contactId}`,
    {
      headers: {
        Authorization: `Bearer ${auth}`
      }
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

  await axios.post(
    `${AZ_BASE_URL}/customers/${contactId}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` } }
  );

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
  return "text";
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