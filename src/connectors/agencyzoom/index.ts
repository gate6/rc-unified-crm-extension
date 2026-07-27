/* eslint-disable no-param-reassign */

const axios = require("axios");
const moment = require("moment");
const { encode, decoded } = require("@app-connect/core/lib/encode");
const { parsePhoneNumber } = require("awesome-phonenumber");
const { UserModel } = require('@app-connect/core/models/userModel');
const phoneWriteback = require('../shared/phoneWriteback');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');
const models = sequelize ? initModels(sequelize) : null;

const licenseHelper = require('../shared/license');
const apiLog = require('../shared/apiLogger');
const { trackAnalytics } = require('../shared/analytics');

const AZ_BASE_URL = "https://api.agencyzoom.com/v1/api";

const agencyZoomApiClient = axios.create();

apiLog.installErrorInterceptor(agencyZoomApiClient, 'AgencyZoom');

async function getLicenseStatus({ userId }) {
  return licenseHelper.getLicenseStatus({ models, userId });
}

async function validateLicenseOrFail(user) {
  return licenseHelper.validateLicenseOrFail({ models, user });
}

function extractLogId(noteBody) {

  // AgencyZoom can return notes with a null/empty body (notes created outside our flow),
  // so guard before matching — otherwise buildNoteIndex throws on the first such note.
  if (!noteBody) return null;

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

/* ---------------- NOTE FORMATTING (mirrors ServiceTitan) ---------------- */

// Respect the user's timezone offset + preferred log date format, exactly like ServiceTitan's
// formatDateTime (which mirrors core's callLogComposer). Falls back to a sensible default.
function formatDateTime({ user, time }) {
  let momentTime = moment(time);
  const tz = user?.timezoneOffset;
  if (tz) {
    momentTime = (typeof tz === 'string' && tz.includes(':'))
      ? momentTime.utcOffset(tz)
      : momentTime.utcOffset(Number(tz));
  }
  return momentTime.format(user?.userSettings?.logDateFormat?.value || 'YYYY-MM-DD hh:mm:ss A');
}

const HEADER_MARK = String.fromCharCode(1); // sentinel for converted header lines; stripped at end

// Strip markdown (the ** asterisks, __ and #) that AI notes/transcripts arrive with, so the
// AgencyZoom note shows clean text. Ported verbatim from ServiceTitan's sanitizeNoteText.
function sanitizeNoteText(text) {
  if (!text) return '';
  let s = String(text).replace(/\r\n/g, '\n');
  s = s.replace(/^[ \t]*\*\*(.+?)\*\*[ \t]*$/gm, (_, h) => {
    const t = h.trim().replace(/:+$/, '');
    return (t.length <= 30 && t.split(/\s+/).length <= 4) ? `${HEADER_MARK}${t}:` : t;
  });
  s = s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^[ \t]*#{1,6}[ \t]*/gm, '');
  s = s.replace(/[ \t]+$/gm, '');
  s = s.replace(new RegExp(`${HEADER_MARK}([^\\n]*)\\n\\s*\\n`, 'g'), `${HEADER_MARK}$1\n`);
  s = s.replace(new RegExp(`([^\\n])\\n${HEADER_MARK}`, 'g'), `$1\n\n${HEADER_MARK}`);
  s = s.replace(new RegExp(HEADER_MARK, 'g'), '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// The contact number should be a real, full phone number — never a bare RingCentral
// extension (e.g. 101/102) that internal calls can surface. Extensions are 3–5 digits;
// real numbers are longer, so require at least 7 digits.
function looksLikeFullNumber(value) {
  return String(value || '').replace(/\D/g, '').length >= 7;
}

// Build the AgencyZoom note body: our RC_LOG_ID header (kept for matching) followed by a
// ServiceTitan-style layout — header lines, a blank line, optional sections (each separated
// by a blank line), a blank line, then the start/end time footer. Every optional/field entry
// respects the matching user setting (defaulting on when the setting is absent).
function composeCallLogNote({ user, logId, subject, direction, result, duration, callSessionId, rcUserName, rcPhone, contactPhone, note, recording, transcript, aiNote, startTimeText, endTimeText }) {
  const headerLines = [];
  if (subject) headerLines.push(`Subject: ${subject}`);
  if (direction) headerLines.push(`Direction: ${direction}`);
  if (result && (user.userSettings?.addCallLogResult?.value ?? true)) headerLines.push(`Result: ${result}`);
  if (duration && (user.userSettings?.addCallLogDuration?.value ?? true)) headerLines.push(`Duration: ${duration} sec`);
  if (callSessionId && (user.userSettings?.addCallSessionId?.value ?? true)) headerLines.push(`Call Session ID: ${callSessionId}`);
  if (rcUserName && (user.userSettings?.addRingCentralUserName?.value ?? true)) headerLines.push(`RingCentral Username: ${rcUserName}`);
  if (rcPhone && looksLikeFullNumber(rcPhone) && (user.userSettings?.addRingCentralNumber?.value ?? true)) headerLines.push(`RingCentral Phone Number: ${rcPhone}`);
  if (contactPhone && looksLikeFullNumber(contactPhone) && (user.userSettings?.addCallLogContactNumber?.value ?? true)) headerLines.push(`Contact Number: ${contactPhone}`);

  const sections = [];
  if (note && (user.userSettings?.addCallLogNote?.value ?? true)) sections.push(`Agent Notes:\n${sanitizeNoteText(note)}`);
  if (recording && (user.userSettings?.addCallLogRecording?.value ?? true)) sections.push(`Recording:\n${recording}`);
  if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) sections.push(`Transcript:\n${sanitizeNoteText(transcript)}`);
  if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) sections.push(`AI Note:\n${sanitizeNoteText(aiNote)}`);

  const footerLines = [];
  if (startTimeText && (user.userSettings?.addCallLogDateTime?.value ?? true)) footerLines.push(`Start Time: ${startTimeText}`);
  if (endTimeText && (user.userSettings?.addCallLogDateTime?.value ?? true)) footerLines.push(`End Time: ${endTimeText}`);

  let body = headerLines.join("\n");
  if (sections.length > 0) body += `\n\n${sections.join("\n\n")}`;
  if (footerLines.length > 0) body += `\n\n${footerLines.join("\n")}`;

  return `[RingCentral Call Log]\nRC_LOG_ID: ${logId}\n\n${body}`;
}

/* ---------------- AUTH TYPE ---------------- */

function getAuthType() {
  return "apiKey";
}

function getBasicAuth({ apiKey }) {
  return Buffer.from(`${apiKey}`).toString("base64");
}

/* ---------------- AUTHENTICATION ---------------- */

// A boolean coming back from the auth form / persisted JSON can surface as a real
// boolean or the string "true" — normalize both to a single flag.
function isVertaforeSso(value) {
  return value === true || value === 'true';
}

// Native login (`/auth/login`) validates against AgencyZoom's own user store; Vertafore
// SSO login (`/auth/ssologin`) validates the same username/password against Vertafore's
// identity provider. Both return the same `{ token }`. SSO-provisioned users have no
// native AgencyZoom password, so they must use the SSO endpoint.
async function authenticate(username, password, useVertaforeSso = false) {
  const ssoMode = isVertaforeSso(useVertaforeSso);
  const endpoint = ssoMode ? 'ssologin' : 'login';

  apiLog.logStart('AgencyZoom', 'authenticate', { username, ssoMode });

  const res = await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/auth/${endpoint}`,
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

  apiLog.logSuccess('AgencyZoom', 'authenticate', { username, apiEndpoint: `${AZ_BASE_URL}/auth/${endpoint}` });

  return res.data?.jwt || res.data?.token;
}

async function getRefreshedAuthToken(user) {

  if (user.accessToken) return user.accessToken;

  const username = user.platformAdditionalInfo?.username;
  const encodedPassword = user.platformAdditionalInfo?.password;
  const password = encodedPassword ? decoded(encodedPassword) : null;
  const useVertaforeSso = user.platformAdditionalInfo?.useVertaforeSso;
  if (!username || !password) {
    throw new Error("AgencyZoom credentials are missing for token refresh");
  }

  const token = await authenticate(username, password, useVertaforeSso);

  user.accessToken = token;
  await user.save();

  return token;
}

/* ---------------- USER INFO ---------------- */

async function getUserInfo({ hostname, additionalInfo }) {
  // rcAccountId, rcExtensionId, rcUserName, rcUserEmail arrive via the manifest's
  // rcAdditionalSubmission (auto from RC cached data — no user prompt, no framework change).
  const { username, password, useVertaforeSso, rcAccountId, rcExtensionId, rcUserName, rcUserEmail } = additionalInfo ?? {};

  if (!hostname || !username || !password) {
    return {
      successful: false,
      platformUserInfo: { id: "", name: "", platformAdditionalInfo: {} },
      returnMessage: { messageType: "error", message: "Missing AgencyZoom login details.", ttl: 3000 }
    };
  }

  // Per-user uniqueness (mirrors ServiceTitan): the extension id is preferred, but only
  // when it's genuinely distinct from the account id — observed RC cached data can surface
  // the same number for both (extensionInfo.id == account.id), which would collapse every
  // user onto one record/seat. In that case (or when the extension id is missing) we key
  // on the email, which is reliably per-user. The sanitized AZ username is the final
  // fallback since it is always present.
  const emailKey = rcUserEmail ? rcUserEmail.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '';
  const usernameKey = String(username).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const perUserKey =
    (rcExtensionId && String(rcExtensionId) !== String(rcAccountId)) ? String(rcExtensionId)
      : (emailKey || usernameKey || (rcExtensionId ? String(rcExtensionId) : ''));
  const userId = (rcAccountId && perUserKey)
    ? `az-user-${rcAccountId}-${perUserKey}`
    : `az-user-${rcAccountId || 'noacct'}-${perUserKey || 'unknown'}`;
  const displayName = rcUserName || rcUserEmail || username || 'AgencyZoom User';

  apiLog.logStart('AgencyZoom', 'getUserInfo', { userId, username, rcAccountId });

  let company = null;
  let needsSeat = false;
  if (models && models.companies && models.customer && rcAccountId) {
    try {
      const cleanHostname = hostname ? String(hostname).trim().toLowerCase() : '';
      if (cleanHostname) {
        company = await models.companies.findOne({
          where: { rcAccountId: String(rcAccountId), hostname: cleanHostname, status: true },
          raw: true
        });
      }
      if (!company) {
        company = await models.companies.findOne({
          where: { rcAccountId: String(rcAccountId), status: true },
          raw: true
        });
      }
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

      // Only a genuinely new user needs a seat; existing users already hold one.
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

        needsSeat = true;
      }
    } catch (err) {
      console.error('Error enforcing customer seat limits:', err);
    }
  }

  try {
    const token = await authenticate(username, password, useVertaforeSso);

    // Login succeeded — now it's safe to consume the seat (only for a genuinely new user).
    // Kept in its own try so a seat-write hiccup never fails an otherwise-valid login.
    if (needsSeat && company && models?.customer) {
      try {
        await models.customer.create({
          sysId: String(userId),
          companyId: company.id,
          email: rcUserEmail || username || '',
          firstname: displayName,
          platform: 'gate6.agencyzoom',
          hostname,
          rcAccountId
        });
      } catch (err) {
        console.error('Error creating customer seat row:', err);
      }
    }

    apiLog.logSuccess('AgencyZoom', 'getUserInfo', { userId, apiEndpoint: `${AZ_BASE_URL}/auth/${isVertaforeSso(useVertaforeSso) ? 'ssologin' : 'login'}` });

    return {
      successful: true,
      platformUserInfo: {
        id: userId,
        name: displayName,
        email: username,
        overridingApiKey: token,
        platformAdditionalInfo: {
          username,
          password: encode(password),
          useVertaforeSso: isVertaforeSso(useVertaforeSso)
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

// Create an AgencyZoom customer carrying `phoneNumber`, split `name` into first/last, and
// derive the agentId from the JWT the same way createContact does. Shared by createContact and
// the log write-back so both build the customer identically. Returns { id, name }.
async function createCustomerRecord({ auth, name, phoneNumber }) {
  const phone = normalizePhone(phoneNumber);
  const [firstName, ...rest] = (name || '').trim().split(" ");
  const lastName = rest.join(" ") || firstName;
  const email = `${phone}@ringcentral.local`;

  let agentId;
  try {
    const jwtPayload = JSON.parse(Buffer.from(auth.split(".")[1], "base64").toString());
    agentId = parseInt(Buffer.from(jwtPayload?.jti?.agent || "", "base64").toString(), 10);
  } catch (err) {
    agentId = undefined;
  }

  const res = await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/customers/create`,
    { firstname: firstName, lastname: lastName, phone, email, agentId },
    { headers: { Authorization: `Bearer ${auth}` }, _operation: 'createContact' }
  );

  return { id: res.data.id, name: `${firstName} ${lastName}`.trim() };
}

// Write `phoneNumber` onto an existing AgencyZoom customer, preserving its name/email so the
// PUT (which replaces the record) doesn't blank them. Used to fill an empty phone field rather
// than creating a duplicate customer. Endpoint: PUT /v1/api/customers/{customerId} with a
// CustomerUpdateRequest body (per the AgencyZoom OpenAPI spec). Throws on failure.
async function updateCustomerPhone({ auth, customer, phoneNumber }) {
  const phone = normalizePhone(phoneNumber);
  await agencyZoomApiClient.put(
    `${AZ_BASE_URL}/customers/${customer.id}`,
    {
      firstname: customer.firstname,
      lastname: customer.lastname,
      email: customer.email,
      phone
    },
    { headers: { Authorization: `Bearer ${auth}` }, _operation: 'updateContact' }
  );
}

// AgencyZoom customers hold a single phone. Decide, for the number this interaction came in on,
// where to log:
//   - already on the picked customer          -> log against it unchanged (no-op)
//   - another customer already has this number -> reuse that customer (never duplicate the number)
//   - picked customer's phone is EMPTY         -> fill it in on the SAME customer
//   - picked customer has a DIFFERENT number   -> create a NEW customer and log there
// Returns the customer to log against. Falls back to the picked contact if anything fails.
//
// The picked customer's stored number is NOT on contactInfo — core sets contactInfo.phoneNumber
// to the CALL's number — so read the customer by id and compare. If that read fails we leave the
// picked contact untouched rather than risk a duplicate.
async function resolveLogTarget({ auth, contactInfo, receivedNumber, logPrefix }) {
  if (!receivedNumber || !contactInfo?.id) return contactInfo;

  let customer = null; // null = couldn't read
  try {
    const res = await agencyZoomApiClient.get(
      `${AZ_BASE_URL}/customers/${contactInfo.id}`,
      { headers: { Authorization: `Bearer ${auth}` }, _operation: 'createCallLog' }
    );
    customer = res.data || null;
  } catch (err) {
    console.warn(`${logPrefix} could not read customer to compare numbers:`, err?.response?.data || err.message);
  }
  if (!customer) return contactInfo;

  const existingPhone = (customer.phone || '').toString();
  if (!phoneWriteback.isNewNumberForContact(receivedNumber, existingPhone)) return contactInfo; // picked already has it

  // Identity is NAME + number: the user picked a name (e.g. "emma"), so reuse only a customer with
  // that SAME name that already carries this number — never a different-named customer who happens
  // to own the number (e.g. "freya"). This both stops duplicate emmas AND stops the log landing on
  // freya. If no same-named customer has the number, we fall through to fill/create so a customer
  // of the picked name ends up owning it.
  const pickedName = String(contactInfo?.name || '').trim().toLowerCase();
  try {
    const searchRes = await agencyZoomApiClient.post(
      `${AZ_BASE_URL}/customers`,
      { phone: normalizePhone(receivedNumber) },
      { headers: { Authorization: `Bearer ${auth}` }, _operation: 'createCallLog' }
    );
    const match = (searchRes.data?.customers || []).find(c => {
      if (String(c.id) === String(contactInfo.id)) return false;
      const cName = (c.housename || [c.firstname, c.middlename, c.lastname].filter(Boolean).join(' ')).trim().toLowerCase();
      return cName === pickedName;
    });
    if (match) {
      const matchName = match.housename || [match.firstname, match.middlename, match.lastname].filter(Boolean).join(' ');
      console.log(`${logPrefix} reusing existing same-name customer for number:`, match.id);
      return { ...contactInfo, id: match.id, name: matchName || contactInfo.name, phone: receivedNumber, phoneNumber: receivedNumber };
    }
  } catch (err) {
    console.warn(`${logPrefix} could not search customers for existing number:`, err?.response?.data || err.message);
  }

  // No customer has this number yet. If the picked customer's phone is empty, fill it in place.
  if (!existingPhone.replace(/\D/g, '')) {
    try {
      await updateCustomerPhone({ auth, customer, phoneNumber: receivedNumber });
      console.log(`${logPrefix} filled empty phone on existing customer:`, contactInfo.id);
      return { ...contactInfo, phone: receivedNumber, phoneNumber: receivedNumber };
    } catch (err) {
      console.warn(`${logPrefix} failed to fill empty phone; creating new customer instead:`, err?.response?.data || err.message);
      // fall through to create a new customer
    }
  }

  // Picked customer holds a different number and none exists for this one: create a new customer.
  try {
    const created = await createCustomerRecord({ auth, name: contactInfo?.name, phoneNumber: receivedNumber });
    console.log(`${logPrefix} created new customer for new number:`, created.id);
    return { ...contactInfo, id: created.id, name: created.name, phone: receivedNumber, phoneNumber: receivedNumber };
  } catch (err) {
    console.warn(`${logPrefix} failed to create customer for new number:`, err?.response?.data || err.message);
    return contactInfo;
  }
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

    // AgencyZoom's customer search is POST /customers with a CustomerSearchRequest body
    // (same endpoint findContact uses for phone). `fullName` does a name lookup.
    const res = await agencyZoomApiClient.post(
      `${AZ_BASE_URL}/customers`,
      { fullName: name || "" },
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
      phone: c.phone,
      type: "contact"
    }));

    apiLog.logSuccess('AgencyZoom', 'findContactWithName', { name, matchedCount: customers.length, apiEndpoint: `${AZ_BASE_URL}/customers` });

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

  const created = await createCustomerRecord({ auth, name: newContactName, phoneNumber });

  apiLog.logSuccess('AgencyZoom', 'createContact', { contactId: created.id, phoneNumber, apiEndpoint: `${AZ_BASE_URL}/customers/create` });

  await trackAnalytics({ user, crm: 'AgencyZoom', event: 'contactCreated' });

  return {
    contactInfo: {
      id: created.id,
      name: created.name
    },
    returnMessage: {
      message: "Contact created.",
      messageType: "success",
      ttl: 2000
    }
  };
}

/* ---------------- CREATE CALL LOG ---------------- */

async function createCallLog({ user, contactInfo, callLog, note, aiNote, transcript, additionalSubmission }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const auth = await getRefreshedAuthToken(user);
  const logId = `az-log-${Date.now().toString(36)}`;

  // If this call came in on a number the picked contact doesn't have, log against a new customer
  // carrying that number (AgencyZoom holds a single phone, so it can't be appended). `target` is
  // the picked contact otherwise.
  const receivedNumber = phoneWriteback.resolveCounterpartyNumber({ callLog });
  const target = await resolveLogTarget({ auth, contactInfo, receivedNumber, logPrefix: '[AgencyZoom] createCallLog:' });

  apiLog.logStart('AgencyZoom', 'createCallLog', { contactId: target?.id, logId, direction: callLog?.direction, duration: callLog?.duration });

  // Never leave the subject blank (matches ServiceTitan's create-side fallback).
  const defaultSubject = `${callLog?.direction || ''} Call ${callLog?.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo?.name || 'contact'}`.trim();
  const subject =
    (user.userSettings?.addCallLogSubject?.value ?? true)
      ? (callLog?.customSubject?.trim() || defaultSubject)
      : "";

  const startTimeText = callLog?.startTime ? formatDateTime({ user, time: callLog.startTime }) : "";
  const endTimeText = (callLog?.startTime && callLog?.duration)
    ? formatDateTime({ user, time: moment(callLog.startTime).add(callLog.duration, "seconds") })
    : "";

  // Direction-based phone resolution: on an inbound call the contact is the caller (`from`)
  // and the RC user is the callee (`to`); on outbound it's reversed.
  const isInbound = callLog?.direction === 'Inbound';
  const contactPhone = (isInbound ? callLog?.from?.phoneNumber : callLog?.to?.phoneNumber)
    || contactInfo?.phoneNumber || contactInfo?.phone || "";
  const rcPhone = (isInbound ? callLog?.to?.phoneNumber : callLog?.from?.phoneNumber) || "";

  const noteBody = composeCallLogNote({
    user,
    logId,
    subject,
    direction: callLog?.direction,
    result: callLog?.result,
    duration: callLog?.duration,
    callSessionId: callLog?.sessionId,
    rcUserName: additionalSubmission?.rcUserName,
    rcPhone,
    contactPhone,
    note,
    recording: callLog?.recording?.link,
    transcript,
    aiNote,
    startTimeText,
    endTimeText
  });

  await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/customers/${target.id}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` }, _operation: 'createCallLog' }
  );

  apiLog.logSuccess('AgencyZoom', 'createCallLog', { logId, contactId: Number(target.id), apiEndpoint: `${AZ_BASE_URL}/customers/${target.id}/notes` });

  await trackAnalytics({ user, crm: 'AgencyZoom', event: 'callLogCreated' });

  return {
    logId,
    contactId: Number(target.id),
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

  // Fetch the current note for this logId so we can PRESERVE fields the caller didn't re-supply.
  // AgencyZoom has no get-note-by-id, so scan the contact's notes (same as getCallLog). Falls
  // back to the framework-supplied details. Without this, a recording-only or disposition-only
  // sync would wipe the note/recording/transcript/AI note that were already logged.
  let oldBody = "";
  try {
    const res = await agencyZoomApiClient.get(
      `${AZ_BASE_URL}/customers/${contactId}`,
      { headers: { Authorization: `Bearer ${auth}` }, _operation: 'updateCallLog' }
    );
    oldBody = buildNoteIndex(res.data?.notes || [])[logId]?.body || "";
  } catch (err) {
    console.warn('[AgencyZoom][updateCallLog] could not fetch existing note, will fall back to supplied details:', err.message);
  }
  if (!oldBody) {
    oldBody = existingCallLogDetails?.body || existingCallLogDetails?.note || existingCallLogDetails?.fullBody || "";
  }

  const normalized = (oldBody || "").replace(/\r\n/g, '\n');

  // Parse the previously-stored fields (terminate multi-line sections at the next "Header:" line).
  const oldSubject = normalized.match(/^\s*Subject:\s*(.*)$/m)?.[1]?.trim() || "";
  const oldDirection = normalized.match(/^\s*Direction:\s*(.*)$/m)?.[1]?.trim() || "";
  const oldResult = normalized.match(/^\s*Result:\s*(.*)$/m)?.[1]?.trim() || "";
  const oldDuration = normalized.match(/^\s*Duration:\s*(.*)$/m)?.[1]?.replace(/\s*sec$/i, '').trim() || "";
  const oldCallSessionId = normalized.match(/^\s*Call Session ID:\s*(.*)$/m)?.[1]?.trim() || "";
  const oldRcUserName = normalized.match(/^\s*RingCentral Username:\s*(.*)$/m)?.[1]?.trim() || "";
  const oldRcPhone = normalized.match(/^\s*RingCentral Phone Number:\s*(.*)$/m)?.[1]?.trim() || "";
  const oldContactPhone = normalized.match(/^\s*Contact Number:\s*(.*)$/m)?.[1]?.trim() || "";
  const oldNote = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/)?.[1]?.trim() || "";
  const oldRecording = normalized.match(/Recording:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/)?.[1]?.trim() || "";
  const oldTranscript = normalized.match(/Transcript:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/i)?.[1]?.trim() || "";
  const oldAiNote = normalized.match(/AI Note\s*:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/i)?.[1]?.trim() || "";
  const oldStart = normalized.match(/^\s*Start Time:\s*(.*)$/m)?.[1]?.trim() || "";
  const oldEnd = normalized.match(/^\s*End Time:\s*(.*)$/m)?.[1]?.trim() || "";

  // Merge: prefer the incoming value, else keep what the original log already had.
  let decodedRecording = recordingLink;
  if (recordingLink) {
    try { decodedRecording = decodeURIComponent(recordingLink); } catch (err) { decodedRecording = recordingLink; }
  }

  const effNote = note || oldNote;
  const effRecording = decodedRecording || oldRecording;
  const effTranscript = transcript || oldTranscript;
  const effAiNote = aiNote || oldAiNote;
  const resolvedDirection = oldDirection || existingCallLog?.direction || "";
  const resolvedResult = result ?? (oldResult || existingCallLog?.result || "");
  const resolvedDuration = duration != null ? String(duration) : (oldDuration || String(existingCallLog?.duration ?? ""));

  // Start/End time: prefer freshly-supplied startTime, else keep the previously-formatted text.
  let startTimeText = oldStart;
  let endTimeText = oldEnd;
  if (startTime) {
    startTimeText = formatDateTime({ user, time: startTime });
    const durForEnd = duration != null ? duration : Number(oldDuration) || 0;
    endTimeText = formatDateTime({ user, time: moment(startTime).add(durForEnd, "seconds") });
  }

  // Subject: incoming wins; else keep the old one (ignoring a stale "Direction:" leak); else a fallback.
  let subjectToUse = oldSubject && !oldSubject.toLowerCase().startsWith("direction:") ? oldSubject : "";
  if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
    subjectToUse = subject.trim();
  }
  if (!subjectToUse) {
    subjectToUse = resolvedDirection ? `${resolvedDirection} Call` : "Call";
  }

  const noteBody = composeCallLogNote({
    user,
    logId,
    subject: subjectToUse,
    direction: resolvedDirection,
    result: resolvedResult,
    duration: resolvedDuration,
    callSessionId: oldCallSessionId,
    rcUserName: oldRcUserName,
    rcPhone: oldRcPhone,
    contactPhone: oldContactPhone,
    note: effNote,
    recording: effRecording,
    transcript: effTranscript,
    aiNote: effAiNote,
    startTimeText,
    endTimeText
  });

  await agencyZoomApiClient.post(
    `${AZ_BASE_URL}/customers/${contactId}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` }, _operation: 'updateCallLog' }
  );

  apiLog.logSuccess('AgencyZoom', 'updateCallLog', { logId, contactId, apiEndpoint: `${AZ_BASE_URL}/customers/${contactId}/notes` });

  await trackAnalytics({ user, crm: 'AgencyZoom', event: 'callLogUpdated' });

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

  const notes = res.data?.notes || [];

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
  const agentMatch = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/);

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

  // Same as createCallLog: if this message came in on a number the picked contact lacks, log
  // against a new customer carrying that number. `target` is the picked contact otherwise.
  const receivedNumber = phoneWriteback.resolveCounterpartyNumber({ message });
  const target = await resolveLogTarget({ auth, contactInfo, receivedNumber, logPrefix: '[AgencyZoom] createMessageLog:' });

  apiLog.logStart('AgencyZoom', 'createMessageLog', { contactId: target?.id, logId, messageType, direction: message?.direction });

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
    `${AZ_BASE_URL}/customers/${target.id}/notes`,
    { note: noteBody },
    { headers: { Authorization: `Bearer ${auth}` }, _operation: 'createMessageLog' }
  );

  apiLog.logSuccess('AgencyZoom', 'createMessageLog', { logId, contactId: Number(target.id), apiEndpoint: `${AZ_BASE_URL}/customers/${target.id}/notes` });

  await trackAnalytics({ user, crm: 'AgencyZoom', event: 'messageLogCreated' });

  return {
    logId,
    contactId: Number(target.id),
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

  await trackAnalytics({ user, crm: 'AgencyZoom', event: 'messageLogUpdated' });

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
exports.findContactWithName = findContactWithName;
exports.createContact = createContact;
exports.unAuthorize = unAuthorize;
exports.findContactWithName = findContactWithName;
exports.getLogFormatType = getLogFormatType;
exports.getRefreshedAuthToken = getRefreshedAuthToken;
exports.getLicenseStatus = getLicenseStatus
export { };
