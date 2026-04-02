/* eslint-disable no-param-reassign */
const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const jwt = require('@app-connect/core/lib/jwt');
const { UserModel } = require('@app-connect/core/models/userModel');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { MessageLogModel } = require('@app-connect/core/models/messageLogModel');
const { AdminConfigModel } = require('@app-connect/core/models/adminConfigModel');
const qs = require('qs');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');
const models = initModels(sequelize);

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

function getAuthType() {
    return 'apiKey';
}

function getBasicAuth({ apiKey }) {
    return Buffer.from(`${apiKey}`).toString('base64');
}

async function getUserInfo(authHeader) {
    const { hostname, additionalInfo } = authHeader;
    const email = additionalInfo?.email;

    try {
        const company = await models.companies.findOne({
            where: { hostname },
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
            tenantId,
            apiKey: stAppKey,
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

        // Check existing user
        let customer = customers.find(c => c.email === email);
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
                    client_id: clientId,
                    client_secret: clientSecret,
                    st_app_key: stAppKey,
                    tenant: tenantId,
                    expiresAt: Date.now() + ((900 - 60) * 1000) // 15 min - 1 min buffer
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
                    client_id: clientId,
                    client_secret: clientSecret,
                    st_app_key: stAppKey,
                    tenant: tenantId,
                    expiresAt: Date.now() + ((900 - 60) * 1000) // 15 min - 1 min buffer
                }
            },
            returnMessage: {
                messageType: 'success',
                message: 'Successfully connected to ServiceTitan.',
                ttl: 3000
            }
        };

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

    const authRes = await axios.post(
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
    // const licenseError = await validateLicenseOrFail(user);
    // if (licenseError) return licenseError;

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
    const personInfo = await axios.get(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers?phone=${phoneNumberWithoutCountryCode}`,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': user.dataValues.platformAdditionalInfo.st_app_key
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

    try {
        const personInfo = await axios.get(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers?name=${name}`,
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

        const response = await axios.post(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers`,
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
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    try {
        const userListResp = await axios.get(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers`,
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
        const tenantId = user.dataValues.platformAdditionalInfo.tenant;
        const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

        const resp = await axios.get(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs?pageSize=1&jobStatus=Scheduled&customerId=${params?.customerId}`,
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


async function createCallLog({ user, contactInfo, callLog, note, aiNote, transcript }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const jobs = await fetchJobs({ user, params: { customerId: contactInfo.id } });

    const subject = callLog.customSubject 
        ? callLog.customSubject
        : `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name}`;

    let sections = [];

    if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
        sections.push(`Agent Notes:\n${note}`);
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
        sections.push(`AI Note:\n${aiNote}`);
    }

    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        sections.push(`Transcript:\n${transcript}`);
    }

    const optionalSections = sections.join("\n\n");

    const noteText = `
        Subject: ${subject}
        Direction: ${callLog.direction}
        Start Time: ${moment(callLog.startTime).format("YYYY-MM-DD HH:mm:ss")}
        End Time: ${moment(callLog.startTime).add(callLog.duration, "seconds").format("YYYY-MM-DD HH:mm:ss")}

        ${optionalSections}
        `;

    let addNoteRes;
    let logType = "note";

    if (!jobs || jobs.length === 0) {

        addNoteRes = await axios.post(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactInfo.id}/notes`,
            { text: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey,
                    "Content-Type": "application/json"
                }
            }
        );

    } else {

        const latestJob = jobs.reduce((max, job) => job.id > max.id ? job : max);

        addNoteRes = await axios.patch(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${latestJob.id}`,
            { summary: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey,
                    "Content-Type": "application/json"
                }
            }
        );

        logType = "job";
    }

    return {
        logId: `${addNoteRes.data.id}_${logType}`,
        contactId: contactInfo.id,
        returnMessage: {
            message: "Call log created",
            messageType: "success",
            ttl: 2000
        }
    };
}


async function updateCallLog({ user, existingCallLog, recordingLink, note, aiNote, transcript }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const contactId = existingCallLog.contactId;

    let [realId, logType] = existingCallLog.thirdPartyLogId.split("_");
    logType = logType || "note";

    let subject = "";
    let direction = "";
    let startTime = "";
    let endTime = "";

    // ---------------- FETCH OLD DATA ----------------

    if (logType === "note") {

        const getLogRes = await axios.get(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey
                }
            }
        );

        const targetLog = getLogRes.data.data.find(log => log.id == realId);

        if (targetLog) {

            const body = targetLog.text || "";

            subject = body.match(/^\s*Subject:\s*(.*)$/m)?.[1]?.trim() || "";
            direction = body.match(/^\s*Direction:\s*(.*)$/m)?.[1]?.trim() || "";
            startTime = body.match(/^\s*Start Time:\s*(.*)$/m)?.[1]?.trim() || "";
            endTime = body.match(/^\s*End Time:\s*(.*)$/m)?.[1]?.trim() || "";
        }
    }

    // ---------------- BUILD OPTIONAL SECTIONS ----------------

    let sections = [];

    if (note && (user.userSettings?.addCallLogNote?.value ?? true)) {
        sections.push(`Agent Notes:\n${note}`);
    }

    if (recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) {
        sections.push(`Recording:\n${recordingLink}`);
    }

    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
        sections.push(`AI Note:\n${aiNote}`);
    }

    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        sections.push(`Transcript:\n${transcript}`);
    }

    const optionalSections = sections.join("\n\n");

    // ---------------- FINAL STRUCTURED NOTE ----------------

    const noteText = `
        Subject: ${subject}
        Direction: ${direction}
        Start Time: ${startTime}
        End Time: ${endTime}

        ${optionalSections}
        `.trim();

    let newLogId;

    // ---------------- UPDATE NOTE ----------------

    if (logType === "note") {

        const addNoteRes = await axios.post(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
            { text: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey,
                    "Content-Type": "application/json"
                }
            }
        );

        newLogId = `${addNoteRes.data.id}_note`;
    }

    // ---------------- UPDATE JOB ----------------

    else {

        await axios.patch(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${realId}`,
            { summary: noteText },
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey,
                    "Content-Type": "application/json"
                }
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

    const addLogRes = await axios.post(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
        { text: noteText },
        {
            headers: {
                Authorization: `Bearer ${auth}`,
                "ST-App-Key": stAppKey,
                "Content-Type": "application/json"
            }
        }
    );

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

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const contactId = contactInfo.id;
    const noteId = existingMessageLog.thirdPartyLogId;

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    let noteText = "";

    // ---------------- SMS CASE ----------------
    if (messageType === "SMS") {

        const getLogRes = await axios.get(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
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

    const addLogRes = await axios.post(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
        { text: noteText },
        {
            headers: {
                Authorization: `Bearer ${auth}`,
                "ST-App-Key": stAppKey,
                "Content-Type": "application/json"
            }
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

            const jobRes = await axios.get(
                `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${realId}`,
                {
                    headers: {
                        Authorization: `Bearer ${auth}`,
                        "ST-App-Key": stAppKey
                    }
                }
            );

            const summary = jobRes.data?.summary || "";

            subject = summary.match(/^\s*Subject:\s*(.*)$/m)?.[1]?.trim() || "";

            const agentMatch = summary.match(/Agent Notes:\s*([\s\S]*?)(?:\n[A-Z][^\n]*:|$)/);

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

            const getLogRes = await axios.get(
                `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
                {
                    headers: {
                        Authorization: `Bearer ${auth}`,
                        "ST-App-Key": stAppKey
                    }
                }
            );

            const targetLog = getLogRes.data.data.find(log => log.id == realId);

            if (targetLog) {

                const body = targetLog.text || "";

                subject = body.match(/^\s*Subject:\s*(.*)$/m)?.[1]?.trim() || "";

                const agentMatch = body.match(/Agent Notes:\s*([\s\S]*?)(?:\n[A-Z][^\n]*:|$)/);

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

    const authResponse = await axios.post(
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
exports.getLicenseStatus = getLicenseStatus;