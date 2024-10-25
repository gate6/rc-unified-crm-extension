const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { saveUserInfo } = require('../servicenow-core/auth');
const { UserModel } = require('../../models/userModel');
const Op = require('sequelize').Op;
const { initModels } = require('../servicenow-models/init-models');
const Sequelize = require('sequelize');
const { sequelize } = require('../servicenow-models/sequelize');
const { raw } = require('mysql2');
const models = initModels(sequelize);

// -----------------------------------------------------------------------------------------------
// ---TODO: Delete below mock entities and other relevant code, they are just for test purposes---
// -----------------------------------------------------------------------------------------------
let mockContact = null;
let mockCallLog = null;
let mockMessageLog = null;

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

    const instanceId = existingUser.hostname.substring(0, existingUser.hostname.indexOf('.service-now.com'));
    existingUser.instanceId = instanceId;
    return existingUser;
}

async function getOauthInfo(requestData) {
    // if(!requestData.rcAccountId) {
    //     return {
    //         failMessage: 'RingCentral Account ID Missing'
    //     }; 
    // }

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

    // console.log("isRcIdPresent", isRcIdPresent)

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


// // CASE: If using OAuth and Auth server requires CLIENT_ID in token exchange request
// function getOverridingOAuthOption({ code }) {
//     console.log("code ", code)
//     return {
//         query: {
//             grant_type: 'authorization_code',
//             code,
//             client_id: process.env.SERVICE_NOW_CLIENT_ID,
//             client_secret: process.env.SERVICE_NOW_CLIENT_SECRET,
//             redirect_uri: process.env.SERVICE_NOW_CRM_REDIRECT_URI,
//         },
//         headers: {
//             Authorization: ''
//         }
//     }
// }
// exports.getOverridingOAuthOption = getOverridingOAuthOption;


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

        const userInfoResponse = await axios.get(`${getCompanyDetails.instanceUrl}/api/${getCompanyDetails.userDetailsPath}`, {
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
                if ((checkActiveUsers.customers.length < checkActiveUsers.maxAllowedUsers) && checkActiveUsers.status == 1) {

                    if (checkActiveUsers.customers.some(customer => customer.sysId === id)) {
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
    // const accessTokenRevokeRes = await axios.post(
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

async function findContact({ user, authHeader, phoneNumber, overridingFormat }) {
    // ----------------------------------------
    // ---TODO.3: Implement contact matching---
    // ----------------------------------------

    const numberToQueryArray = [];

    if (overridingFormat === '') {
        numberToQueryArray.push(phoneNumber.trim());
    }
    else {
        const formats = overridingFormat.split(',');
        for (var format of formats) {
            const phoneNumberObj = parsePhoneNumber(phoneNumber.replace(' ', '+'));
            if (phoneNumberObj.valid) {
                const phoneNumberWithoutCountryCode = phoneNumberObj.number.significant;
                let formattedNumber = format;
                for (const numberBit of phoneNumberWithoutCountryCode) {
                    formattedNumber = formattedNumber.replace('*', numberBit);
                }
                numberToQueryArray.push(formattedNumber);
            }
        }
    }

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;

    const count = await models.companies.count({
        where: {
            hostname: userInfo.hostname,
            status: 1
        }
    });

    if (count == 0) {
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

    const stateSelection = await axios.get(
        `https://${instanceId}.service-now.com/api/now/table/sys_choice?sysparm_query=name=interaction^element=state&sysparm_fields=sys_id,label,value`,
        {
            headers: { 'Authorization':  authHeader }
        });
    
    const typeSelection = await axios.get(
        `https://${instanceId}.service-now.com/api/now/table/sys_choice?sysparm_query=name=interaction^element=type&sysparm_fields=sys_id,label,value`,
        {
            headers: { 'Authorization':  authHeader }
        });

    const states = stateSelection.data.result.length > 0 ? stateSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : null;

    const interactionType = typeSelection.data.result.length > 0 ? typeSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : null;
    

    // You can use parsePhoneNumber functions to further parse the phone number
    const matchedContactInfo = [];


    for (var numberToQuery of numberToQueryArray) {
        const personInfo = await axios.get(
            `https://${instanceId}.service-now.com/api/now/contact?sysparm_query=phoneLIKE${numberToQuery}`,
            {
                headers: { 'Authorization':  authHeader }
            });

        if (personInfo.data.result.length > 0) {
            for (var result of personInfo.data.result) {
                matchedContactInfo.push({
                    id: result.sys_id,
                    name: result.name,
                    phone: numberToQuery,
                    additionalInfo: {state: states, type: interactionType}
                })
            }
        }
    }

    console.log("FindCOntact")

    matchedContactInfo.push({
        id: 'createNewContact',
        name: 'Create new contact...',
        additionalInfo: null,
        isNewContact: true
    });

    //-----------------------------------------------------
    //---CHECK.3: In console, if contact info is printed---
    //-----------------------------------------------------
    return {
        matchedContactInfo,
        returnMessage: {
            messageType: 'success',
            message: 'Successfully found contact.',
            ttl: 3000
        }
    };  //[{id, name, phone, additionalInfo}]
}

async function createCallLog({ user, contactInfo, authHeader, callLog, note, additionalSubmission, timezoneOffset }) {
    // ------------------------------------
    // ---TODO.4: Implement call logging---
    // ------------------------------------

    const userInfo = await getHostname(user.dataValues.hostname);

    const { userDetailsPath }  = await models.companies.findOne({
        where: {
            hostname: userInfo.hostname,
            status: 1
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
    
    const caller_id = await axios.get(`https://${instanceId}.service-now.com/api/${userDetailsPath}`, {
        headers: {
            'Authorization': authHeader
        }
    });

    const postBody = {
        short_description: callLog.customSubject ?? `[Call] ${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name} [${contactInfo.phoneNumber}]`,
        work_notes: `\nContact Number: ${contactInfo.phoneNumber}\nCall Result: ${callLog.result}\nNote: ${note}${callLog.recording ? `\n[Call recording link] ${callLog.recording.link}` : ''}\n\n--- Created via RingCentral CRM Extension`
    }

    if (additionalSubmission && additionalSubmission.state){
        const stateSelection = await axios.get(
            `https://${instanceId}.service-now.com/api/now/table/sys_choice?sysparm_query=name=interaction^element=state^sys_id=${additionalSubmission.state}&sysparm_fields=sys_id,label,value`,
            {
                headers: { 'Authorization':  authHeader }
            });
    
        const returnedCateogry = stateSelection.data.result.length > 0 ? stateSelection.data.result[0].value : null;
        postBody.state = returnedCateogry;
        postBody.assigned_to = caller_id.data.result.id;

        if (additionalSubmission.type) {
            const typeSelection = await axios.get(
                `https://${instanceId}.service-now.com/api/now/table/sys_choice?sysparm_query=name=interaction^element=type^sys_id=${additionalSubmission.type}&sysparm_fields=sys_id,value,lable`,
                {
                    headers: { 'Authorization':  authHeader }
                });
            
            const returnedSubcateogry = typeSelection.data.result.length > 0 ? typeSelection.data.result[0].value : null;

            postBody.type = returnedSubcateogry;
        }
        
    }

    postBody.impact = (additionalSubmission && additionalSubmission.impact) ? additionalSubmission.impact : 3;
    postBody.urgency = (additionalSubmission && additionalSubmission.urgency) ? additionalSubmission.urgency : 3;

    const addLogRes = await axios.post(
        `https://${instanceId}.service-now.com/api/now/table/interaction`,
        postBody,
        {
            headers: { 'Authorization': authHeader }
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

async function getCallLog({ user, callLogId, authHeader }) {
    // -----------------------------------------
    // ---TODO.5: Implement call log fetching---
    // -----------------------------------------

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;

    const getLogRes = await axios.get(
        `https://${instanceId}.service-now.com/api/now/table/interaction/${callLogId}`,
        {
            headers: { 'Authorization': authHeader }
        });

    //-------------------------------------------------------------------------------------
    //---CHECK.5: In extension, for a logged call, click edit to see if info is fetched ---
    //-------------------------------------------------------------------------------------
    return {
        callLogInfo: {
            subject: getLogRes.data.result.short_description,
            note: getLogRes.data.result.work_notes,
        },
        returnMessage: {
            message: 'Call log fetched.',
            messageType: 'success',
            ttl: 3000
        }
    }
}

async function updateCallLog({ user, existingCallLog, authHeader, recordingLink, subject, note }) {
    // ---------------------------------------
    // ---TODO.6: Implement call log update---
    // ---------------------------------------

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;

    const existingLogId = existingCallLog.thirdPartyLogId;
    const getLogRes = await axios.get(
        `https://${instanceId}.service-now.com/api/now/table/interaction/${existingLogId}`,
        {
            headers: { 'Authorization': authHeader }
        });
    const originalNote = getLogRes.data.result.work_notes;
    let patchBody = {};

    patchBody = {
            short_description: subject,
            work_notes: recordingLink ? note + `\nCall Recording Link: \n${recordingLink}` : note
    }

    const patchLog = await axios.patch(
        `https://${instanceId}.service-now.com/api/now/table/interaction/${existingLogId}`,
        patchBody,
        {
            headers: { 'Authorization': authHeader }
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

    const userInfo = await getHostname(user.dataValues.hostname);

    const { userDetailsPath }  = await models.companies.findOne({
        where: {
            hostname: userInfo.hostname,
            status: 1
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
    
    const caller_id = await axios.get(`https://${instanceId}.service-now.com/api/${userDetailsPath}`, {
        headers: {
            'Authorization': authHeader
        }
    });
    
    const postBody = {
        data: {
            short_description: `[SMS] ${message.direction} SMS - ${message.from.name ?? ''}(${message.from.phoneNumber}) to ${message.to[0].name ?? ''}(${message.to[0].phoneNumber})`,
            work_notes: `${message.direction} SMS - ${message.direction == 'Inbound' ? `from ${message.from.name ?? ''}(${message.from.phoneNumber})` : `to ${message.to[0].name ?? ''}(${message.to[0].phoneNumber})`} \n${!!message.subject ? `[Message] ${message.subject}` : ''} ${!!recordingLink ? `\n[Recording link] ${recordingLink}` : ''}\n\n--- Created via RingCentral CRM Extension`,
            type: "Chat",
            caller_id: caller_id.data.result.id
        }
    }
    const addLogRes = await axios.post(
        `https://${instanceId}.service-now.com/api/now/table/interaction`,
        postBody,
        {
            headers: { 'Authorization': authHeader }
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
async function updateMessageLog({ user, contactInfo, existingMessageLog, message, authHeader, contactNumber }) {
    // ---------------------------------------
    // ---TODO.8: Implement message logging---
    // ---------------------------------------

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    
    const existingLogId = existingMessageLog.thirdPartyLogId;
    const getLogRes = await axios.get(
        `https://${instanceId}.service-now.com/api/now/table/interaction/${existingLogId}`,
        {
            headers: { 'Authorization': authHeader }
        });
    const originalNote = getLogRes.data.body;
    const updateNote = originalNote.replace();

    const patchBody = {
        data: {
            body: updateNote,
        }
    }
    const updateLogRes = await axios.patch(
        `https://${instanceId}.service-now.com/api/now/table/interaction/${existingLogId}`,
        patchBody,
        {
            headers: { 'Authorization': authHeader }
        });

    //---------------------------------------------------------------------------------------------------------------------------------------------
    //---CHECK.8: For multiple messages or additional message during the day, open db.sqlite and CRM website to check if message logs are saved ---
    //---------------------------------------------------------------------------------------------------------------------------------------------
}

async function createContact({ user, authHeader, phoneNumber, newContactName, newContactType }) {
    // ----------------------------------------
    // ---TODO.9: Implement contact creation---
    // ----------------------------------------

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    
    const account = await axios.get(`https://${instanceId}.service-now.com/api/now/account`, {
        headers: {
            'Authorization': authHeader
        }
    });

    const postBody = {
        name: newContactName,
        phone: phoneNumber,
        type: newContactType,
        account: account.data.result[0].sys_id
    }

    const contactInfoRes = await axios.post(
        `https://${instanceId}.service-now.com/api/now/contact`,
        postBody,
        {
            headers: { 'Authorization': authHeader }
        }
    );

    //--------------------------------------------------------------------------------
    //---CHECK.9: In extension, try create a new contact against an unknown number ---
    //--------------------------------------------------------------------------------
    return {
        contactInfo: {
            id: contactInfoRes.id,
            name: contactInfoRes.name
        },
        returnMessage: {
            message: `New contact created.`,
            messageType: 'success',
            ttl: 3000
        }
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
