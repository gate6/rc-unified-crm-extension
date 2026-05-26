const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { saveUserInfo } = require('../servicenow-core/auth');
const { findStateValueByName, findStateValueById, findTypeValueByName, findTypeValueById, getAllAccounts, applyClosedDatesIfNeeded, formatDuration } = require('../servicenow-core/interaction');
const { UserModel } = require('@app-connect/core/models/userModel');
const Op = require('sequelize').Op;
const { initModels } = require('../servicenow-models/init-models');
const Sequelize = require('sequelize');
const { sequelize } = require('../servicenow-models/sequelize');
const { raw } = require('mysql2');
const models = initModels(sequelize);
const { secondsToHoursMinutesSeconds } = require('@app-connect/core/lib/util');
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const s3Helper = require('../servicenow-core/s3');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const analytics = require('../servicenow-core/analytics');
const serviceNowApiClient = axios.create();

const ADAPTER_NAME = 'servicenow';

function stringifyForLog(value, maxLength = 1200) {
    try {
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
    } catch (error) {
        return String(value);
    }
}

serviceNowApiClient.interceptors.response.use(
    (response) => response,
    (error) => {
        console.error('[ServiceNow][apiError]', {
            method: error?.config?.method || '',
            url: error?.config?.url || '',
            status: error?.response?.status || null,
            statusText: error?.response?.statusText || '',
            responseBody: stringifyForLog(error?.response?.data),
            errorMessage: error?.message || ''
        });
        return Promise.reject(error);
    }
);

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
                hostname: user.hostname,
                rcAccountId: user.rcAccountId
            }
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

//function to generate aplhanumeric string for admin login sysid
function generateAlphanumericString(length) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * chars.length);
        result += chars[randomIndex];
    }
    return result.toLowerCase();
}


function getAuthType() {
    return 'oauth'; // Return either 'oauth' OR 'apiKey'
}

function getBasicAuth({ apiKey }) {
    return Buffer.from(`${apiKey}:`).toString('base64');
}

// CASE: If using OAuth

async function getHostname(hostname) {
    
    const existingUser = await UserModel.findOne({
        where: {
           hostname: hostname
        },
        attributes:['id','hostname'],
        raw:true
    });

    let instanceId;
    if (existingUser.hostname.includes('.service-now.com')) {
        instanceId = existingUser.hostname.substring(0, existingUser.hostname.indexOf('.service-now.com'));
    } else if (existingUser.hostname.includes('.servicenowservices.com')) {
        instanceId = existingUser.hostname.substring(0, existingUser.hostname.indexOf('.servicenowservices.com'));
    }
    existingUser.instanceId = instanceId;
    return existingUser;
}

async function getOauthInfo(requestData) {
    // if(!requestData.rcAccountId) {
    //     return {
    //         failMessage: 'RingCentral Account ID Missing'
    //     }; 
    // }
    console.log("getOauthInfo requestData", requestData);

    const companyData = await models.companies.findOne({
        where: {
            hostname: requestData.hostname
        },
        raw: true
    });

    if (!companyData) {
        return {
            failMessage: 'Company data not found for the provided hostname.'
        };
    }
    
    const { clientId, clientSecret, crmRedirectUrl, tokenUrl } = companyData;
    
    if (!clientId || !clientSecret || !crmRedirectUrl || !tokenUrl) {
        return {
            failMessage: 'RingCentral Account is not fully configured with Gate6.'
        };
    }
    
    return {
        clientId,
        clientSecret,
        accessTokenUri: tokenUrl,
        redirectUri: crmRedirectUrl
    };
    

    // console.log("requestData.rcAccountId", requestData.rcAccountId)

    // const isRcIdPresent = await models.companies.findOne({
    //     where: {
    //         rcAccountId : requestData.rcAccountId
    //     },
    //     attributes:['id','rcAccountId'],
    //     raw: true
    // })

    // if(!isRcIdPresent){
    //     return {
    //         failMessage: 'RingCentral Account ID is not Associated with Gate6'
    //     }; 
    // } else {
    //     const { clientId, clientSecret, crmRedirectUrl, tokenUrl }  = await models.companies.findOne({
    //         where: {
    //             hostname: requestData.hostname
    //         },
    //         raw: true
    //     })
    
    //     return {
    //         clientId: clientId,
    //         clientSecret:clientSecret,
    //         accessTokenUri: tokenUrl,
    //         redirectUri: crmRedirectUrl
    //     }
    // }

}

// For params, if OAuth, then accessToken, refreshToken, tokenExpiry; If apiKey, then apiKey
async function getUserInfo({ authHeader, additionalInfo, hostname}) {
   
    // ------------------------------------------------------
    // ---TODO.1: Implement API call to retrieve user info---
    // ------------------------------------------------------
    try {

        const getCompanyDetails = await models.companies.findOne({
            where: {
                hostname: hostname
            },
            raw:true
        })

        const userInfoResponse = await serviceNowApiClient.get(`${getCompanyDetails.instanceUrl}/api/${getCompanyDetails.userDetailsPath}`, {
            headers: {
                'Authorization': authHeader
            }
        });

        let id = userInfoResponse.data.result.id;
        const email = userInfoResponse.data.result.email;
        const name = userInfoResponse.data.result.user_name;
        const timezoneName = userInfoResponse.data.result.time_zone ?? ''; // Optional. Whether or not you want to log with regards to the user's timezone
        const timezoneOffset = userInfoResponse.data.result.time_zone_offset ?? null; // Optional. Whether or not you want to log with regards to the user's timezone. It will need to be converted to a format that CRM platform uses,
    
        //Generate a random alphanumeric id for case when admin is login in using the extension
        if(id == '6816f79cc0a8016401c5a33be04be441')
        {
            let newId = generateAlphanumericString(id.length);
            id = newId;
        }
        let userData = {
            id: id,
            email: email,
            timezoneName: timezoneName,
            timezoneOffset: timezoneOffset,
            name: name,
            first_name: userInfoResponse.data.result.first_name,
            last_name: userInfoResponse.data.result.last_name
        }
        //Get information of company along with its customers based on hostname
        const checkActiveUsers = await models.companies.findOne({
            where: {
                hostname: hostname
            },
            include: [{
                model: models.customer,
                as: 'customers',
                required: false
            }],
            logging: false,
        })
        //check if the current company exists in the MYSQL database if not exists thorw error

        if (checkActiveUsers) {
            //Fetch the all the customers for the company and check the current loggedInUser is new or existing
            if (checkActiveUsers.customers) {
                //check the number of users allowed for the company and compare them with the current active users 
                //if the max numbers of users is greater than the active customers we allow to insert new customer

                if (userData.name == 'admin' && checkActiveUsers.customers.some(customer => customer.email === email)) {
                    await analytics.trackUserConnected({
                        adapterName: ADAPTER_NAME,
                        companyIdentifier: hostname
                    });
                    return {
                        successful: true,
                        platformUserInfo: {
                            id,
                            name,
                            timezoneName,
                            timezoneOffset,
                            platformAdditionalInfo: {}
                        },
                        returnMessage: {
                            messageType: 'success',
                            message: 'Successfully connected to ServiceNow.',
                            ttl: 3000
                        }
                    };
                }
                //allow login of new user
                if (checkActiveUsers.customers.length < checkActiveUsers.maxAllowedUsers) {

                    if (checkActiveUsers.customers.some(customer => customer.sysId === id)) {
                        await analytics.trackUserConnected({
                            adapterName: ADAPTER_NAME,
                            companyIdentifier: hostname
                        });
                        return {
                            successful: true,
                            platformUserInfo: {
                                id,
                                name,
                                timezoneName,
                                timezoneOffset,
                                platformAdditionalInfo: {}
                            },
                            returnMessage: {
                                messageType: 'success',
                                message: 'Successfully connected to ServiceNow.',
                                ttl: 3000
                            }
                        };
                    }
                    else {
                        const accessToken = authHeader.split(' ')[1];
                        //Save the auth token and new user information in the MYSQL customers table
                        await saveUserInfo(userData, accessToken, checkActiveUsers.dataValues.hostname, checkActiveUsers.dataValues.id);
                        await analytics.trackUserConnected({
                            adapterName: ADAPTER_NAME,
                            companyIdentifier: hostname
                        });
                        return {
                            successful: true,
                            platformUserInfo: {
                                id,
                                name,
                                timezoneName,
                                timezoneOffset,
                                platformAdditionalInfo: {}
                            },
                            returnMessage: {
                                messageType: 'success',
                                message: 'Successfully connected to ServiceNow.',
                                ttl: 3000
                            }
                        };                    
                
                    }    
                } else {
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
            }

        } else {
            return {
                successful: false,
                platformUserInfo: {
                    id,
                    name,
                    timezoneName,
                    timezoneOffset,
                    platformAdditionalInfo: {}
                },
                returnMessage: {
                    messageType: 'danger',
                    message: 'Could not find the company details.',
                    ttl: 3000
                }
            };
        }

    } catch (error) {
        console.log("Exception in getUserInfo ", error);
        return {
            successful: false,
            returnMessage: {
                messageType: 'warning',
                message: 'Failed to get user info.',
                ttl: 3000
            }
        }
    }

    //---------------------------------------------------------------------------------------------------
    //---CHECK.1: Open db.sqlite (might need to install certain viewer) to check if user info is saved---
    //---------------------------------------------------------------------------------------------------
}

async function unAuthorize({ user }) {
    // -----------------------------------------------------------------
    // ---TODO.2: Implement token revocation if CRM platform requires---
    // -----------------------------------------------------------------

    // const revokeUrl = 'https://api.crm.com/oauth/unauthorize';
    // const revokeBody = {
    //     token: user.accessToken
    // }
    // const accessTokenRevokeRes = await serviceNowApiClient.post(
    //     revokeUrl,
    //     revokeBody,
    //     {
    //         headers: { 'Authorization': `Basic ${getBasicAuth({ apiKey: user.accessToken })}` }
    //     });
    await user.destroy();
    return {
        returnMessage: {
            messageType: 'success',
            message: 'Successfully logged out from ServiceNow account.',
            ttl: 3000
        }
    }

    //--------------------------------------------------------------
    //---CHECK.2: Open db.sqlite to check if user info is removed---
    //--------------------------------------------------------------
}

function generateFormatsFromE164(e164Number) {
    const digits = e164Number.replace(/\D/g, '');

    if (digits.length === 11 && digits.startsWith('1')) {
        const d = digits.slice(1);
        return [
            e164Number,                                               // +18003534676
            digits,                                                   // 18003534676
            d,                                                        // 8003534676
            `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`,      // (800) 353-4676
            `${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`,        // 800-353-4676
            `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6)}`,        // 800.353.4676
            `+1 (${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`,   // +1 (800) 353-4676
            `+1-${d.slice(0,3)}-${d.slice(3,6)}-${d.slice(6)}`,     // +1-800-353-4676
            `(${d.slice(0,3)})${d.slice(3,6)}-${d.slice(6)}`,       // (800)353-4676
        ];
    }
    return [e164Number, digits];
}

function toDigits(value = '') {
    return String(value).replace(/\D/g, '');
}

function isSamePhone(candidate, target) {
    const a = toDigits(candidate);
    const b = toDigits(target);
    if (!a || !b) {
        return false;
    }
    if (a === b || a.endsWith(b) || b.endsWith(a)) {
        return true;
    }

    const digitPattern = b.split('').join('\\D*');
    const flexibleRegex = new RegExp(digitPattern);
    return flexibleRegex.test(String(candidate || ''));
}

function buildFallbackTokens(digits) {
    const clean = toDigits(digits);
    if (!clean) {
        return [];
    }
    if (clean.length <= 4) {
        return [clean];
    }

    const tokens = new Set();
    tokens.add(clean.slice(-4));
    tokens.add(clean.slice(0, Math.min(3, clean.length)));

    if (clean.length >= 6) {
        const midStart = Math.max(0, Math.floor(clean.length / 2) - 1);
        tokens.add(clean.slice(midStart, midStart + 3));
    }

    return Array.from(tokens).filter((t) => t.length >= 2);
}

async function findContact({ user, authHeader, phoneNumber, overridingFormat, isExtension }) {
    // ----------------------------------------
    // ---TODO.3: Implement contact matching---
    // ----------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    console.log("authHeader", authHeader)
    let numberToQueryArray = [];

    const isRealExtension = isExtension === true || isExtension === 'true';

    if (isRealExtension && phoneNumber.length <= 8) {
        numberToQueryArray = [phoneNumber];
    } else {
        numberToQueryArray = generateFormatsFromE164(phoneNumber);
    }

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;
    console.log("hostname", hostname)

    const companyData = await models.companies.findOne({
        where: {
            hostname: hostname
        }
    });

    let states = [];
    let interactionType = [];
    try {
        const stateSelection = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=state&sysparm_fields=sys_id,label,value`,
            { headers: { 'Authorization': authHeader } }
        );
        states = stateSelection.data.result.length > 0 ? stateSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : [];
    } catch (err) {
        console.log('sys_choice state lookup failed, continuing without state options:', err.response?.status);
    }
    try {
        const typeSelection = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=type&sysparm_fields=sys_id,label,value`,
            { headers: { 'Authorization': authHeader } }
        );
        interactionType = typeSelection.data.result.length > 0 ? typeSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : [];
    } catch (err) {
        console.log('sys_choice type lookup failed, continuing without type options:', err.response?.status);
    }
    

    // You can use parsePhoneNumber functions to further parse the phone number
    const matchedContactInfo = [];
    const matchedContactIds = new Set();
    const isExtensionBool = isExtension === true || isExtension === 'true';
    const contactTable = (companyData?.contactTable?.trim().toLowerCase() == 'user' || isExtensionBool) ? 'table/sys_user' : 'contact';
    
    const rcDigits = toDigits(phoneNumber);
    const addMatchedContact = (result) => {
        const contactId = (result?.sys_id || '').toString().trim();
        if (!contactId || matchedContactIds.has(contactId)) {
            return;
        }
        matchedContactIds.add(contactId);
        const additionalInfo = {};
        if (states.length > 0) {
            additionalInfo.state = states;
        }
        if (interactionType.length > 0) {
            additionalInfo.type = interactionType;
        }
        matchedContactInfo.push({
            id: contactId,
            name: (contactTable == 'table/sys_user') ? result.user_name : result.name,
            phone: phoneNumber,
            additionalInfo
        });
    };

    for (var numberToQuery of numberToQueryArray) {
        const personInfo = await serviceNowApiClient.get(
            `https://${hostname}/api/now/${contactTable}?sysparm_query=phoneLIKE${numberToQuery}^ORmobile_phoneLIKE${numberToQuery}`,
            {
                headers: { 'Authorization':  authHeader }
            });

        if (personInfo.data.result.length > 0) {
            for (var result of personInfo.data.result) {
                addMatchedContact(result);
            }
        }
    }

    if (!isExtensionBool && matchedContactInfo.length === 0 && rcDigits.length >= 2) {
        const fallbackTokens = buildFallbackTokens(rcDigits);
        const fallbackQuery = fallbackTokens
            .map((token) => `phoneLIKE${token}^ORmobile_phoneLIKE${token}`)
            .join('^OR');

        if (fallbackQuery) {
            const fallbackRes = await serviceNowApiClient.get(
                `https://${hostname}/api/now/${contactTable}?sysparm_query=${encodeURIComponent(fallbackQuery)}&sysparm_limit=200`,
                { headers: { 'Authorization': authHeader } }
            );

            for (const result of (fallbackRes.data?.result || [])) {
                if (isSamePhone(result?.phone, rcDigits) || isSamePhone(result?.mobile_phone, rcDigits)) {
                    addMatchedContact(result);
                }
            }
        }

        // Final fallback for heavily formatted numbers where LIKE cannot match
        // contiguous digits (e.g. +1 (6 2 3) 2 0 1-1(86) 0).
        if (matchedContactInfo.length === 0) {
            const broadRes = await serviceNowApiClient.get(
                `https://${hostname}/api/now/${contactTable}?sysparm_query=${encodeURIComponent('phoneISNOTEMPTY^ORmobile_phoneISNOTEMPTY')}&sysparm_fields=sys_id,user_name,name,phone,mobile_phone&sysparm_limit=1000`,
                { headers: { 'Authorization': authHeader } }
            );

            for (const result of (broadRes.data?.result || [])) {
                if (isSamePhone(result?.phone, rcDigits) || isSamePhone(result?.mobile_phone, rcDigits)) {
                    addMatchedContact(result);
                }
            }
        }
    }

    const accounts = await getAllAccounts(hostname, authHeader);
    const accountOptions = accounts
        .map((account) => ({
            const: account.sys_id,
            title: account.name
        }))
        .sort((a, b) => (a.title || '').localeCompare((b.title || ''), undefined, { sensitivity: 'base' }));

    matchedContactInfo.push({
        id: 'createNewContact',
        name: 'Create new contact...',
        additionalInfo: {
            account: accountOptions
        },
        isNewContact: true
    });

    //-----------------------------------------------------
    //---CHECK.3: In console, if contact info is printed---
    //-----------------------------------------------------
    return {
        successful: true,
        matchedContactInfo
    };
}

async function createCallLog({ user, contactInfo, authHeader, callLog, note, additionalSubmission, aiNote, transcript }) {
    // ------------------------------------
    // ---TODO.4: Implement call logging---
    // ------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    let subject =
        (user.userSettings?.addCallLogSubject?.value ?? true)
            ? (callLog?.customSubject?.trim() || "")
            : "";

    let body = '';
    if (user.userSettings?.addCallLogNote?.value ?? true) { body = upsertCallAgentNote({ body, note }); }
    if (user.userSettings?.addCallLogContactNumber?.value ?? true) { body = upsertContactPhoneNumber({ body, phoneNumber: contactInfo.phoneNumber, direction: callLog.direction }); }
    if (user.userSettings?.addCallLogResult?.value ?? true) { body = upsertCallResult({ body, result: callLog.result }); }
    if (user.userSettings?.addCallLogDuration?.value ?? true) { body = upsertCallDuration({ body, duration: callLog.duration }); }
    if (!!callLog.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) { body = upsertCallRecording({ body, recordingLink: callLog.recording.link }); }
    if (!!aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) { body = upsertAiNote({ body, aiNote }); }
    if (!!transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) { body = upsertTranscript({ body, transcript }); }

    const userInfo = await getHostname(user.dataValues.hostname);

    const { userDetailsPath }  = await models.companies.findOne({
        where: {
            hostname: userInfo.hostname
        },
        raw: true
    })

    if (!userDetailsPath) {
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

    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;
    const companyData = await models.companies.findOne({
        where: {
            hostname: hostname
        }
    });

    const contactTable = (companyData?.contactTable == 'user') ? 'table/sys_user' : 'contact';
    
    const caller_id = await serviceNowApiClient.get(`https://${hostname}/api/${userDetailsPath}`, {
        headers: {
            'Authorization': authHeader
        }
    });

    // const workNotes = `\nContact Number: ${contactInfo.phoneNumber}\nCall Result: ${callLog.result}\nNote: ${note}${callLog.recording ? `\n[Call recording link] ${callLog.recording.link}` : ''}\n\n--- Created via RingCentral CRM Extension`;

    const callKeyParts = [
        callLog?.telephonySessionId || callLog?.id,
        callLog?.startTime,
        contactInfo?.id
    ]
        .map((value) => (value ?? '').toString().trim())
        .filter(Boolean);

    const uniqueCallId = callKeyParts.length > 0
        ? `rc_${crypto.createHash('sha1').update(callKeyParts.join('|')).digest('hex').slice(0, 32)}`
        : '';
    if (uniqueCallId) {
        const queryParts = [`correlation_id=${uniqueCallId}`];
        if (contactInfo?.id) {
            queryParts.push(`opened_for=${contactInfo.id}`);
        }
        const existing = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/interaction?sysparm_query=${encodeURIComponent(queryParts.join('^'))}&sysparm_fields=sys_id,short_description,opened_for,sys_created_on&sysparm_limit=1`,
            { headers: { 'Authorization': authHeader } }
        );
        if (existing.data?.result?.length > 0) {
            const existingLog = existing.data.result[0];
            const existingOpenedFor = (existingLog?.opened_for?.value || existingLog?.opened_for || '').toString().trim();
            const isSameContact = !!contactInfo?.id && existingOpenedFor === contactInfo.id.toString().trim();
            const isSameSubject = (existingLog?.short_description || '').toString().trim() === (subject || '').toString().trim();
            const existingCreatedAt = Date.parse(existingLog?.sys_created_on || '');
            const isRecent = Number.isFinite(existingCreatedAt) && (Date.now() - existingCreatedAt) <= 10 * 60 * 1000;

            if (isSameContact && isSameSubject && isRecent) {
                return {
                    logId: existingLog.sys_id,
                    returnMessage: { message: 'Call log already exists.', messageType: 'warning', ttl: 3000 }
                };
            }
        }
    }

    const postBody = {
        short_description: subject,
        work_notes: body,
        ...(uniqueCallId && { correlation_id: uniqueCallId })
    }
    if (callLog?.startTime) {
        postBody.opened_at = callLog.startTime;
    }

    postBody.u_call_duration = formatDuration(callLog.duration);

    postBody.assigned_to = caller_id.data.result.id;

    console.log("additionalSubmission", additionalSubmission)

    if (additionalSubmission?.state) {
        const returnedState = await findStateValueById(hostname, authHeader, additionalSubmission.state);
        postBody.state = returnedState ?? await findStateValueByName(hostname, authHeader, additionalSubmission.state);
        applyClosedDatesIfNeeded(postBody, postBody.state, callLog);
    }

    postBody.opened_for = contactInfo.id;
    
    if (additionalSubmission?.type) {
        const returnedType = await findTypeValueById(hostname, authHeader, additionalSubmission.type);
        postBody.type = returnedType ?? await findTypeValueByName(hostname, authHeader, additionalSubmission.type);
    }

    const addLogRes = await serviceNowApiClient.post(
        `https://${hostname}/api/now/table/interaction`,
        postBody,
        {
            headers: { 'Authorization': authHeader }
        }
    );
    
    if (callLog?.recording?.downloadUrl) {
        const timestamp = moment().format("DD-MM-YYYY_HH_MM_SS");
        const fileName = `downloaded_audio_${timestamp}`;
        const s3Key = `${fileName}.mp3`;
        const s3Url = await downloadAudioFile(callLog?.recording?.downloadUrl, process.env.S3_BUCKET, s3Key);
        await uploadToServiceNow(s3Url, hostname, authHeader, addLogRes?.data?.result?.sys_id, fileName);
    }

    await analytics.trackCallLogCreated({
        adapterName: ADAPTER_NAME,
        companyIdentifier: user.hostname || user.dataValues?.hostname,
        callDirection: callLog.direction,
        callDurationSeconds: callLog.duration
    });

    //----------------------------------------------------------------------------
    //---CHECK.4: Open db.sqlite and CRM website to check if call log is saved ---
    //----------------------------------------------------------------------------
    return {
        logId: addLogRes.data.result.sys_id,
        returnMessage: {
            message: 'Call log added.',
            messageType: 'success',
            ttl: 3000
        }
    };
}

async function upsertCallDisposition({ user, existingCallLog, authHeader, callDisposition }) {
    const existingLogId = existingCallLog.thirdPartyLogId;
    if (callDisposition?.dispositionItem) {
        // If has disposition item, check existence. If existing, update it, otherwise create it.
        console.log("callDisposition", callDisposition?.dispositionItem);
    }
    return {
        logId: existingLogId
    }
}

function upsertCallAgentNote({ body, note }) {
    if (!!!note) {
        return body;
    }
    const noteRegex = RegExp('- Agent note: ([\\s\\S]+?)\n');
    if (noteRegex.test(body)) {
        body = body.replace(noteRegex, `- Agent note: ${note}\n`);
    }
    else {
        body += `- Agent note: ${note}\n`;
    }
    return body;
}

function upsertContactPhoneNumber({ body, phoneNumber, direction }) {
    const phoneNumberRegex = RegExp('- Contact Number: (.+?)\n');
    if (phoneNumberRegex.test(body)) {
        body = body.replace(phoneNumberRegex, `- Contact Number: ${phoneNumber}\n`);
    } else {
        body += `- Contact Number: ${phoneNumber}\n`;
    }
    return body;
}

function upsertCallResult({ body, result }) {
    const resultRegex = RegExp('- Result: (.+?)\n');
    if (resultRegex.test(body)) {
        body = body.replace(resultRegex, `- Result: ${result}\n`);
    } else {
        body += `- Result: ${result}\n`;
    }
    return body;
}

function upsertCallDuration({ body, duration }) {
    const durationRegex = RegExp('- Duration: (.+?)\n');
    if (durationRegex.test(body)) {
        body = body.replace(durationRegex, `- Duration: ${secondsToHoursMinutesSeconds(duration)}\n`);
    } else {
        body += `- Duration: ${secondsToHoursMinutesSeconds(duration)}\n`;
    }
    return body;
}

function upsertCallRecording({ body, recordingLink }) {
    const recordingLinkRegex = RegExp('- Call recording link: (.+?)\n');
    if (!!recordingLink && recordingLinkRegex.test(body)) {
        body = body.replace(recordingLinkRegex, `- Call recording link: ${recordingLink}\n`);
    } else if (!!recordingLink) {
        body += `- Call recording link: ${recordingLink}\n`;
    }
    return body;
}

function upsertAiNote({ body, aiNote }) {
    const aiNoteRegex = RegExp('- AI Note:([\\s\\S]*?)--- END');
    const clearedAiNote = aiNote.replace(/\n+$/, '');
    if (aiNoteRegex.test(body)) {
        body = body.replace(aiNoteRegex, `- AI Note:\n${clearedAiNote}\n--- END`);
    } else {
        body += `- AI Note:\n${clearedAiNote}\n--- END\n`;
    }
    return body;
}

function upsertTranscript({ body, transcript }) {
    const transcriptRegex = RegExp('- Transcript:([\\s\\S]*?)--- END');
    if (transcriptRegex.test(body)) {
        body = body.replace(transcriptRegex, `- Transcript:\n${transcript}\n--- END`);
    } else {
        body += `- Transcript:\n${transcript}\n--- END\n`;
    }
    return body;
}

async function getCallLog({ user, callLogId, authHeader }) {
    // -----------------------------------------
    // ---TODO.5: Implement call log fetching---
    // -----------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;

    const getLogRes = await serviceNowApiClient.get(
        `https://${hostname}/api/now/table/interaction/${callLogId}`,
        {
            headers: { 'Authorization': authHeader }
        });
    
    const journalRes = await serviceNowApiClient.get(
        `https://${hostname}/api/now/table/sys_journal_field?sysparm_query=element_id=${callLogId}^element=work_notes&sysparm_fields=value,sys_created_on`,
        {
            headers: { Authorization: authHeader }
        });
    
    const latestNote = journalRes.data.result
        .sort((a, b) => new Date(b.sys_created_on) - new Date(a.sys_created_on))[0]?.value || '';
    const agentNoteMatch = latestNote.match(/- Agent note:\s*(.*)/i);
    const agentNote = agentNoteMatch ? agentNoteMatch[1].trim() : '';

    //-------------------------------------------------------------------------------------
    //---CHECK.5: In extension, for a logged call, click edit to see if info is fetched ---
    //-------------------------------------------------------------------------------------
    return {
        callLogInfo: {
            subject: getLogRes.data.result.short_description,
            note: agentNote,
        },
        returnMessage: {
            message: 'Call log fetched.',
            messageType: 'success',
            ttl: 3000
        }
    }
}

async function updateCallLog({ user, existingCallLog, authHeader, recordingLink, recordingDownloadLink, subject, note, startTime, duration, result, aiNote, transcript }) {
    // ---------------------------------------
    // ---TODO.6: Implement call log update---
    // ---------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;

    const existingLogId = existingCallLog.thirdPartyLogId;
    const getLogRes = await serviceNowApiClient.get(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        {
            headers: { 'Authorization': authHeader }
        });
    const originalNote = getLogRes?.data?.result?.work_notes ?? '';
    const originalSubject = getLogRes?.data?.result?.short_description || '';
    let patchBody = {};

    let subjectToUse = originalSubject || "";

    if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
        subjectToUse = subject.trim();
    }
    
    let logBody = originalNote;
    if (!!note && (user.userSettings?.addCallLogNote?.value ?? true)) { logBody = upsertCallAgentNote({ body: logBody, note }); }
    if (!!duration && (user.userSettings?.addCallLogDuration?.value ?? true)) { logBody = upsertCallDuration({ body: logBody, duration }); }
    if (!!result && (user.userSettings?.addCallLogResult?.value ?? true)) { logBody = upsertCallResult({ body: logBody, result }); }
    if (!!recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) { logBody = upsertCallRecording({ body: logBody, recordingLink: decodeURIComponent(recordingLink) }); }
    if (!!aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) { logBody = upsertAiNote({ body: logBody, aiNote }); }
    if (!!transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) { logBody = upsertTranscript({ body: logBody, transcript }); }

    patchBody = {
        short_description: subjectToUse,
        work_notes: logBody
    }

    patchBody.u_call_duration = formatDuration(duration);

    const patchLog = await serviceNowApiClient.patch(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        patchBody,
        {
            headers: { 'Authorization': authHeader }
        }
    );

    if (recordingDownloadLink) {
        console.log("Downloading Recorded File...");
        const timestamp = moment().format("DD-MM-YYYY_HH_MM_SS");
        const fileName = `downloaded_audio_${timestamp}`;
        const s3Key = `${fileName}.mp3`;
        const s3Url = await downloadAudioFile(recordingDownloadLink, process.env.S3_BUCKET, s3Key);
        await uploadToServiceNow(s3Url, hostname, authHeader, existingLogId, fileName)
    }

    await analytics.trackCallLogUpdated({
        adapterName: ADAPTER_NAME,
        companyIdentifier: user.hostname || user.dataValues?.hostname
    });

    const patchLogRes = {
        data: {
            id: patchLog.data.result.sys_id
        }
    }

    //-----------------------------------------------------------------------------------------
    //---CHECK.6: In extension, for a logged call, click edit to see if info can be updated ---
    //-----------------------------------------------------------------------------------------
    return {
        updatedNote: note,
        returnMessage: {
            message: 'Call log updated.',
            messageType: 'success',
            ttl: 3000
        }
    };
}

async function createMessageLog({ user, contactInfo, authHeader, message, additionalSubmission, recordingLink, faxDocLink }) { // contactNumber is now ContactInfo.phoneNumber
    // ---------------------------------------
    // ---TODO.7: Implement message logging---
    // ---------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;

    const { userDetailsPath }  = await models.companies.findOne({
        where: {
            hostname: hostname
        },
        raw: true
    })

    if (!userDetailsPath) {
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

    const caller_id = await serviceNowApiClient.get(`https://${hostname}/api/${userDetailsPath}`, {
        headers: {
            'Authorization': authHeader
        }
    });

    // detect message type (SMS / Voicemail / Fax)
    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    const workNotes =
        `${message.direction} ${messageType} - ${message.direction === 'Inbound'
            ? `from ${message.from.name ?? ''} (${message.from.phoneNumber})`
            : `to ${message.to[0].name ?? ''} (${message.to[0].phoneNumber})`
        }\n${message.subject ? `[Message] ${message.subject}` : ''}`
        + (recordingLink ? `\n[Recording link] ${recordingLink}` : '')
        + (faxDocLink ? `\n[Fax document link] ${faxDocLink}` : '')
        + `\n\n--- Created via RingCentral CRM Extension`;

    const postBody = {
        short_description: `[${messageType}] ${message.direction} ${messageType} - ${contactInfo.name}`,
        work_notes: workNotes,
        assigned_to: caller_id.data.result.id,
        opened_for: contactInfo.id
    };

    if(message?.startTime){
        postBody.opened_at = message.startTime;
    }

    if (additionalSubmission?.state) {
        const returnedState = await findStateValueById(hostname, authHeader, additionalSubmission.state);
        postBody.state = returnedState ?? await findStateValueByName(hostname, authHeader, additionalSubmission.state);
        applyClosedDatesIfNeeded(postBody, postBody.state, null);
    }

    if (additionalSubmission?.type) {
        const returnedType = await findTypeValueById(hostname, authHeader, additionalSubmission.type);
        postBody.type = returnedType ?? await findTypeValueByName(hostname, authHeader, additionalSubmission.type);
    }

    const addLogRes = await serviceNowApiClient.post(
        `https://${hostname}/api/now/table/interaction`,
        postBody,
        {
            headers: { 'Authorization': authHeader }
        });

    if (recordingLink || faxDocLink) {

        const downloadUrl = recordingLink || faxDocLink

        const fileName =
            recordingLink
                ? `Voicemail-${Date.now()}.mp3`
                : `Fax-${Date.now()}.pdf`;
                
        const s3Key = fileName;

        const s3Url = await downloadAudioFile(
            downloadUrl, 
            process.env.S3_BUCKET, 
            s3Key
        );

        await uploadToServiceNow(
            s3Url, 
            hostname, 
            authHeader, 
            addLogRes?.data?.result?.sys_id, 
            fileName
        );
    }

    await analytics.trackMessageLogCreated({
        adapterName: ADAPTER_NAME,
        companyIdentifier: user.hostname || user.dataValues?.hostname,
        recordingLink,
        faxDocLink
    });

    //-------------------------------------------------------------------------------------------------------------
    //---CHECK.7: For single message logging, open db.sqlite and CRM website to check if message logs are saved ---
    //-------------------------------------------------------------------------------------------------------------
    return {
        logId: addLogRes.data.result.sys_id,
        returnMessage: {
            message: 'Message log added.',
            messageType: 'success',
            ttl: 3000
        }
    };
}

// Used to update existing message log so to group message in the same day together
async function updateMessageLog({ user, contactInfo, existingMessageLog, message, authHeader, contactNumber, additionalSubmission, recordingLink, faxDocLink }) {
    // ---------------------------------------
    // ---TODO.8: Implement message logging---
    // ---------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId; 
    const hostname = userInfo.hostname;
    
    const existingLogId = existingMessageLog.thirdPartyLogId;

    if (!existingLogId) {
        return {
            logId: null,
            returnMessage: {
                messageType: 'error',
                message: 'Missing message log id for update.',
                ttl: 3000
            }
        };
    }

    const getLogRes = await serviceNowApiClient.get(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        { headers: { 'Authorization': authHeader } }
    );

    let originalNote = getLogRes?.data?.result?.work_notes ?? '';

    // detect message type
    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    const updatedText =
        `${message.direction} ${messageType} - ${message.direction === 'Inbound'
            ? `from ${message.from.name ?? ''} (${message.from.phoneNumber})`
            : `to ${message.to[0].name ?? ''} (${message.to[0].phoneNumber})`
        }\n${message.subject ? `[Message] ${message.subject}` : ''}`
        + (recordingLink ? `\n[Recording link] ${recordingLink}` : '')
        + (faxDocLink ? `\n[Fax document link] ${faxDocLink}` : '');

    const updatedWorkNotes = `${originalNote}\n${updatedText}`;

    const patchBody = {
        short_description: `[${messageType}] ${message.direction} ${messageType} - ${existingMessageLog.contactName ?? ''}`,
        work_notes: updatedWorkNotes
    };

    if (additionalSubmission?.state) {
        const returnedState = await findStateValueById(hostname, authHeader, additionalSubmission.state);
        patchBody.state = returnedState ?? await findStateValueByName(hostname, authHeader, additionalSubmission.state);
        applyClosedDatesIfNeeded(patchBody, patchBody.state, null);
    }

    if (additionalSubmission?.type) {
        const returnedType = await findTypeValueById(hostname, authHeader, additionalSubmission.type);
        patchBody.type = returnedType ?? await findTypeValueByName(hostname, authHeader, additionalSubmission.type);
    }

    const updateLogRes = await serviceNowApiClient.patch(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        patchBody,
        {
            headers: { 'Authorization': authHeader }
        });

    if (recordingLink || faxDocLink) {

        const downloadUrl = recordingLink || faxDocLink

        const fileName =
            recordingLink
                ? `Voicemail-${Date.now()}.mp3`
                : `Fax-${Date.now()}.pdf`;
                
        const s3Key = fileName;

        const s3Url = await downloadAudioFile(
            downloadUrl, 
            process.env.S3_BUCKET, 
            s3Key
        );

        await uploadToServiceNow(
            s3Url, 
            hostname, 
            authHeader, 
            existingLogId, 
            fileName
        );
    }

    await analytics.trackMessageLogUpdated({
        adapterName: ADAPTER_NAME,
        companyIdentifier: user.hostname || user.dataValues?.hostname,
        recordingLink,
        faxDocLink
    });

    //---------------------------------------------------------------------------------------------------------------------------------------------
    //---CHECK.8: For multiple messages or additional message during the day, open db.sqlite and CRM website to check if message logs are saved ---
    //---------------------------------------------------------------------------------------------------------------------------------------------
    return {
        logId: existingLogId,
        returnMessage: {
            message: 'Message log updated.',
            messageType: 'success',
            ttl: 3000
        }
    };
}

async function createContact({ user, authHeader, phoneNumber, newContactName, newContactType, additionalSubmission }) {
    // ----------------------------------------
    // ---TODO.9: Implement contact creation---
    // ----------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;

    const companyData = await models.companies.findOne({
        where: {
            hostname: hostname
        }
    });

    const postBody = {
        phone: phoneNumber,
        type: newContactType,
        // account: account.data.result[0].sys_id
    }

    let contactInfoRes;
    const isExtensionNumber = phoneNumber.toString().length <= 8 && phoneNumber.toString().length >= 3;

    if (companyData?.contactTable == 'contact' && !isExtensionNumber) {
        const selectedAccountId = (additionalSubmission?.account || '').trim();

        if (selectedAccountId) {
            postBody.account = selectedAccountId;
        } else {
            const account = await serviceNowApiClient.get(
            `https://${hostname}/api/now/account?sysparm_limit=1`,
            { headers: { Authorization: authHeader } }
            );
            const fallbackAccountId = account?.data?.result?.[0]?.sys_id;
            if (fallbackAccountId) {
            postBody.account = fallbackAccountId;
            }
        }
    
        postBody.name = newContactName?.toLowerCase();
        contactInfoRes = await serviceNowApiClient.post(
            `https://${hostname}/api/now/contact`,
            postBody,
            {
                headers: { 'Authorization': authHeader }
            }
        );
    } else {
        postBody.user_name = newContactName?.toLowerCase();
        contactInfoRes = await serviceNowApiClient.post(
            `https://${hostname}/api/now/table/sys_user`,
            postBody,
            {
                headers: { 'Authorization': authHeader }
            }
        );
    }

    await analytics.trackContactCreated({
        adapterName: ADAPTER_NAME,
        companyIdentifier: user.hostname || user.dataValues?.hostname
    });

    //--------------------------------------------------------------------------------
    //---CHECK.9: In extension, try create a new contact against an unknown number ---
    //--------------------------------------------------------------------------------
    return {
        contactInfo: {
            id: contactInfoRes.id,
            name: contactInfoRes?.user_name ? contactInfoRes.user_name : contactInfoRes.name
        },
        returnMessage: {
            message: `New contact created.`,
            messageType: 'success',
            ttl: 3000
        }
    }
}

async function downloadAudioFile(url, s3Bucket, s3Key) {
    const urlObj = new URL(url);
    const accessToken = urlObj.searchParams.get("accessToken");
    const s3Values = {
        accessKeyId: process.env.MEDIA_UPLOAD_KEY_ID,
        secretAccessKey: process.env.MEDIA_UPLOAD_SECRET_KEY,
        region: process.env.AWS_REGION
    };
    const s3 = new AWS.S3(s3Values);

    console.log("Downloading Audio File...");

    try {

        const response = await serviceNowApiClient.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            responseType: "stream",
        });

        // console.log("Downloading audio file...", response.data);

        const uploadParams = {
            Bucket: s3Bucket,
            Key: s3Key,
            Body: response.data
        };
        // console.log("Uploading audio file to S3...", uploadParams);

        const uploadResult = await s3.upload(uploadParams).promise();
        // console.log("File uploaded to S3:", uploadResult);

        return uploadResult.Location;

    } catch (error) {
        console.log("Error downloading or uploading audio:", error);
    }
}

async function uploadToServiceNow(s3Url, hostname, accessToken, sys_id, fileName) {
    const serviceNowURL = `https://${hostname}/api/now/attachment/upload`;

    try {
        const s3Key = decodeURIComponent(new URL(s3Url).pathname.substring(1));
        console.log("Extracted S3 Key, Uploading to ServiceNow...");

        const fileStream = await s3Helper.getObject(s3Key, "audio");

        const formData = new FormData();
        formData.append("table_name", "interaction");
        formData.append("table_sys_id", sys_id);
        formData.append("file", fileStream, { filename: s3Key, contentType: "audio/mpeg" });

        const response = await serviceNowApiClient.post(serviceNowURL, formData, {
            headers: {
                "Authorization": accessToken,
                ...formData.getHeaders(),
            },
        });

        console.log("File uploaded to ServiceNow:", response.data);

        await s3Helper.deleteObject(s3Key, "audio");
        console.log("File deleted from S3:", s3Key);

    } catch (error) {
        console.log("Error uploading file:", error.response ? error.response.data : error.message);
    }
}

exports.getAuthType = getAuthType;
exports.getBasicAuth = getBasicAuth;
exports.getOauthInfo = getOauthInfo;
exports.getUserInfo = getUserInfo;
exports.createCallLog = createCallLog;
exports.updateCallLog = updateCallLog;
exports.getCallLog = getCallLog;
exports.createMessageLog = createMessageLog;
exports.updateMessageLog = updateMessageLog;
exports.findContact = findContact;
exports.createContact = createContact;
exports.unAuthorize = unAuthorize;
exports.upsertCallDisposition = upsertCallDisposition;
exports.getLicenseStatus = getLicenseStatus