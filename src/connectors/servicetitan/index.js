/* eslint-disable no-param-reassign */
const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const jwt = require('@app-connect/core/lib/jwt');
const { UserModel } = require('@app-connect/core/models/userModel');
const { AccountDataModel } = require('@app-connect/core/models/accountDataModel');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { MessageLogModel } = require('@app-connect/core/models/messageLogModel');
const { AdminConfigModel } = require('@app-connect/core/models/adminConfigModel');
const qs = require('qs');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');
const models = sequelize ? initModels(sequelize) : null;

// Env-driven so the same connector works in integration and production (the token URL is
// already env-driven via SERVICETITAN_ACCESS_TOKEN_URI). Defaults to the integration/sandbox
// host so existing behaviour is unchanged. For production set SERVICETITAN_CRM_URL /
// SERVICETITAN_JPM_URL to the api.servicetitan.io equivalents (and matching prod creds).
const SERVICE_TITAN_JPM_URL = process.env.SERVICETITAN_JPM_URL || "https://api-integration.servicetitan.io/jpm/v2/tenant"
const SERVICE_TITAN_CRM_URL = process.env.SERVICETITAN_CRM_URL || "https://api-integration.servicetitan.io/crm/v2/tenant"

const serviceTitanApiClient = axios.create();

const licenseHelper = require('../shared/license');
const apiLog = require('../shared/apiLogger');

function stringifyForLog(value, maxLength = 1200) {
    try {
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
    } catch (error) {
        return String(value);
    }
}

apiLog.installErrorInterceptor(serviceTitanApiClient, 'ServiceTitan');

async function getLicenseStatus({ userId }) {
  return licenseHelper.getLicenseStatus({ models, userId });
}

async function validateLicenseOrFail(user) {
  return licenseHelper.validateLicenseOrFail({ models, user });
}

function getAuthType() {
    return 'apiKey';
}

function getBasicAuth({ apiKey }) {
    return Buffer.from(`${apiKey}`).toString('base64');
}

async function getUserInfo({ additionalInfo }) {
    // RC identity arrives via the manifest's rcAdditionalSubmission (auto-pulled from RC
    // cached data — no user prompt, no framework change). ServiceTitan API auth is
    // app-level (client_credentials); the email field has been removed.
    const { clientId, clientSecret, tenantId, appKey: stAppKey, rcAccountId, rcExtensionId, rcUserName, rcUserEmail } = additionalInfo ?? {};

    if (!clientId || !clientSecret || !tenantId || !stAppKey) {
        return {
            successful: false,
            returnMessage: {
                messageType: 'error',
                message: 'ServiceTitan credentials are not configured. Please ask your admin to set them up via the AppConnect admin panel.',
                ttl: 4000
            }
        };
    }

    // ServiceTitan auth is app-level (client_credentials) — there is no per-user CRM
    // credential. We identify the connected user by their RC identity (one record/seat
    // per RC user) and label them with their RC display name. No email prompt needed.
    //
    // Per-user uniqueness: the extension id is preferred, but only when it's genuinely
    // distinct from the account id — observed RC cached data can surface the same number
    // for both (extensionInfo.id == account.id), which would collapse every user onto one
    // record/seat. In that case (or when the extension id is missing) we key on the email,
    // which is reliably per-user (this is what the original email-based id used).
    const emailKey = rcUserEmail ? rcUserEmail.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '';
    const perUserKey =
        (rcExtensionId && String(rcExtensionId) !== String(rcAccountId)) ? String(rcExtensionId)
        : (emailKey || (rcExtensionId ? String(rcExtensionId) : ''));
    const userId = (rcAccountId && perUserKey)
        ? `st-user-${rcAccountId}-${perUserKey}`
        : `st-user-${rcAccountId || 'noacct'}-${perUserKey || 'unknown'}`;
    const displayName = rcUserName || rcUserEmail || 'ServiceTitan User';

    // Always log the resolved RC identity (no secrets) so the per-user key can be verified.
    console.log('[ServiceTitan][getUserInfo] RC identity', {
        additionalInfoKeys: Object.keys(additionalInfo ?? {}),
        rcAccountId,
        rcExtensionId,
        extIdSameAsAccount: !!(rcExtensionId && String(rcExtensionId) === String(rcAccountId)),
        hasRcUserName: !!rcUserName,
        hasRcUserEmail: !!rcUserEmail,
        userId
    });

    apiLog.logStart('ServiceTitan', 'getUserInfo', { userId, tenantId, rcAccountId });

    try {
        const accessToken = await generateServiceTitanToken(clientId, clientSecret);

        apiLog.logSuccess('ServiceTitan', 'getUserInfo', { userId, tenantId, apiEndpoint: process.env.SERVICETITAN_ACCESS_TOKEN_URI });

        return {
            successful: true,
            platformUserInfo: {
                id: userId,
                name: displayName,
                email: rcUserEmail || '',
                overridingApiKey: accessToken,
                platformAdditionalInfo: {
                    client_id: clientId,
                    client_secret: clientSecret,
                    st_app_key: stAppKey,
                    tenant: tenantId,
                    expiresAt: Date.now() + ((900 - 60) * 1000)
                }
            },
            returnMessage: { messageType: 'success', message: 'Successfully connected to ServiceTitan.', ttl: 3000 }
        };
    } catch (err) {
        console.error('ServiceTitan getUserInfo error:', err?.response?.data || err.message);
        return {
            successful: false,
            returnMessage: { messageType: 'error', message: 'ServiceTitan authentication failed.', ttl: 3000 }
        };
    }
}


// Helper function to generate ServiceTitan token
async function generateServiceTitanToken(clientId, clientSecret) {
    const tokenUrl = process.env.SERVICETITAN_ACCESS_TOKEN_URI;
    const tokenPayload = {
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret
    };

    const authRes = await serviceTitanApiClient.post(
        tokenUrl,
        qs.stringify(tokenPayload),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, _operation: 'generateServiceTitanToken' }
    );

    return authRes.data.access_token;
}

async function unAuthorize({ user }) {
    user.accessToken = '';
    user.refreshToken = '';
    await user.save();
    licenseHelper.clearLicenseCache(user.id ?? user.dataValues?.id);
    return {
        returnMessage: {
            messageType: 'success',
            message: 'Logged out of Service Titan',
            ttl: 1000
        }
    }
}

async function findContact({ user, phoneNumber, isExtension }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'findContact', { phoneNumber, isExtension });

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    if (isExtension === 'true') {
        return {
            successful: false,
            matchedContactInfo: []
        }
    }
    const matchedContactInfo = [];
    phoneNumber = phoneNumber.replace(' ', '+')
    const phoneNumberObj = parsePhoneNumber(phoneNumber);
    let phoneNumberWithoutCountryCode = phoneNumber;
    if (phoneNumberObj.valid) {
        phoneNumberWithoutCountryCode = phoneNumberObj.number.significant;
    }
    const findContactUrl = `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers?phone=${phoneNumberWithoutCountryCode}`;
    const personInfo = await serviceTitanApiClient.get(
        findContactUrl,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': user.dataValues.platformAdditionalInfo.st_app_key
            },
            _operation: 'findContact'
        });

    if (personInfo.data && personInfo.data.data) {
        for (let rawPersonInfo of personInfo.data.data) {
            rawPersonInfo['phoneNumber'] = phoneNumber;
            matchedContactInfo.push(formatContact(rawPersonInfo));
        }
    }

    // No contacts found in ServiceTitan — delete stale cache entry if it exists
    if (matchedContactInfo.length === 0 && user?.rcAccountId) {
      try {
        const deleted = await AccountDataModel.destroy({
          where: {
            rcAccountId: user.rcAccountId,
            platformName: 'servicetitan',
            dataKey: `contact-${phoneNumber}`
          }
        });
        if (deleted > 0) {
          console.log('[ServiceTitan] findContact: deleted stale cache for phone:', phoneNumber);
        }
      } catch (err) {
        console.warn('[ServiceTitan] findContact: failed to delete stale cache:', err.message);
      }
    }

    matchedContactInfo.push({
        id: 'createNewContact',
        name: 'Create new contact...',
        isNewContact: true
    });
    apiLog.logSuccess('ServiceTitan', 'findContact', { phoneNumber, matchedCount: matchedContactInfo.length, apiEndpoint: findContactUrl });
    return {
        successful: true,
        matchedContactInfo
    };
}

async function findContactWithName({ user, name }) {
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const matchedContactInfo = [];

    if (!name || name.trim() === '') {
        return {
            successful: false,
            matchedContactInfo: [],
            message: 'Name is required.'
        };
    }

    apiLog.logStart('ServiceTitan', 'findContactWithName', { name });

    try {
        const findContactWithNameUrl = `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers?name=${name}`;
        const personInfo = await serviceTitanApiClient.get(
            findContactWithNameUrl,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                },
                _operation: 'findContactWithName'
            }
        );

        if (personInfo.data && personInfo.data.data) {
            for (let rawPersonInfo of personInfo.data.data) {
                const phone = rawPersonInfo.phones?.find(p => p.type === 'Primary')?.phone ?? '';
                rawPersonInfo['phoneNumber'] = phone;
                matchedContactInfo.push(formatContact(rawPersonInfo));
            }
        }
        apiLog.logSuccess('ServiceTitan', 'findContactWithName', { name, matchedCount: matchedContactInfo.length, apiEndpoint: findContactWithNameUrl });
        return {
            successful: true,
            matchedContactInfo
        };
    } catch (err) {
        console.error('Error finding contact by name:', err.message);
        return {
            successful: false,
            matchedContactInfo: [],
            message: 'Failed to fetch contact information.'
        };
    }
}

async function createContact({ user, phoneNumber, newContactName }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'createContact', { phoneNumber, newContactName });

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const cleanedPhone = phoneNumber.replace(' ', '+');
    const phoneNumberObj = parsePhoneNumber(cleanedPhone);
    const parsedPhone = phoneNumberObj.valid ? phoneNumberObj.number.significant : cleanedPhone;

    const [firstName, ...lastNameParts] = newContactName.trim().split(' ');
    const lastName = lastNameParts.join(' ') || firstName;
    try {
        const payload = {
            name: `${firstName} ${lastName}`.trim(),
            doNotMail: false,
            doNotService: false,
            locations: [
                {
                    name: `${firstName} ${lastName}`.trim(),
                    address: {
                        street: 'street',
                        city: 'Phoenix',
                        state: 'AZ',
                        zip: '85001',
                        country: 'USA'
                    },
                    contacts: [
                        {
                            type: 'phone',
                            value: parsedPhone,
                            memo: 'Primary contact number',
                        }
                    ],
                },
            ],
            address: {
                street: 'street',
                city: 'Phoenix',
                state: 'AZ',
                zip: '85001',
                country: 'USA'
            },
            contacts: [
                {
                    type: 'phone',
                    value: parsedPhone,
                    memo: 'Primary contact number',
                }
            ],
        };

        const createContactUrl = `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers`;
        const response = await serviceTitanApiClient.post(
            createContactUrl,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json',
                },
                _operation: 'createContact'
            }
        );

        const createdContact = response.data;

        apiLog.logSuccess('ServiceTitan', 'createContact', { contactId: createdContact.id, apiEndpoint: createContactUrl });

        return {
            contactInfo: {
                id: createdContact.id,
                name: createdContact.name
            },
            returnMessage: {
                message: `Contact created.`,
                messageType: 'success',
                ttl: 2000
            }
        };
    } catch (error) {
        console.error('Failed to create contact:', error?.response?.data || error.message);
        return {
            contactInfo: null,
            returnMessage: {
                message: `Failed to create contact.`,
                messageType: 'error',
                ttl: 3000
            }
        };
    }
}

async function getUserList({ user, authHeader }) {
    apiLog.logStart('ServiceTitan', 'getUserList', {});

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    try {
        const getUserListUrl = `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers`;
        const userListResp = await serviceTitanApiClient.get(
            getUserListUrl,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                },
                _operation: 'getUserList'
            }
        );

        const userList = userListResp.data?.data?.map(employee => ({
            id: employee.id,
            name: employee.name
        })) || [];

        apiLog.logSuccess('ServiceTitan', 'getUserList', { count: userList.length, apiEndpoint: getUserListUrl });

        return userList;
    } catch (error) {
        console.error('Failed to fetch user list:', error?.response?.data || error.message);
        return [];
    }
}

async function fetchJobs({ user, params = {} }) {
    try {
        apiLog.logStart('ServiceTitan', 'fetchJobs', { customerId: params?.customerId });

        const auth = await getRefreshedAuthToken(user);
        const tenantId = user.dataValues.platformAdditionalInfo.tenant;
        const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

        const fetchJobsUrl = `${SERVICE_TITAN_JPM_URL}/${tenantId}/jobs?pageSize=1&jobStatus=Scheduled&customerId=${params?.customerId}`;
        const resp = await serviceTitanApiClient.get(
            fetchJobsUrl,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                },
                _operation: 'fetchJobs'
            }
        );

        // ServiceTitan responses typically put results under `data` key
        const jobs = resp.data?.data || [];
        apiLog.logSuccess('ServiceTitan', 'fetchJobs', { customerId: params?.customerId, count: jobs.length, apiEndpoint: fetchJobsUrl });
        return jobs;
    } catch (err) {
        console.error('fetchJobs error:', err?.response?.data, err?.response, err);
        return [];
    }
}


// ServiceTitan notes are PLAIN TEXT (no markdown/HTML rendering), so AI/RingSense content
// arrives with literal "**...**" markers and uneven spacing. This tidies it for plain text:
//  - a short, fully-bold line (a header like **Recap**) -> "Recap:" with a blank line BEFORE
//    it and its content sitting directly UNDER it (no blank line between header and body)
//  - a long fully-bold line (an emphasized sentence)    -> bold markers stripped, kept as text
//  - any remaining inline **bold** / __bold__ / # heading markers -> stripped
//  - trailing spaces removed and runs of 3+ blank lines collapsed to one
const HEADER_MARK = '\u0001'; // sentinel for converted header lines; stripped at end
function sanitizeNoteText(text) {
    if (!text) return '';
    let s = String(text).replace(/\r\n/g, '\n');
    // Fully-bold line: short -> header sentinel "Recap:"; long -> plain emphasized sentence.
    s = s.replace(/^[ \t]*\*\*(.+?)\*\*[ \t]*$/gm, (_, h) => {
        const t = h.trim().replace(/:+$/, '');
        return (t.length <= 30 && t.split(/\s+/).length <= 4) ? `${HEADER_MARK}${t}:` : t;
    });
    // Strip any remaining inline markdown.
    s = s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^[ \t]*#{1,6}[ \t]*/gm, '');
    s = s.replace(/[ \t]+$/gm, '');
    // Header content sits directly under the header: drop blank line(s) right after a header.
    s = s.replace(new RegExp(`${HEADER_MARK}([^\\n]*)\\n\\s*\\n`, 'g'), `${HEADER_MARK}$1\n`);
    // Ensure a blank line BEFORE each header (separating sections), except at the very start.
    s = s.replace(new RegExp(`([^\\n])\\n${HEADER_MARK}`, 'g'), `$1\n\n${HEADER_MARK}`);
    s = s.replace(new RegExp(HEADER_MARK, 'g'), '');
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

async function createCallLog({ user, contactInfo, callLog, note, aiNote, transcript }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'createCallLog', { contactId: contactInfo?.id, direction: callLog?.direction, duration: callLog?.duration });

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    // Restore the 1.0 generated-subject fallback so the activity title is never blank
    // (matches main-gate6 src/adapters/servicetitan/index.js:456). The 2.0 rewrite dropped
    // the `?? generated` part, which both blanked the subject and broke edit-autofill.
    const defaultSubject = `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo?.name || 'contact'}`;
    const subject =
        (user.userSettings?.addCallLogSubject?.value ?? true)
            ? (callLog?.customSubject?.trim() || defaultSubject)
            : ""

    let sections = [];

    if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
        sections.push(`Agent Notes:\n${sanitizeNoteText(note)}`);
    }

    if (contactInfo?.phone && (user.userSettings?.addCallLogContactNumber?.value ?? true)) {
        sections.push(`Contact Number:\n${contactInfo.phone}`);
    }

    if (callLog?.result && (user.userSettings?.addCallLogResult?.value ?? true)) {
        sections.push(`Result:\n${callLog.result}`);
    }

    if (callLog?.duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
        sections.push(`Duration:\n${callLog.duration} sec`);
    }

    if (callLog?.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) {
        sections.push(`Recording:\n${callLog.recording.link}`);
    }

    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
        sections.push(`AI Note:\n${sanitizeNoteText(aiNote)}`);
    }

    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        sections.push(`Transcript:\n${sanitizeNoteText(transcript)}`);
    }

    const optionalSections = sections.join("\n\n");

    // Build the note left-aligned (no leading indentation). The previous template literal
    // indented every line by 8 spaces, which polluted the stored note and made getCallLog's
    // label parsing (and the on-screen format) fragile.
    const headerLines = [
        `Subject: ${subject}`,
        `Direction: ${callLog.direction}`,
        `Start Time: ${moment(callLog.startTime).format("YYYY-MM-DD HH:mm:ss")}`,
        `End Time: ${moment(callLog.startTime).add(callLog.duration, "seconds").format("YYYY-MM-DD HH:mm:ss")}`,
    ];
    const noteText = optionalSections
        ? `${headerLines.join("\n")}\n\n${optionalSections}`
        : headerLines.join("\n");

    // Always log to the customer note. Previously, when a job existed this PATCHed the job's
    // `summary` with the call log — OVERWRITING business data — and attached to an arbitrary
    // "latest job by max id". A call belongs to the customer, so a customer note is the
    // non-destructive home and keeps create/update/get/delete on one consistent path.
    // (If call logs ON the job are wanted, the correct mechanism is Jobs_CreateNote job notes,
    //  not the summary — a separate enhancement.)
    const logType = "note";
    const createCallLogUrl = `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactInfo.id}/notes`;
    const addNoteRes = await serviceTitanApiClient.post(
        createCallLogUrl,
        { text: noteText },
        {
            headers: {
                Authorization: `Bearer ${auth}`,
                "ST-App-Key": stAppKey,
                "Content-Type": "application/json"
            },
            _operation: 'createCallLog'
        }
    );

    const logId = `${addNoteRes.data.id}_${logType}`;
    apiLog.logSuccess('ServiceTitan', 'createCallLog', { logId, contactId: contactInfo.id, apiEndpoint: createCallLogUrl });

    return {
        logId,
        contactId: contactInfo.id,
        returnMessage: {
            message: "Call log created",
            messageType: "success",
            ttl: 2000
        }
    };
}


async function updateCallLog({ user, existingCallLog, recordingLink, note, aiNote, transcript, subject }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'updateCallLog', { logId: existingCallLog?.thirdPartyLogId, contactId: existingCallLog?.contactId });

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const contactId = existingCallLog.contactId;

    let [realId, logType] = existingCallLog.thirdPartyLogId.split("_");
    logType = logType || "note";

    let direction = "";
    let startTime = "";
    let endTime = "";
    let result = "";
    let duration = "";
    // Existing optional fields parsed from the old body so an update preserves them when
    // the caller doesn't re-supply them (a recording-sync / disposition update otherwise
    // wiped the note, recording, AI note and transcript).
    let oldNote = "";
    let oldRecording = "";
    let oldAiNote = "";
    let oldTranscript = "";

    // ---------------- FETCH OLD DATA ----------------
    let body = "";
    if (logType === "note") {

        const getLogRes = await serviceTitanApiClient.get(
            `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey
                },
                _operation: 'updateCallLog'
            }
        );

        const targetLog = getLogRes.data.data.find(log => log.id == realId);

        if (targetLog) {
            body = targetLog.text || "";
        }
    } else {
        const jobRes = await serviceTitanApiClient.get(
            `${SERVICE_TITAN_JPM_URL}/${tenantId}/jobs/${realId}`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey
                },
                _operation: 'updateCallLog'
            }
        );

        body = jobRes.data?.summary || "";
    }
    let subjectToUse = "";
    if (body) {
        const normalized = body.replace(/\r\n/g, '\n');
        const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/)
        const extractedSubject = subjectMatch?.[1]?.trim();

        if (extractedSubject && !extractedSubject.toLowerCase().startsWith('direction:')) {
            subjectToUse = extractedSubject;
        }
        direction = normalized.match(/^\s*Direction:\s*(.*)$/m)?.[1]?.trim() || "";
        startTime = normalized.match(/^\s*Start Time:\s*(.*)$/m)?.[1]?.trim() || "";
        endTime = normalized.match(/^\s*End Time:\s*(.*)$/m)?.[1]?.trim() || "";
        result = normalized.match(/^\s*Result:\s*(.*)$/m)?.[1]?.trim() || "";
        duration = normalized.match(/^\s*Duration:\s*(.*)$/m)?.[1]?.replace(/\s*sec$/i, '').trim() || "";
        // Multi-line fields end at the next "Label:" line; single-line ones at the next newline.
        oldNote = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/)?.[1]?.trim() || "";
        oldAiNote = normalized.match(/AI Note:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/)?.[1]?.trim() || "";
        oldTranscript = normalized.match(/Transcript:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/)?.[1]?.trim() || "";
        oldRecording = normalized.match(/Recording:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || "";
    }

    // ---------------- BUILD OPTIONAL SECTIONS ----------------

    let sections = [];

    // Merge: prefer the incoming value, else keep what the original log already had.
    const effNote = note || oldNote;
    const effRecording = recordingLink || oldRecording;
    const effAiNote = aiNote || oldAiNote;
    const effTranscript = transcript || oldTranscript;

    if (effNote && (user.userSettings?.addCallLogNote?.value ?? true)) {
        sections.push(`Agent Notes:\n${sanitizeNoteText(effNote)}`);
    }
    if (result && (user.userSettings?.addCallLogResult?.value ?? true)) {
        sections.push(`Result:\n${result}`);
    }
    if (duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
        sections.push(`Duration:\n${duration} sec`);
    }
    if (effRecording && (user.userSettings?.addCallLogRecording?.value ?? true)) {
        sections.push(`Recording:\n${effRecording}`);
    }
    if (effAiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
        sections.push(`AI Note:\n${sanitizeNoteText(effAiNote)}`);
    }
    if (effTranscript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        sections.push(`Transcript:\n${sanitizeNoteText(effTranscript)}`);
    }

    if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
        subjectToUse = subject.trim();
    }
    // Never leave the subject blank (matches the create-side fallback).
    if (!subjectToUse) {
        subjectToUse = direction ? `${direction} Call` : "Call";
    }

    const optionalSections = sections.join("\n\n");

    // ---------------- FINAL STRUCTURED NOTE (left-aligned, no indentation) ----------------

    const headerLines = [
        `Subject: ${subjectToUse}`,
        `Direction: ${direction}`,
        `Start Time: ${startTime}`,
        `End Time: ${endTime}`,
    ];
    const noteText = optionalSections
        ? `${headerLines.join("\n")}\n\n${optionalSections}`
        : headerLines.join("\n");

    let newLogId;

    // ---------------- UPDATE NOTE ----------------

    if (logType === "note") {

        // ServiceTitan customer notes have no in-place update endpoint, so an edit is a
        // create-then-delete: post the replacement note, then delete the original so we don't
        // leave a duplicate. Order matters — create first so a delete failure never loses the
        // edited content (worst case is a leftover duplicate, not data loss).
        const addNoteRes = await serviceTitanApiClient.post(
            `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`,
            { text: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey,
                    "Content-Type": "application/json"
                },
                _operation: 'updateCallLog'
            }
        );

        newLogId = `${addNoteRes.data.id}_note`;

        if (realId && String(addNoteRes.data.id) !== String(realId)) {
            try {
                await serviceTitanApiClient.delete(
                    `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes/${realId}`,
                    {
                        headers: { Authorization: `Bearer ${auth}`, "ST-App-Key": stAppKey },
                        _operation: 'updateCallLog'
                    }
                );
            } catch (e) {
                console.warn('[ServiceTitan][updateCallLog] could not delete the old note — a duplicate may remain', { oldNoteId: realId, status: e?.response?.status, message: e?.message });
            }
        }
    }

    // ---------------- UPDATE JOB ----------------

    else {

        await serviceTitanApiClient.patch(
            `${SERVICE_TITAN_JPM_URL}/${tenantId}/jobs/${realId}`,
            { summary: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey,
                    "Content-Type": "application/json"
                },
                _operation: 'updateCallLog'
            }
        );

        newLogId = `${realId}_job`;
    }

    const logID_db = await CallLogModel.findOne({
        where: {
            thirdPartyLogId: existingCallLog.thirdPartyLogId,
            contactId
        }
    });

    if (logID_db) {
        logID_db.thirdPartyLogId = newLogId;
        await logID_db.save();
    }

    apiLog.logSuccess('ServiceTitan', 'updateCallLog', { logId: newLogId, contactId });

    return {
        logId: newLogId,
        returnMessage: {
            message: "Call log updated",
            messageType: "success",
            ttl: 2000
        }
    };
}

async function upsertCallDisposition({ user, existingCallLog, authHeader, dispositions }) {
    return {
        returnMessage: {
            message: 'Call log note updated with disposition',
            messageType: 'success',
            ttl: 2000
        }
    };
}

async function createMessageLog({ user, contactInfo, message, recordingLink, faxDocLink }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'createMessageLog', { contactId: contactInfo?.id, direction: message?.direction });

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const contactId = contactInfo.id;

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    let noteText = "";

    if (messageType === "SMS") {

        const direction =
            message.direction === "Inbound"
                ? contactInfo.name
                : "Agent";

        const line =
            `[${moment(message.creationTime).format("YYYY-MM-DD HH:mm:ss")}] ${direction}: ${message.subject}`;

        noteText = `
Conversation:
${line}
`.trim();

    } else if (messageType === "Voicemail") {

        noteText = `
Voicemail from ${contactInfo.name}

Recording:
${recordingLink}
`.trim();

    } else if (messageType === "Fax") {

        noteText = `
Fax from ${contactInfo.name}

Document:
${faxDocLink}
`.trim();
    }

    const createMessageLogUrl = `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`;
    const addLogRes = await serviceTitanApiClient.post(
        createMessageLogUrl,
        { text: noteText },
        {
            headers: {
                Authorization: `Bearer ${auth}`,
                "ST-App-Key": stAppKey,
                "Content-Type": "application/json"
            },
            _operation: 'createMessageLog'
        }
    );

    apiLog.logSuccess('ServiceTitan', 'createMessageLog', { logId: addLogRes.data.id, contactId, apiEndpoint: createMessageLogUrl });

    return {
        logId: addLogRes.data.id,
        contactId,
        returnMessage: {
            message: "Message logged as a note",
            messageType: "success",
            ttl: 1000
        }
    };
}

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, recordingLink, faxDocLink }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'updateMessageLog', { contactId: contactInfo?.id, logId: existingMessageLog?.thirdPartyLogId, direction: message?.direction });

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const contactId = contactInfo.id;
    const noteId = existingMessageLog.thirdPartyLogId;

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    let noteText = "";

    // ---------------- SMS CASE ----------------
    if (messageType === "SMS") {

        const getLogRes = await serviceTitanApiClient.get(
            `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey
                },
                _operation: 'updateMessageLog'
            }
        );

        const targetLog = getLogRes.data.data.find(log => log.id == noteId);

        let previousConversation = "";

        if (targetLog?.text) {
            const match = targetLog.text.match(/Conversation:\s*([\s\S]*)/);
            if (match) {
                previousConversation = match[1].trim();
            }
        }

        const direction =
            message.direction === "Inbound"
                ? contactInfo.name
                : "Agent";

        const newLine =
            `[${moment(message.creationTime).format("YYYY-MM-DD HH:mm:ss")}] ${direction}: ${message.subject}`;

        const updatedConversation =
            previousConversation
                ? `${previousConversation}\n${newLine}`
                : newLine;

        const MAX_NOTE_SIZE = 30000;

        if (updatedConversation.length > MAX_NOTE_SIZE) {

            const lines = previousConversation.trim().split("\n");
            const lastMessage = lines[lines.length - 1] || "";

            const newThreadConversation =
                `${lastMessage}\n${newLine}`;

            noteText = `
Conversation:
${newThreadConversation}
`.trim();

        } else {

            noteText = `
Conversation:
${updatedConversation}
`.trim();
        }

    }

    // ---------------- VOICEMAIL CASE ----------------
    else if (messageType === "Voicemail") {

        noteText = `
Voicemail from ${contactInfo.name}

Recording:
${recordingLink}
`.trim();
    }

    // ---------------- FAX CASE ----------------
    else if (messageType === "Fax") {

        noteText = `
Fax from ${contactInfo.name}

Document:
${faxDocLink}
`.trim();
    }

    const updateMessageLogUrl = `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`;
    const addLogRes = await serviceTitanApiClient.post(
        updateMessageLogUrl,
        { text: noteText },
        {
            headers: {
                Authorization: `Bearer ${auth}`,
                "ST-App-Key": stAppKey,
                "Content-Type": "application/json"
            },
            _operation: 'updateMessageLog'
        }
    );

    const messageLogID_db = await MessageLogModel.findOne({
        where: {
            thirdPartyLogId: existingMessageLog.thirdPartyLogId
        }
    });

    if (messageLogID_db) {
        messageLogID_db.thirdPartyLogId = addLogRes.data.id;
        await messageLogID_db.save();
    }

    apiLog.logSuccess('ServiceTitan', 'updateMessageLog', { logId: addLogRes.data.id, contactId, apiEndpoint: updateMessageLogUrl });

    return {
        logId: addLogRes.data.id,
        returnMessage: {
            message: "Message log updated",
            messageType: "success",
            ttl: 1000
        }
    };
}
async function getCallLog({ user, callLogId }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'getCallLog', { logId: callLogId });

    const [realId, logType = "note"] = callLogId.split("_");

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    let subject = "";
    let note = "";
    let full_data = {};

    try {

        // ---------------- JOB LOG ----------------
        if (logType === "job") {

            const jobRes = await serviceTitanApiClient.get(
                 `${SERVICE_TITAN_JPM_URL}/${tenantId}/jobs/${realId}`,
                {
                    headers: {
                        Authorization: `Bearer ${auth}`,
                        "ST-App-Key": stAppKey
                    },
                    _operation: 'getCallLog'
                }
            );

            const summary = jobRes.data?.summary || "";
            const normalized = summary.replace(/\r\n/g, '\n');

            const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/);
            subject = subjectMatch ? subjectMatch[1].trim() : '';

            if (!subject || subject.toLowerCase().startsWith('direction:')) {
                subject = '';
            }

            const agentMatch = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n[A-Za-z][^\n]*:|$)/);

            if (agentMatch) {
                note = agentMatch[1].trim();
            }

            full_data = {
                subject,
                description: summary
            };
        }

        // ---------------- NOTE LOG ----------------
        else {

            const existingCallLogDetails = await CallLogModel.findOne({
                where: { thirdPartyLogId: callLogId }
            });

            if (!existingCallLogDetails) {
                return {
                    callLogInfo: {
                        subject: "",
                        note: "",
                        fullLogResponse: {}
                    }
                };
            }

            const contactId = existingCallLogDetails.contactId;

            const getLogRes = await serviceTitanApiClient.get(
                `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`,
                {
                    headers: {
                        Authorization: `Bearer ${auth}`,
                        "ST-App-Key": stAppKey
                    },
                    _operation: 'getCallLog'
                }
            );

            const targetLog = getLogRes.data.data.find(log => log.id == realId);

            if (targetLog) {

                const body = targetLog.text || "";
                const normalized = body.replace(/\r\n/g, '\n');

                const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/);
                subject = subjectMatch ? subjectMatch[1].trim() : '';

                if (!subject || subject.toLowerCase().startsWith('direction:')) {
                    subject = '';
                }

                const agentMatch = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n[A-Za-z][^\n]*:|$)/);

                if (agentMatch) {
                    note = agentMatch[1].trim();
                }

                full_data = body;
            }
        }

    } catch (error) {

        console.error(
            "Failed to fetch call log:",
            error?.response?.data || error.message
        );

    }

    apiLog.logSuccess('ServiceTitan', 'getCallLog', { logId: callLogId, logType });

    return {
        callLogInfo: {
            subject,
            note,
            fullLogResponse: full_data
        }
    };
}

function formatContact(rawContactInfo) {
    const name = rawContactInfo.name || `${rawContactInfo.firstName || ''} ${rawContactInfo.lastName || ''}`.trim();
    return {
        id: rawContactInfo.id,
        name: name,
        phone: rawContactInfo.phoneNumber,
        title: rawContactInfo.jobTitle ?? "",
        type: 'contact'
    }
}

async function getRefreshedAuthToken(user) {
    const { platformAdditionalInfo } = user.dataValues;
    const { client_id, client_secret, expiresAt } = platformAdditionalInfo;

    if (Date.now() < expiresAt) {
        return user.dataValues.accessToken;
    }

    const tokenUrl = process.env.SERVICETITAN_ACCESS_TOKEN_URI;
    const data = {
        grant_type: 'client_credentials',
        client_id: client_id,
        client_secret: client_secret
    };

    const authResponse = await serviceTitanApiClient.post(
        tokenUrl,
        qs.stringify(data),
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            _operation: 'getRefreshedAuthToken'
        }
    );

    const newAccessToken = authResponse.data.access_token;
    const expiresIn = authResponse.data.expires_in;
    const newExpiresAt = Date.now() + ((expiresIn - 60) * 1000);

    user.accessToken = newAccessToken;
    user.platformAdditionalInfo = {
        ...platformAdditionalInfo,
        expiresAt: newExpiresAt
    };
    await user.save();

    return newAccessToken;
}

function getLogFormatType() {
    return 'text/html';
}

exports.getAuthType = getAuthType;
exports.getBasicAuth = getBasicAuth;
exports.getUserInfo = getUserInfo;
exports.getLogFormatType = getLogFormatType;
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
exports.getRefreshedAuthToken = getRefreshedAuthToken;
exports.getLicenseStatus = getLicenseStatus;