/* eslint-disable no-param-reassign */
const axios = require('axios');
const apiLog = require('../shared/apiLogger');
const serviceTitanApiClient = axios.create();
apiLog.installErrorInterceptor(serviceTitanApiClient, 'ServiceTitan');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const jwt = require('@app-connect/core/lib/jwt');
const { UserModel } = require('@app-connect/core/models/userModel');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { messageLogModel } = require('@app-connect/core/models/messageLogModel');
const { AdminConfigModel } = require('@app-connect/core/models/adminConfigModel');
const qs = require('qs');
// const bcrypt = require('bcrypt');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');
const models = initModels(sequelize);

function getAuthType() {
    return 'apiKey';
}

function getBasicAuth({ apiKey }) {
    return Buffer.from(`${apiKey}`).toString('base64');
}


async function getCompanyFromUser(user) {
    const sysId = user.id || user.dataValues?.id;
    if (!sysId) throw new Error('User ID not found in session');
    
    const customer = await models.customer.findOne({ where: { sysId } });
    if (!customer) throw new Error('Customer not found for user: ' + sysId);
    
    const company = await models.companies.findOne({ where: { id: customer.companyId } });
    if (!company) throw new Error('Company not found for customer: ' + customer.sysId);
    
    return company;
}

async function getUserInfo(authHeader) {
  apiLog.logStart('ServiceTitan', 'getUserInfo', { rcAccountId: authHeader.rcAccountId, rcExtensionId: authHeader.rcExtensionId });
  const { hostname, additionalInfo, rcAccountId, rcExtensionId } = authHeader;
  const email = additionalInfo?.email || additionalInfo?.username;

  try {
    const company = await models.companies.findOne({
      where: rcAccountId ? { hashedRcAccountId: rcAccountId, hostname } : { hostname },
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
      tenantId,
      apiKey : stAppKey,
      customers = []
    } = company;

    // Config validation
    if (!clientId || !clientSecret || !tenantId || !stAppKey) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: 'ServiceTitan configuration incomplete.',
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

    // Check existing user
    let customer = customers.find(c => c.email === email);
    
    if (customer) {
        const linkedExtensionId = customer.platformAdditionalInfo?.rcExtensionId;
        if (linkedExtensionId && rcExtensionId && linkedExtensionId !== rcExtensionId) {
            return {
                successful: false,
                platformUserInfo: { id: "", name: "", timezoneName: "", timezoneOffset: "", platformAdditionalInfo: {} },
                returnMessage: {
                    messageType: 'error',
                    message: 'This Email account is already linked to another RingCentral user.',
                    ttl: 5000
                }
            };
        } else if (!linkedExtensionId && rcExtensionId) {
            const updatedPlatformInfo = { ...customer.platformAdditionalInfo, rcExtensionId };
            await customer.update({ platformAdditionalInfo: updatedPlatformInfo });
        }
    }

    // Generate ServiceTitan token
    const accessToken = await generateServiceTitanToken(clientId, clientSecret);
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
        sysId: `st-user-${email}`,
        email,
        companyId: company.id,
        hostname: hostname,
        accessToken: accessToken,
        tokenExpiry: Date.now() + ((900 - 60) * 1000),
        platformAdditionalInfo: {
          rcExtensionId,
          expiresAt: Date.now() + ((900 - 60) * 1000)
        },
        status: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    return {
      successful: true,
      platformUserInfo: {
        id: `st-user-${email}`,
        name: email,
        email,
        overridingApiKey: accessToken,
        platformAdditionalInfo: {
          rcExtensionId,
          expiresAt: Date.now() + ((900 - 60) * 1000)
        }
      },
      returnMessage: {
        messageType: 'success',
        message: 'Successfully connected to ServiceTitan.',
        ttl: 3000
      }
    };
    apiLog.logSuccess('ServiceTitan', 'getUserInfo', { rcAccountId: authHeader.rcAccountId, rcExtensionId: authHeader.rcExtensionId });

  } catch (err) {
    console.error('AUTO ST LOGIN ERROR:', err?.response?.data || err.message);

    return {
      successful: false,
      returnMessage: {
        messageType: 'error',
        message: 'Automatic ServiceTitan authentication failed.',
        ttl: 3000
      }
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
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    return authRes.data.access_token;
}

async function unAuthorize({ user }) {
    user.accessToken = '';
    user.refreshToken = '';
    await user.save();
    return {
        returnMessage: {
            messageType: 'success',
            message: 'Logged out of Service Titan',
            ttl: 1000
        }
    }
}

async function findContact({ user, phoneNumber, isExtension }) {
    apiLog.logStart('ServiceTitan', 'findContact', { phoneNumber, isExtension });
    const auth = await getRefreshedAuthToken(user);
    const company = await getCompanyFromUser(user);
    const tenantId = company.tenantId;
    const stAppKey = company.apiKey;
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
    const personInfo = await serviceTitanApiClient.get(
        `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers?phone=${phoneNumberWithoutCountryCode}`,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': stAppKey
            }
        });

    if (personInfo.data && personInfo.data.data) {
        for (let rawPersonInfo of personInfo.data.data) {
            rawPersonInfo['phoneNumber'] = phoneNumber;
            matchedContactInfo.push(formatContact(rawPersonInfo));
        }
    }
    matchedContactInfo.push({
        id: 'createNewContact',
        name: 'Create new contact...',
        isNewContact: true
    });
    apiLog.logSuccess('ServiceTitan', 'findContact', { matchedCount: matchedContactInfo.length });
    return {
        successful: true,
        matchedContactInfo
    };
}

async function findContactWithName({ user, name }) {
    apiLog.logStart('ServiceTitan', 'findContactWithName', { name });
    const auth = await getRefreshedAuthToken(user);
    const company = await getCompanyFromUser(user);
    const tenantId = company.tenantId;
    const stAppKey = company.apiKey;

    const matchedContactInfo = [];

    if (!name || name.trim() === '') {
        return {
            successful: false,
            matchedContactInfo: [],
            message: 'Name is required.'
        };
    }

    try {
        const personInfo = await serviceTitanApiClient.get(
            `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers?name=${name}`,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                }
            }
        );

        if (personInfo.data && personInfo.data.data) {
            for (let rawPersonInfo of personInfo.data.data) {
                const phone = rawPersonInfo.phones?.find(p => p.type === 'Primary')?.phone ?? '';
                rawPersonInfo['phoneNumber'] = phone;
                matchedContactInfo.push(formatContact(rawPersonInfo));
            }
        }
        apiLog.logSuccess('ServiceTitan', 'findContact', { matchedCount: matchedContactInfo.length });
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
    apiLog.logStart('ServiceTitan', 'createContact', { phoneNumber, newContactName });
    const auth = await getRefreshedAuthToken(user);
    const company = await getCompanyFromUser(user);
    const tenantId = company.tenantId;
    const stAppKey = company.apiKey;

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

        const response = await serviceTitanApiClient.post(
            `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json',
                },
            }
        );

        const createdContact = response.data;

        apiLog.logSuccess('ServiceTitan', 'createContact', { contactId: createdContact.id });
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
    const auth = await getRefreshedAuthToken(user);
    const company = await getCompanyFromUser(user);
    const tenantId = company.tenantId;
    const stAppKey = company.apiKey;

    try {
        const userListResp = await serviceTitanApiClient.get(
            `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers`,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                }
            }
        );

        const userList = userListResp.data?.data?.map(employee => ({
            id: employee.id,
            name: employee.name
        })) || [];

        return userList;
    } catch (error) {
        console.error('Failed to fetch user list:', error?.response?.data || error.message);
        return [];
    }
}

async function fetchJobs({ user, params = {} }) {
    try {
        const auth = await getRefreshedAuthToken(user);
        const company = await getCompanyFromUser(user);
        const tenantId = company.tenantId;
        const stAppKey = company.apiKey;

        const resp = await serviceTitanApiClient.get(
            `${process.env.SERVICE_TITAN_JPM_URI}/${tenantId}/jobs?pageSize=1&jobStatus=Scheduled&customerId=${params?.customerId}`,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                }
            }
        );

        // ServiceTitan responses typically put results under `data` key
        return resp.data?.data || [];
    } catch (err) {
        console.error('fetchJobs error:', err?.response?.data, err?.response, err);
        return [];
    }
}

const HEADER_MARK = '\u0001'; // sentinel for converted header lines; stripped at end
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


async function createCallLog({ user, contactInfo, callLog, note, additionalSubmission, aiNote, transcript, composedLogDetails, hashedAccountId }) {
    apiLog.logStart('ServiceTitan', 'createCallLog', { contactId: contactInfo?.id, direction: callLog?.direction, duration: callLog?.duration });

    const auth = await getRefreshedAuthToken(user);
    const company = await getCompanyFromUser(user);
    const tenantId = company.tenantId;
    const stAppKey = company.apiKey;

    // Fetch jobs of this customer
    const jobs = await fetchJobs({ user, params: { customerId: contactInfo.id } });

    const defaultSubject = `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name}`;
    const subject =
        (user.userSettings?.addCallLogSubject?.value ?? true)
            ? (callLog?.customSubject?.trim() || defaultSubject)
            : "";

    let sections = [];

    if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
        sections.push(`Agent Notes:\n${sanitizeNoteText(note)}`);
    }

    if (callLog?.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) {
        sections.push(`Recording:\n${callLog.recording.link}`);
    }

    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        sections.push(`AI transcript:\n${sanitizeNoteText(transcript)}`);
    }
    
    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
        sections.push(`AI Note :\n${sanitizeNoteText(aiNote)}`);
    }

    const optionalSections = sections.join("\n\n");

    const headerLines = [];
    if (subject) headerLines.push(`Subject: ${subject}`);
    if (callLog.direction) headerLines.push(`Direction: ${callLog.direction}`);
    
    if (callLog?.result && (user.userSettings?.addCallLogResult?.value ?? true)) {
        headerLines.push(`Result: ${callLog.result}`);
    }

    if (callLog?.duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
        headerLines.push(`Duration: ${callLog.duration} sec`);
    }

    if (callLog.sessionId && (user.userSettings?.addCallSessionId?.value ?? true)) {
        headerLines.push(`Call Session ID: ${callLog.sessionId}`);
    }

    const rcUserName = additionalSubmission?.rcUserName;
    if (rcUserName && (user.userSettings?.addRingCentralUserName?.value ?? true)) {
        headerLines.push(`RingCentral Username: ${rcUserName}`);
    }

    const rcPhone = callLog.extensionNumber || (callLog.direction === 'Inbound' ? callLog.to?.phoneNumber : callLog.from?.phoneNumber) || additionalSubmission?.rcPhoneNumber;
    if (rcPhone && (user.userSettings?.addRingCentralNumber?.value ?? true)) {
        headerLines.push(`RingCentral Phone Number: ${rcPhone}`);
    }
    
    const contactPhone = contactInfo?.phoneNumber || contactInfo?.phone;
    if (contactPhone && (user.userSettings?.addCallLogContactNumber?.value ?? true)) {
        headerLines.push(`Contact Number: ${contactPhone}`);
    }

    const footerLines = [];
    if (callLog.startTime && (user.userSettings?.addCallLogDateTime?.value ?? true)) {
        footerLines.push(`Start Time: ${moment(callLog.startTime).format("YYYY-MM-DD HH:mm:ss")}`);
        if (callLog.duration) {
            footerLines.push(`End Time: ${moment(callLog.startTime).add(callLog.duration, "seconds").format("YYYY-MM-DD HH:mm:ss")}`);
        }
    }

    let noteText = headerLines.join("\n");
    if (optionalSections) noteText += `\n\n${optionalSections}`;
    if (footerLines.length > 0) noteText += `\n\n${footerLines.join("\n")}`;

    const contactId = contactInfo.id;

    const noteBody = {
        text: noteText
    };

    let addNoteRes;
    let logType = 'note';

    // ============================================
    // CASE 1 → NO JOB FOUND → Create a CRM Note Only
    // ============================================
    if (!jobs || jobs.length === 0) {

        addNoteRes = await serviceTitanApiClient.post(
            `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers/${contactId}/notes`,
            noteBody,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );
    }

    // ============================================
    // CASE 2 → JOB EXISTS → Update Job Summary
    // ============================================
    else {
        // pick latest job using highest id
        const latestJob = jobs.reduce((max, job) =>
            job.id > max.id ? job : max
        );

        // Update summary with plain text note
        const updateBody = {
            summary: noteText
        };

        addNoteRes = await serviceTitanApiClient.patch(
            `${process.env.SERVICE_TITAN_JPM_URI}/${tenantId}/jobs/${latestJob.id}`,
            updateBody,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );
        logType = 'job';
    }

    apiLog.logSuccess('ServiceTitan', 'createCallLog', { logId: `${addNoteRes.data.id}_${logType}` });
    return {
        logId: `${addNoteRes.data.id}_${logType}`,
        returnMessage: {
            message: 'Call log handled',
            messageType: 'success',
            ttl: 2000
        },
        extraDataTracking: {
            withSmartNoteLog: !!aiNote,
            withTranscript: !!transcript
        }
    };
}


async function updateCallLog({ user, existingCallLog, authHeader, recordingLink, subject, note, startTime, duration, result, aiNote, transcript, additionalSubmission, composedLogDetails, existingCallLogDetails, hashedAccountId }) {
    apiLog.logStart('ServiceTitan', 'updateCallLog', { logId: existingCallLog?.thirdPartyLogId, contactId: existingCallLog?.contactId });
    const auth = await getRefreshedAuthToken(user);
    const company = await getCompanyFromUser(user);
    const tenantId = company.tenantId;
    const stAppKey = company.apiKey;

    const contactId = existingCallLog.contactId;

    let [realId, logType] = existingCallLog.thirdPartyLogId.split('_');
    logType = logType || 'note'; // fallback

    // ---------------- FETCH OLD DATA ----------------
    let body = "";
    if (logType === "note") {
        try {
            const getLogRes = await serviceTitanApiClient.get(
                `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers/${contactId}/notes`,
                { headers: { 'Authorization': `Bearer ${auth}`, 'ST-App-Key': stAppKey } }
            );
            const targetLog = getLogRes.data.data.find(log => log.id == realId);
            if (targetLog) body = targetLog.text || "";
        } catch(e) {
            console.warn('[ServiceTitan][updateCallLog] could not fetch note', { realId, error: e?.message });
        }
    } else {
        try {
            const jobRes = await serviceTitanApiClient.get(
                `${process.env.SERVICE_TITAN_JPM_URI}/${tenantId}/jobs/${realId}`,
                { headers: { 'Authorization': `Bearer ${auth}`, 'ST-App-Key': stAppKey } }
            );
            body = jobRes.data?.summary || "";
        } catch(e) {
            console.warn('[ServiceTitan][updateCallLog] could not fetch job summary', { realId, error: e?.message });
        }
    }

    let subjectToUse = "";
    let direction = "";
    let oldStartTime = "";
    let oldEndTime = "";
    let callSessionId = "";
    let rcUsername = "";
    let rcPhone = "";
    let contactPhone = "";
    let oldResult = "";
    let oldDuration = "";
    let oldNote = "";
    let oldRecording = "";
    let oldAiNote = "";
    let oldTranscript = "";

    if (body) {
        const normalized = body.replace(/\r\n/g, '\n');
        const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/)
        const extractedSubject = subjectMatch?.[1]?.trim();

        if (extractedSubject && !extractedSubject.toLowerCase().startsWith('direction:')) {
            subjectToUse = extractedSubject;
        }
        direction = normalized.match(/^\s*Direction:\s*(.*)$/m)?.[1]?.trim() || "";
        oldStartTime = normalized.match(/^\s*Start Time:\s*(.*)$/m)?.[1]?.trim() || "";
        oldEndTime = normalized.match(/^\s*End Time:\s*(.*)$/m)?.[1]?.trim() || "";
        callSessionId = normalized.match(/^\s*Call Session ID:\s*(.*)$/m)?.[1]?.trim() || "";
        rcUsername = normalized.match(/^\s*RingCentral Username:\s*(.*)$/m)?.[1]?.trim() || "";
        rcPhone = normalized.match(/^\s*RingCentral Phone Number:\s*(.*)$/m)?.[1]?.trim() || "";
        contactPhone = normalized.match(/^\s*Contact Number:\s*(.*)$/m)?.[1]?.trim() || "";
        oldResult = normalized.match(/^\s*Result:\s*(.*)$/m)?.[1]?.trim() || "";
        oldDuration = normalized.match(/^\s*Duration:\s*(.*)$/m)?.[1]?.replace(/\s*sec$/i, '').trim() || "";
        oldNote = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/)?.[1]?.trim() || "";
        oldAiNote = normalized.match(/AI Note\s*:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/i)?.[1]?.trim() || "";
        oldTranscript = normalized.match(/(?:AI transcript|Transcript):\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/i)?.[1]?.trim() || "";
        oldRecording = normalized.match(/Recording:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || "";
    }

    // ---------------- BUILD OPTIONAL SECTIONS ----------------

    let sections = [];

    const effNote = note || oldNote;
    const effRecording = (recordingLink ? decodeURIComponent(recordingLink) : null) || oldRecording;
    const effAiNote = aiNote || oldAiNote;
    const effTranscript = transcript || oldTranscript;
    const effResult = result || oldResult;
    const effDuration = duration || oldDuration;
    const effStartTime = startTime ? moment(startTime).format("YYYY-MM-DD HH:mm:ss") : oldStartTime;
    const effEndTime = (startTime && duration) ? moment(startTime).add(duration, "seconds").format("YYYY-MM-DD HH:mm:ss") : oldEndTime;

    if (effNote && (user.userSettings?.addCallLogNote?.value ?? true)) {
        sections.push(`Agent Notes:\n${sanitizeNoteText(effNote)}`);
    }
    if (effRecording && (user.userSettings?.addCallLogRecording?.value ?? true)) {
        sections.push(`Recording:\n${effRecording}`);
    }
    if (effTranscript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        sections.push(`AI transcript:\n${sanitizeNoteText(effTranscript)}`);
    }
    if (effAiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
        sections.push(`AI Note :\n${sanitizeNoteText(effAiNote)}`);
    }

    if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
        subjectToUse = subject.trim();
    }
    if (!subjectToUse) {
        subjectToUse = direction ? `${direction} Call` : "Call";
    }

    // ---------------- FINAL STRUCTURED NOTE ----------------

    const headerLines = [];
    if (subjectToUse) headerLines.push(`Subject: ${subjectToUse}`);
    if (direction) headerLines.push(`Direction: ${direction}`);
    
    if (effResult && (user.userSettings?.addCallLogResult?.value ?? true)) {
        headerLines.push(`Result: ${effResult}`);
    }
    if (effDuration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
        headerLines.push(`Duration: ${effDuration} sec`);
    }
    if (callSessionId && (user.userSettings?.addCallSessionId?.value ?? true)) {
        headerLines.push(`Call Session ID: ${callSessionId}`);
    }
    if (rcUsername && (user.userSettings?.addRingCentralUserName?.value ?? true)) {
        headerLines.push(`RingCentral Username: ${rcUsername}`);
    }
    if (rcPhone && (user.userSettings?.addRingCentralNumber?.value ?? true)) {
        headerLines.push(`RingCentral Phone Number: ${rcPhone}`);
    }
    if (contactPhone && (user.userSettings?.addCallLogContactNumber?.value ?? true)) {
        headerLines.push(`Contact Number: ${contactPhone}`);
    }

    const footerLines = [];
    if (effStartTime && (user.userSettings?.addCallLogDateTime?.value ?? true)) {
        footerLines.push(`Start Time: ${effStartTime}`);
    }
    if (effEndTime && (user.userSettings?.addCallLogDateTime?.value ?? true)) {
        footerLines.push(`End Time: ${effEndTime}`);
    }

    const optionalSections = sections.join("\n\n");
    let noteText = headerLines.join("\n");
    if (optionalSections) noteText += `\n\n${optionalSections}`;
    if (footerLines.length > 0) noteText += `\n\n${footerLines.join("\n")}`;

    let newLogId;

    // --------------------------- NOTE UPDATE --------------------------
    if (logType === 'note') {

        const postBody = {
            text: noteText
        };

        const addNoteRes = await serviceTitanApiClient.post(
            `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers/${contactId}/notes`,
            postBody,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        newLogId = `${addNoteRes.data.id}_note`;

        let logID_db = await CallLogModel.findOne({
            where: {
                thirdPartyLogId: existingCallLog.thirdPartyLogId,
                contactId: contactId
            }
        });

        if (logID_db) {
            logID_db.thirdPartyLogId = newLogId;
            await logID_db.save();
        }
    }

    // --------------------------- JOB UPDATE --------------------------
    else {

        const updateBody = { summary: noteText };

        await serviceTitanApiClient.patch(
            `${process.env.SERVICE_TITAN_JPM_URI}/${tenantId}/jobs/${realId}`,
            updateBody,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey,
                    'Content-Type': 'application/json'
                }
            }
        );

        newLogId = `${realId}_job`;

        let logID_db = await CallLogModel.findOne({
            where: {
                thirdPartyLogId: existingCallLog.thirdPartyLogId,
                contactId: contactId
            }
        });

        if (logID_db) {
            logID_db.thirdPartyLogId = newLogId;
            await logID_db.save();
        }
    }

    apiLog.logSuccess('ServiceTitan', 'updateCallLog', { logId: newLogId });
    return {
        logId: newLogId,
        updatedNote: noteText,
        returnMessage: {
            message: 'Call log updated',
            messageType: 'success',
            ttl: 2000
        },
        extraDataTracking: {
            withSmartNoteLog: !!aiNote,
            withTranscript: !!transcript
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

async function createMessageLog({ user, contactInfo, authHeader, message, additionalSubmission, recordingLink, faxDocLink }) {
    apiLog.logStart('ServiceTitan', 'createMessageLog', { contactId: contactInfo?.id, direction: message?.direction });
    const auth = await getRefreshedAuthToken(user);
    const company = await getCompanyFromUser(user);
    const tenantId = company.tenantId;
    const stAppKey = company.apiKey;

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

    const contactId = contactInfo.id;
    const postBody = {
        text: noteText
    };

    const addLogRes = await serviceTitanApiClient.post(
        `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers/${contactId}/notes`,
        postBody,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': stAppKey,
                'Content-Type': 'application/json'
            }
        });

    apiLog.logSuccess('ServiceTitan', 'createMessageLog', { logId: addLogRes.data.id });
    return {
        logId: addLogRes.data.id,
        returnMessage: {
            message: 'Message logged as a note',
            messageType: 'success',
            ttl: 1000
        }
    };
}

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, authHeader, recordingLink, faxDocLink }) {
    apiLog.logStart('ServiceTitan', 'updateMessageLog', { contactId: contactInfo?.id, logId: existingMessageLog?.thirdPartyLogId, direction: message?.direction });
    const auth = await getRefreshedAuthToken(user);
    const company = await getCompanyFromUser(user);
    const tenantId = company.tenantId;
    const stAppKey = company.apiKey;

    const contactId = contactInfo.id;
    const noteId = existingMessageLog.thirdPartyLogId;

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    let noteText = "";

    // ---------------- SMS CASE ----------------
    if (messageType === "SMS") {

        const getLogRes = await serviceTitanApiClient.get(
            `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers/${contactId}/notes`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey
                }
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

    const postBody = {
        text: noteText
    };

    const addLogRes = await serviceTitanApiClient.post(
        `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers/${contactId}/notes`,
        postBody,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': stAppKey,
                'Content-Type': 'application/json'
            }
        });

    let messageLogID_db = await messageLogModel.findOne({
        where: {
            thirdPartyLogId: existingMessageLog.thirdPartyLogId,
        }
    });

    if (messageLogID_db) {
        messageLogID_db.userId = existingMessageLog.userId;
        messageLogID_db.platform = existingMessageLog.platform;
        messageLogID_db.thirdPartyLogId = addLogRes.data.id;
        await messageLogID_db.save();
    }

    apiLog.logSuccess('ServiceTitan', 'createMessageLog', { logId: addLogRes.data.id });
    return {
        logId: addLogRes.data.id,
        returnMessage: {
            message: 'Message logged as a note',
            messageType: 'success',
            ttl: 1000
        }
    };
}

async function getCallLog({ user, callLogId, authHeader }) {
    apiLog.logStart('ServiceTitan', 'getCallLog', { logId: callLogId });
    const [realId, logType = 'note'] = callLogId.split('_');

    const auth = await getRefreshedAuthToken(user);
    const company = await getCompanyFromUser(user);
    const tenantId = company.tenantId;
    const stAppKey = company.apiKey;

    let subject = '';
    let note = '';
    let full_data = {};

    try {
        if (logType === 'job') {
            const jobRes = await serviceTitanApiClient.get(
                `${process.env.SERVICE_TITAN_JPM_URI}/${tenantId}/jobs/${realId}`,
                {
                    headers: { 'Authorization': `Bearer ${auth}`, 'ST-App-Key': stAppKey },
                }
            );

            const jobData = jobRes.data;
            if (jobData) {
                const summary = jobData.summary || '';

                const normalized = summary.replace(/\r\n/g, '\n');
                const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/);
                subject = subjectMatch ? subjectMatch[1].trim() : '';

                const notesMatch = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/);
                if (notesMatch) {
                    note = notesMatch[1].trim();
                } else if (!normalized.match(/Start Time:/)) {
                    note = summary;
                }

                full_data = { subject, description: summary };
            }
        } else { // 'note' type
            const existingCallLogDetails = await CallLogModel.findOne({
                where: { thirdPartyLogId: callLogId },
            });

            if (!existingCallLogDetails) {
                console.error(`Could not find call log with thirdPartyLogId: ${callLogId}`);
                return { callLogInfo: { subject: '', note: '', fullLogResponse: {} } };
            }

            const { contactId } = existingCallLogDetails.dataValues;
            const getLogRes = await serviceTitanApiClient.get(
                `${process.env.SERVICE_TITAN_CRM_URI}/${tenantId}/customers/${contactId}/notes`,
                {
                    headers: { 'Authorization': `Bearer ${auth}`, 'ST-App-Key': stAppKey },
                }
            );

            const logData = getLogRes.data;
            if (Array.isArray(logData.data)) {
                const targetLog = logData.data.find(log => log.id == realId);
                if (targetLog) {
                    try {
                        let body = targetLog.text || '';
                        
                        let parsedText = null;
                        try { parsedText = JSON.parse(body); } catch {}
                        
                        if (parsedText && typeof parsedText === 'object') {
                            body = parsedText.description || parsedText.text || body;
                            subject = parsedText.subject || '';
                        }
                        
                        const normalized = body.replace(/\r\n/g, '\n');
                        const subjectMatch = normalized.match(/Subject:\s*(.*?)(?:\n|$)/);
                        if (subjectMatch) subject = subjectMatch[1].trim();

                        const notesMatch = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/);
                        if (notesMatch) {
                            note = notesMatch[1].trim();
                        } else if (!normalized.match(/Start Time:/)) {
                            note = body;
                        }

                        full_data = parsedText || { subject, description: body };
                    } catch (err) {
                        console.error('Error parsing note text:', err);
                        note = targetLog.text;
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Failed to get call log for ${callLogId}:`, error?.response?.data || error.message);
    }

    apiLog.logSuccess('ServiceTitan', 'getCallLog', { logId: callLogId, logType });
    return {
        callLogInfo: {
            subject,
            fullLogResponse: full_data,
            note,
        },
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
    const { expiresAt } = platformAdditionalInfo || {};
    const company = await getCompanyFromUser(user);
    const client_id = company.clientId;
    const client_secret = company.clientSecret;

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
            }
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
exports.getRefreshedAuthToken = getRefreshedAuthToken;