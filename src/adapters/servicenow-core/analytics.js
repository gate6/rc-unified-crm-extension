const axios = require('axios');
const crypto = require('crypto');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');
const models = initModels(sequelize);

const GA_COLLECT_URL = 'https://www.google-analytics.com/mp/collect';
const DEFAULT_EVENT_PARAMS = {
    event_source: 'adapter',
    engagement_time_msec: 1
};
const GA_CLIENT_ID = crypto.randomBytes(18).toString('hex');
const GA_SESSION_ID = Date.now();

function getMessageType({ recordingLink, faxDocLink }) {
    if (recordingLink) return 'voicemail';
    if (faxDocLink) return 'fax';
    return 'sms';
}

async function getCompanyName(companyIdentifier) {
    if (!companyIdentifier) return undefined;

    try {
        const company = await models.companies.findOne({
            where: { hostname: companyIdentifier },
            raw: true
        });
        return company?.companyName;
    } catch (error) {
        console.warn('[AdapterAnalytics][companyNameLookupFailed]', {
            message: error?.message || ''
        });
        return undefined;
    }
}

function getPositiveNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function getParams(params) {
    return Object.fromEntries(
        Object.entries(params)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => [
                key,
                typeof value === 'string' ? value.slice(0, 100) : value
            ])
    );
}

async function track({ eventName, adapterName, companyIdentifier, params = {} }) {
    if (!process.env.GA_MEASUREMENT_ID || !process.env.GA_API_SECRET) {
        if (process.env.GA_ANALYTICS_LOG === 'true') {
            console.log('[AdapterAnalytics][skipped]', {
                eventName,
                adapterName,
                reason: 'missing GA_MEASUREMENT_ID or GA_API_SECRET'
            });
        }
        return;
    }

    try {
        const companyName = await getCompanyName(companyIdentifier);

        if (process.env.GA_ANALYTICS_LOG === 'true') {
            console.log('[AdapterAnalytics][sending]', {
                eventName,
                adapterName,
                companyName,
                params
            });
        }

        await axios.post(
            GA_COLLECT_URL,
            {
                client_id: GA_CLIENT_ID,
                events: [{
                    name: eventName,
                    params: getParams({
                        ...DEFAULT_EVENT_PARAMS,
                        session_id: GA_SESSION_ID,
                        ...(process.env.GA_DEBUG_MODE === 'true' && { debug_mode: true }),
                        adapter_name: adapterName,
                        company_name: companyName,
                        ...params
                    })
                }]
            },
            {
                params: {
                    measurement_id: process.env.GA_MEASUREMENT_ID,
                    api_secret: process.env.GA_API_SECRET
                },
                timeout: 3000
            }
        );

        if (process.env.GA_ANALYTICS_LOG === 'true') {
            console.log('[AdapterAnalytics][sent]', {
                eventName,
                adapterName
            });
        }
    } catch (error) {
        console.warn('[AdapterAnalytics][gaTrackFailed]', {
            eventName,
            adapterName,
            status: error?.response?.status || null,
            message: error?.message || ''
        });
    }
}

function trackUserConnected({ adapterName, companyIdentifier }) {
    return track({
        eventName: 'crm_user_connected',
        adapterName,
        companyIdentifier
    });
}

function trackContactCreated({ adapterName, companyIdentifier }) {
    return track({
        eventName: 'crm_contact_created',
        adapterName,
        companyIdentifier
    });
}

function trackCallLogCreated({ adapterName, companyIdentifier, callDirection, callDurationSeconds }) {
    return track({
        eventName: 'crm_call_log_created',
        adapterName,
        companyIdentifier,
        params: {
            call_direction: callDirection,
            call_duration_seconds: getPositiveNumber(callDurationSeconds)
        }
    });
}

function trackCallLogUpdated({ adapterName, companyIdentifier }) {
    return track({
        eventName: 'crm_call_log_updated',
        adapterName,
        companyIdentifier
    });
}

function trackMessageLogCreated({ adapterName, companyIdentifier, recordingLink, faxDocLink }) {
    return track({
        eventName: 'crm_message_log_created',
        adapterName,
        companyIdentifier,
        params: {
            message_type: getMessageType({ recordingLink, faxDocLink })
        }
    });
}

function trackMessageLogUpdated({ adapterName, companyIdentifier, recordingLink, faxDocLink }) {
    return track({
        eventName: 'crm_message_log_updated',
        adapterName,
        companyIdentifier,
        params: {
            message_type: getMessageType({ recordingLink, faxDocLink })
        }
    });
}

module.exports = {
    trackUserConnected,
    trackContactCreated,
    trackCallLogCreated,
    trackCallLogUpdated,
    trackMessageLogCreated,
    trackMessageLogUpdated
};