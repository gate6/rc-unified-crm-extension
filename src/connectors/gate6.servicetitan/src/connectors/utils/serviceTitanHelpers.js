const axios = require('axios');
const qs = require('qs');
const moment = require('moment');
const { UserModel } = require('@app-connect/core/models/userModel');
const { sequelize } = require('../../servicetitan-models/sequelize');
const { initModels } = require('../../servicetitan-models/init-models');

const models = initModels(sequelize);

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

async function getLicenseStatus({ userId }) {
    try {
        const user = await UserModel.findByPk(userId);
        if (!user) {
            return {
                isLicenseValid: false,
                licenseStatus: 'User Not Found',
                licenseStatusDescription: ''
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
                licenseStatus: 'Inactive',
                licenseStatusDescription: 'Purchase license to continue'
            };
        }

        return {
            isLicenseValid: true,
            licenseStatus: 'Active',
            licenseStatusDescription: 'Basic'
        };
    } catch (error) {
        console.error('getLicenseStatus error:', error);
        return {
            isLicenseValid: false,
            licenseStatus: 'Error',
            licenseStatusDescription: 'Error validating license'
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

function stripHtml(html = '') {
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?[^>]+(>|$)/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim();
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

        return resp.data?.data || [];
    } catch (err) {
        console.error('fetchJobs error:', err?.response?.data, err?.response, err);
        return [];
    }
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

module.exports = {
    generateServiceTitanToken,
    getLicenseStatus,
    validateLicenseOrFail,
    getRefreshedAuthToken,
    formatContact,
    stripHtml,
    fetchJobs,
    upsertCallRecording
};
