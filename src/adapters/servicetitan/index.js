/* eslint-disable no-param-reassign */
const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const jwt = require('@app-connect/core/lib/jwt');
const { UserModel } = require('@app-connect/core/models/userModel');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { messageLogModel } = require('@app-connect/core/models/messageLogModel');
const { AdminConfigModel } = require('@app-connect/core/models/adminConfigModel');
const qs = require('qs');
const bcrypt = require('bcrypt');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');
const models = initModels(sequelize);
const fs = require('fs');
const path = require('path');

const manifestPath = path.join(__dirname, 'manifest.json');
const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function getAuthType() {
    return 'apiKey';
}

function getBasicAuth({ apiKey }) {
    return Buffer.from(`${apiKey}`).toString('base64');
}


async function getUserInfo() {
    try {
        // Load values directly from manifest.json root
        const clientId = manifestData.clientId;
        const clientSecret = manifestData.clientSecret;
        const tenantId = manifestData.tenantId;
        const stAppKey = manifestData.stAppKey;

        if (!clientId || !clientSecret || !tenantId || !stAppKey) {
            console.error("Missing ST config in manifest.json");
            return {
                successful: false,
                returnMessage: {
                    messageType: "error",
                    message: "ServiceTitan config missing in manifest file.",
                    ttl: 3000
                }
            };
        }

        // ST TOKEN GENERATION
        const tokenUrl = "https://auth-integration.servicetitan.io/connect/token";

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

        const accessToken = authRes.data.access_token;

        // AUTO CONNECT RESPONSE
        return {
            successful: true,
            platformUserInfo: {
                id: `st-auto-user`,
                overridingApiKey: accessToken,
                platformAdditionalInfo: {
                    client_id: clientId,
                    client_secret: clientSecret,
                    st_app_key: stAppKey,
                    tenant: tenantId,
                    expiresAt: Date.now() + ((authRes.data.expires_in - 60) * 1000)
                }
            },
            returnMessage: {
                messageType: "success",
                message: "Connected to ServiceTitan.",
                ttl: 1500
            }
        };

    } catch (err) {
        console.error("AUTO ST LOGIN ERROR:", err?.response?.data || err.message);

        return {
            successful: false,
            returnMessage: {
                messageType: "error",
                message: "Automatic ServiceTitan authentication failed.",
                ttl: 3000
            }
        };
    }
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
    // Generic helper to fetch jobs from ServiceTitan JPM API
    // params: an object of query parameters (e.g., { customerId, jobId, status })
    try {
        const auth = await getRefreshedAuthToken(user);
        const tenantId = user.dataValues.platformAdditionalInfo.tenant;
        const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

        // Fetch statuses
        const statusResp = await axios.get(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/job-statuses`,
            { 
                headers: {
                        'Authorization': `Bearer ${auth}`,
                        'ST-App-Key': stAppKey
                    } 
            }
        );

        // Exclude unwanted
        const allowedStatusIds = statusResp.data.data
        .filter(s => !['Completed', 'Canceled'].includes(s.name))
        .map(s => s.id);

        params['statusIds'] = allowedStatusIds

        const resp = await axios.get(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs`,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                },
                params
            }
        );

        // ServiceTitan responses typically put results under `data` key
        return resp.data?.data || [];
    } catch (err) {
        console.error('fetchJobs error:', err?.response?.data || err.message);
        return [];
    }
}

function stripHtml(html = '') {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}


async function createCallLog({ user, contactInfo, callLog, note, additionalSubmission, aiNote, transcript, composedLogDetails, hashedAccountId }) {

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    // Fetch jobs of this customer
    const jobs = await fetchJobs({ user, params: { customerId: contactInfo.id } });

    const subject = callLog.customSubject
        ?? `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name}`;

    let description = composedLogDetails;

    description = stripHtml(description)

    // if (note) description += `<li><b>Subject</b><br>${subject}</li>`;
    if (note) description += `Agent Notes ${note}\n`;
    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true))
        description += `AI Note ${aiNote}\n`;
    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true))
        description += `Transcript ${transcript}\n`;

    const contactId = contactInfo.id;

    const logTime = (callLog?.startTime && callLog?.duration) ? `start_date: ${moment(callLog.startTime).utc().toISOString()} \nend_date: ${moment(callLog.startTime).utc().add(callLog.duration, 'seconds').toISOString()}` : ''

    const noteBody = {
        text: `${subject}\n\n` + `${description}\n\n` + logTime
    }
    // const noteBody = {
    //     text: JSON.stringify({
    //         subject,
    //         description,
    //         start_date: moment(callLog.startTime).utc().toISOString(),
    //         end_date: moment(callLog.startTime).utc().add(callLog.duration, 'seconds').toISOString()
    //     })
    // }

    let addNoteRes;
    let logType = 'note';

    // ============================================
    // CASE 1 → NO JOB FOUND → Create a CRM Note Only
    // ============================================
    if (!jobs || jobs.length === 0) {

        addNoteRes = await axios.post(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
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

        // Update summary with full description UI se bheja hua
        const updateBody = {
            summary: description
        };

        addNoteRes = await axios.patch(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${latestJob.id}`,
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
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    let description = composedLogDetails;

    description = stripHtml(description)

    // if (note) description += `\n\nSubject</b><br>${subject}`;
    if (note) description += `Agent Notes ${note}\n`;
    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true))
        description += `AI Note ${aiNote}\n`;
    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true))
        description += `Transcript ${transcript}\n`;

    const contactId = existingCallLog.contactId;

    let [realId, logType] = existingCallLog.thirdPartyLogId.split('_');
    logType = logType || 'note'; // fallback

    let newLogId;

    // --------------------------- NOTE UPDATE --------------------------
    if (logType === 'note') {

        const postBody = JSON.stringify({
            text: JSON.stringify({
                subject,
                description,
                start_date: moment(startTime).utc().toISOString(),
                end_date: moment(startTime).utc().add(duration, 'seconds').toISOString()
            })
        });

        const addNoteRes = await axios.post(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
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

        const updateBody = { summary: description };

        await axios.patch(
            `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${realId}`,
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

    return {
        logId: newLogId,
        updatedNote: description,
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
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');
    let subject = '';
    let description = '';
    switch (messageType) {
        case 'SMS':
            subject = `SMS conversation with ${contactInfo.name}`;
            description = `SMS from ${message.direction === 'Inbound' ? contactInfo.name : 'user'}: ${message.subject}`;
            break;
        case 'Voicemail':
            subject = `Voicemail from ${contactInfo.name}`;
            description = `Voicemail recording link: ${recordingLink}\n`;
            break;
        case 'Fax':
            subject = `Fax from ${contactInfo.name}`;
            description = `Fax document link: ${faxDocLink}`;
            break;
    }

    const contactId = contactInfo.id;
    let postBody = JSON.stringify({
        "text": JSON.stringify({
            start_date: moment(message.creationTime).utc().toISOString(),
            end_date: moment(message.creationTime).utc().toISOString(),
            subject,
            description,
        })
    });

    const addLogRes = await axios.post(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
        postBody,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': stAppKey,
                'Content-Type': 'application/json'
            }
        });

    return {
        logId: addLogRes.data.id,
        returnMessage: {
            message: 'Message logged as a note',
            messageType: 'success',
            ttl: 1000
        }
    };
}

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, authHeader }) {
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    let subject = '';
    let description = '';
    switch (messageType) {
        case 'SMS':
            subject = `SMS conversation with ${contactInfo.name}`;
            description = `SMS from ${message.direction === 'Inbound' ? contactInfo.name : 'user'}: ${message.subject}`;
            break;
        case 'Voicemail':
            subject = `Voicemail from ${contactInfo.name}`;
            description = `Voicemail recording link: ${recordingLink}`;
            break;
        case 'Fax':
            subject = `Fax from ${contactInfo.name}`;
            description = `Fax document link: ${faxDocLink}`;
            break;
    }

    const contactId = contactInfo.id;
    let postBody = JSON.stringify({
        "text": JSON.stringify({
            subject,
            description,
            start_date: moment(message.creationTime).utc().toISOString(),
            end_date: moment(message.creationTime).utc().toISOString(),
        })
    });

    const addLogRes = await axios.post(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
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
    const [realId, logType = 'note'] = callLogId.split('_');

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    let subject = '';
    let note = '';
    let full_data = {};

    try {
        if (logType === 'job') {
            const jobRes = await axios.get(
                `https://api-integration.servicetitan.io/jpm/v2/tenant/${tenantId}/jobs/${realId}`,
                {
                    headers: { 'Authorization': `Bearer ${auth}`, 'ST-App-Key': stAppKey },
                }
            );

            const jobData = jobRes.data;
            if (jobData) {
                const summary = jobData.summary || '';

                const subjectMarker = '<b>Subject</b><br>';
                const subjectIndex = summary.indexOf(subjectMarker);
                const agentNotesMarker = '<b>Agent Notes</b><br>';
                const notesIndex = summary.indexOf(agentNotesMarker);
                if (subjectIndex !== -1) {
                    const subjectSection = summary.substring(subjectIndex + subjectMarker.length);
                    const subjectSectionIndex = subjectSection.indexOf('\n\n<b>');
                    subject = (subjectSectionIndex !== -1 ? subjectSection.substring(0, subjectSectionIndex) : subjectSection).trim();
                }
                if (notesIndex !== -1) {
                    const notesSection = summary.substring(notesIndex + agentNotesMarker.length);
                    const nextSectionIndex = notesSection.indexOf('\n\n<b>');
                    note = (nextSectionIndex !== -1 ? notesSection.substring(0, nextSectionIndex) : notesSection).trim();
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
            const getLogRes = await axios.get(
                `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
                {
                    headers: { 'Authorization': `Bearer ${auth}`, 'ST-App-Key': stAppKey },
                }
            );

            const logData = getLogRes.data;
            if (Array.isArray(logData.data)) {
                const targetLog = logData.data.find(log => log.id == realId);
                if (targetLog) {
                    try {
                        const parsedText = JSON.parse(targetLog.text);
                        subject = parsedText.subject || '';
                        const description = parsedText.description || '';

                        const agentNotesMarker = '<b>Agent Notes</b><br>';
                        const notesIndex = description.indexOf(agentNotesMarker);

                        if (notesIndex !== -1) {
                            const notesSection = description.substring(notesIndex + agentNotesMarker.length);
                            const nextSectionIndex = notesSection.indexOf('\n\n<b>');
                            note = (nextSectionIndex !== -1 ? notesSection.substring(0, nextSectionIndex) : notesSection).trim();
                        } else {
                            note = description;
                        }

                        full_data = parsedText;
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
    const { client_id, client_secret, expiresAt } = platformAdditionalInfo;

    if (Date.now() < expiresAt) {
        return user.dataValues.accessToken;
    }

    const tokenUrl = 'https://auth-integration.servicetitan.io/connect/token';
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