/* eslint-disable no-param-reassign */
const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const jwt = require('@app-connect/core/lib/jwt');
const { UserModel } = require('@app-connect/core/models/userModel');
const { CallLogModel } = require('@app-connect/core/models/CallLogModel');
const { AdminConfigModel } = require('@app-connect/core/models/adminConfigModel');
const qs = require('qs');
function getAuthType() {
    return 'apiKey';
}

function getBasicAuth({ apiKey }) {
    return Buffer.from(`${apiKey}`).toString('base64');
}

async function getUserInfo({ authHeader, additionalInfo }) {
    try {
        const tokenUrl = 'https://auth-integration.servicetitan.io/connect/token';
        const data = {
            grant_type: 'client_credentials',
            client_id: additionalInfo.client_id,
            client_secret: additionalInfo.client_secret
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
        const overridingApiKey = authResponse.data.access_token;
        const id = additionalInfo.client_id;
        additionalInfo.expiresAt = Date.now() + ((authResponse.data.expires_in - 60) * 1000);
        return {
            successful: true,
            platformUserInfo: {
                id,
                overridingApiKey,
                platformAdditionalInfo: additionalInfo
            },
            returnMessage: {
                messageType: 'success',
                message: 'Connected to Service Titan.',
                ttl: 1000
            }
        }
    }
    catch (e) {
        return {
            successful: false,
            returnMessage: {
                messageType: 'warning',
                message: 'Could not load user information Please check your credentials.',
                details: [
                    {
                        title: 'Details',
                        items: [
                            {
                                id: '1',
                                type: 'text',
                                text: `Service Titan was unable to fetch information for the currently logged in user. Please check your permissions in Service Titan and make sure you have permission to access and read user information.`
                            }
                        ]
                    }
                ],
                ttl: 3000
            }
        }
    }
}

async function unAuthorize({ user }) {
    // remove user credentials
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
    console.log('Searching for phone number:', phoneNumberWithoutCountryCode);
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
        console.log('Matched contacts by name:', matchedContactInfo);
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
    console.log('Creating contact with name:', firstName, lastName, 'and phone:', parsedPhone);
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


async function createCallLog({ user, contactInfo, callLog, note, additionalSubmission, aiNote, transcript, composedLogDetails, hashedAccountId }) {
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const subject = callLog.customSubject ?? `${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name}`;
    let description = composedLogDetails;

    if (note) {
        description += `\n\n<b>Agent Notes</b><br>${note}`;
    }

    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
        description += `\n\n<b>AI Note</b><br>${aiNote}`;
    }

    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        description += `\n\n<b>Transcript</b><br>${transcript}`;
    }
    const contactId = contactInfo.id;
    let postBody = JSON.stringify({
        "text": JSON.stringify({
                subject,
                description,
                start_date: moment(callLog.startTime).utc().toISOString(),
                end_date: moment(callLog.startTime).utc().add(callLog.duration, 'seconds').toISOString()
            })
    });
    console.log('Creating call log with body:', postBody);
    const addNoteRes = await axios.post(
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
        logId: addNoteRes.data.id,
        returnMessage: {
            message: 'Call log note created',
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

    if (note) {
        description += `\n\n<b>Agent Notes</b><br>${note}`;
    }

    if (aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) {
        description += `\n\n<b>AI Note</b><br>${aiNote}`;
    }

    if (transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) {
        description += `\n\n<b>Transcript</b><br>${transcript}`;
    }
    const contactId = existingCallLog.contactId;
    let postBody = JSON.stringify({
        "text": JSON.stringify({
                subject,
                description,
                start_date: moment(startTime).utc().toISOString(),
                end_date: moment(startTime).utc().add(duration, 'seconds').toISOString()
            })
    });
    console.log('Updating call log with body:', postBody);
    const addNoteRes = await axios.post(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
        postBody,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': stAppKey,
                'Content-Type': 'application/json'
            }
        });
    let logID_db = await CallLogModel.findOne({
        where: {
            thirdPartyLogId: existingCallLog.thirdPartyLogId,
            contactId: existingCallLog.contactId
        }})
    if (logID_db) {
        logID_db.sessionId = existingCallLog.sessionId;
        logID_db.platform = existingCallLog.platform;
        logID_db.userId = existingCallLog.userId;
        logID_db.contactId = existingCallLog.contactId;
        logID_db.thirdPartyLogId =  addNoteRes.data.id;
        await logID_db.save();
    }
    return {
        logId: addNoteRes.data.id,
        updatedNote: description,
        returnMessage: {
            message: 'Call log note created',
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
    return{
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
    console.log('Creating message log with body:', postBody);
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
    // The ServiceTitan API does not support updating a note.
    // The best practice is to create a new note for the new message.
    return createMessageLog({ user, contactInfo, authHeader, message });
}
async function getCallLog({ user, callLogId, contactId, authHeader }) {
    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;
    const getLogRes = await axios.get(
        `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers/${contactId}/notes`,
        {
            headers: {
                'Authorization': `Bearer ${auth}`,
                'ST-App-Key': stAppKey
            }
        });

    const logData = getLogRes.data;
    let note = '';
    let subject = '';
    let full_data = {};
    let start_date = '';
    let end_date = '';
    if (Array.isArray(logData.data)) {
        for (let log of logData.data) {
            if (log.id == callLogId) {
            try {
                // Unserialize the JSON string in log.text
                const parsedText = JSON.parse(log.text);

                // Assign extracted values
                subject = parsedText.subject || '';
                note = (
                    parsedText.description?.includes('<b>Agent notes</b>')
                        ? parsedText.description
                            .split('<b>Agent notes</b>')[1]
                            ?.split('<b>Call details</b>')[0]
                            ?.replaceAll('<br>', '')
                            ?.trim()
                        : parsedText.description || ''
                    ) || '';
                start_date = parsedText.start_date || '';
                end_date = parsedText.end_date || '';
                full_data = parsedText;
            } catch (err) {
                console.error('Error parsing note text:', err);
                note = log.text; // fallback to raw
            }
            break;
            }
        }
    }
    console.log('Fetched call log data:', note);
    return {
        callLogInfo: {
            subject,
            fullLogResponse: full_data,
            note,
        }
    }
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

    // Check if the token is expired or will expire in the next minute
    if (Date.now() < expiresAt) {
        return user.dataValues.accessToken;
    }

    // Token is expired, get a new one
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

    // Update user's token and expiry info in the database
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
