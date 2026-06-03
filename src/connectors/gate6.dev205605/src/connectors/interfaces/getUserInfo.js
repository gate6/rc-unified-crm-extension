const axios = require('axios');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const { saveUserInfo } = require('../../servicenow-core/auth');
const { generateAlphanumericString } = require('../utils/servicenowHelpers');
const models = initModels(sequelize);

async function getUserInfo({ authHeader, additionalInfo, hostname}) {
    try {
        const getCompanyDetails = await models.companies.findOne({
            where: {
                hostname: hostname
            },
            raw:true
        });

        const userInfoResponse = await axios.get(`${getCompanyDetails.instanceUrl}/api/${getCompanyDetails.userDetailsPath}`, {
            headers: {
                'Authorization': authHeader
            }
        });
        let id = userInfoResponse.data.result.id;
        const email = userInfoResponse.data.result.email;
        const name = userInfoResponse.data.result.user_name;
        const timezoneName = userInfoResponse.data.result.time_zone ?? '';
        const timezoneOffset = userInfoResponse.data.result.time_zone_offset ?? null;
    
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
        });

        if (checkActiveUsers) {
            if (checkActiveUsers.customers) {
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
}

module.exports = getUserInfo;