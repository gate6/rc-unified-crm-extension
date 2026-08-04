// @ts-nocheck
/* eslint-disable no-param-reassign */
const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const jwt = require('@app-connect/core/lib/jwt');
const { UserModel } = require('@app-connect/core/models/userModel');
const phoneWriteback = require('../shared/phoneWriteback');
const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { MessageLogModel } = require('@app-connect/core/models/messageLogModel');
const { AdminConfigModel } = require('@app-connect/core/models/adminConfigModel');
const qs = require('qs');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');
const { trackAnalytics } = require('../shared/analytics');
const models = sequelize ? initModels(sequelize) : null;
const licenseHelper = require('../shared/license');
const apiLog = require('../shared/apiLogger');
const jobs = require('../servicetitan-core/jobs');

const serviceTitanApiClient = axios.create();

// The QA/testing tenant runs against ServiceTitan's integration environment. Credentials are not
// interchangeable between integration and production, so the tenant decides which host to call —
// everyone else uses the env-configured hosts (production values on prod).
const INTEGRATION_TENANT_ID = '985994799';
const INTEGRATION_CRM_URI = 'https://api-integration.servicetitan.io/crm/v2/tenant';
const INTEGRATION_ACCESS_TOKEN_URI = 'https://auth-integration.servicetitan.io/connect/token';

// The manifest pins a fixed hostname (https://go.servicetitan.com/), so every user — QA included —
// arrives with the production hostname. The QA company row is provisioned against the integration
// hostname, so the integration tenant gets this value stored on both the user and customer rows;
// otherwise the licence lookup (shared/license.ts) searches with the prod hostname and misses.
const INTEGRATION_HOSTNAME = 'integration.servicetitan.com';

function resolveHostname({ tenantId, hostname }) {
    return isIntegrationTenant(tenantId) ? INTEGRATION_HOSTNAME : hostname;
}

// Normalize a hostname to the bare host the companies table stores:
// strips scheme (http/https), any path/query, port, and trailing slash; lowercased.
// Same helper as servicenow/monday — the fixed manifest hostname arrives as a full URL
// ("https://go.servicetitan.com/"), which never `=`-matches a bare-host row.
function normalizeHostname(raw) {
    if (!raw) return raw;
    let host = String(raw).trim();
    host = host.replace(/^https?:\/\//i, '');   // drop scheme
    host = host.split('/')[0];                   // drop path / trailing slash
    host = host.split('?')[0];                   // drop query
    host = host.split(':')[0];                   // drop port
    return host.toLowerCase();
}

function isIntegrationTenant(tenantId) {
    return String(tenantId ?? '').trim() === INTEGRATION_TENANT_ID;
}

function getCrmBaseUrl(tenantId) {
    return isIntegrationTenant(tenantId) ? INTEGRATION_CRM_URI : process.env.SERVICE_TITAN_CRM_URI;
}

function getAccessTokenUrl(tenantId) {
    return isIntegrationTenant(tenantId) ? INTEGRATION_ACCESS_TOKEN_URI : process.env.SERVICE_TITAN_ACCESS_TOKEN_URI;
}

apiLog.installErrorInterceptor(serviceTitanApiClient, 'ServiceTitan');

// Format a timestamp with the user's chosen date format from the extension settings
// (userSettings.logDateFormat — one of RC's six formats, e.g. 'MM/DD/YYYY hh:mm:ss A'),
// applying the user's timezone offset the same way core's callLogComposer does.
function formatDateTime({ user, time }) {
    let momentTime = moment(time);
    const tz = user?.timezoneOffset;
    if (tz) {
        momentTime = (typeof tz === 'string' && tz.includes(':'))
            ? momentTime.utcOffset(tz)
            : momentTime.utcOffset(Number(tz));
    }
    return momentTime.format(user?.userSettings?.logDateFormat?.value || 'YYYY-MM-DD hh:mm:ss A');
}

// The log id is the ServiceTitan page path (see jobs.parseLogId), so it no longer carries the
// customer note id. The note is found by the call session id it records instead — that is stable
// across every update of a call, where the note id changes each time the note is replaced.
const CALL_SESSION_LINE = 'Call Session ID:';

function findCallLogNote(notes, sessionId, legacyNoteId) {
    const byRecency = [...(notes ?? [])].sort(
        (a, b) => new Date(b.createdOn ?? 0).getTime() - new Date(a.createdOn ?? 0).getTime()
    );
    if (sessionId) {
        const bySession = byRecency.find(note => String(note.text ?? '').includes(`${CALL_SESSION_LINE} ${sessionId}`));
        if (bySession) return bySession;
    }
    // Logs written before the path scheme still carry a real note id in the log id.
    return legacyNoteId ? (byRecency.find(note => String(note.id) === String(legacyNoteId)) ?? null) : null;
}

// Summary written onto a job raised from an interaction, so a dispatcher opening the job can see
// where it came from.
function newJobSummaryFor(interactionKind, direction) {
    const directionPrefix = direction ? `${String(direction).toLowerCase()} ` : '';
    return `Opened from a ${directionPrefix}RingCentral ${interactionKind}.`;
}

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

async function getUserInfo({ hostname, additionalInfo, authHeader, platform }) {
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

    // The QA tenant is licensed against the integration hostname, not the manifest's fixed one.
    const resolvedHostname = resolveHostname({ tenantId, hostname });

    apiLog.logStart('ServiceTitan', 'getUserInfo', { userId, tenantId, rcAccountId, hostname: resolvedHostname });

    if (models && models.companies && models.customer && rcAccountId) {
        try {
            // Resolve the company by RC account + hostname + active status (not tenantId — the ST
            // tenant is an app-level credential, not the licensing key). Tiered so it works
            // whichever form the row was provisioned with:
            //   1. hostname exactly as received ("https://go.servicetitan.com/")
            //   2. the bare host ("go.servicetitan.com") — the table's convention
            //   3. rcAccountId + status — rows provisioned without a hostname
            const rawHostname = resolvedHostname ? String(resolvedHostname).trim().toLowerCase() : '';
            const bareHostname = normalizeHostname(rawHostname) || '';
            let company = null;
            if (rawHostname) {
                company = await models.companies.findOne({
                    where: { rcAccountId: String(rcAccountId), hostname: rawHostname, status: true },
                    raw: true
                });
            }
            if (!company && bareHostname && bareHostname !== rawHostname) {
                company = await models.companies.findOne({
                    where: { rcAccountId: String(rcAccountId), hostname: bareHostname, status: true },
                    raw: true
                });
            }
            if (!company) {
                company = await models.companies.findOne({
                    where: { rcAccountId: String(rcAccountId), status: true },
                    raw: true
                });
            }
            if (!company) {
                return {
                    successful: false,
                    returnMessage: {
                        messageType: 'error',
                        message: 'No active subscription found for this account. Please contact Gate6 support.',
                        ttl: 5000
                    }
                };
            }

            const existingCustomer = await models.customer.findOne({
                where: { companyId: company.id, sysId: String(userId) },
                raw: true
            });

            if (!existingCustomer) {
                const currentSeatCount = await models.customer.count({
                    where: { companyId: company.id }
                });

                const maxSeats = Number(company.maxAllowedUsers);
                if (Number.isFinite(maxSeats) && maxSeats >= 0 && currentSeatCount >= maxSeats) {
                    return {
                        successful: false,
                        returnMessage: {
                            messageType: 'error',
                            message: `License seat limit reached (${maxSeats} of ${maxSeats} in use). Contact your admin.`,
                            ttl: 5000
                        }
                    };
                }

                await models.customer.create({
                    sysId: String(userId),
                    companyId: company.id,
                    email: rcUserEmail || '',
                    firstname: rcUserName || 'ServiceTitan User',
                    platform: platform || 'gate6.servicetitan',
                    hostname: resolvedHostname,
                    rcAccountId
                });
            }
        } catch (err) {
            console.error('Error enforcing customer seat limits:', err);
        }
    }

    try {
        const accessToken = await generateServiceTitanToken(clientId, clientSecret, tenantId);

        apiLog.logSuccess('ServiceTitan', 'getUserInfo', { userId, tenantId, apiEndpoint: getAccessTokenUrl(tenantId) });

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


// Core's apiKey login path writes the user's hostname straight from the request (the manifest's
// fixed https://go.servicetitan.com/) and ignores platformUserInfo.overridingHostname — only the
// OAuth path honours that. So correct it here, right after the row is saved, for the QA tenant:
// license.ts resolves the company by user.hostname, which must match the integration row.
async function postSaveUserInfo({ userInfo }) {
    try {
        const userId = userInfo?.id;
        if (userId) {
            // saveUserInfo returns only { id, name } — not the Sequelize instance — so re-fetch.
            const user = await UserModel.findByPk(userId);
            const pai = user?.platformAdditionalInfo || user?.dataValues?.platformAdditionalInfo || {};
            if (user && isIntegrationTenant(pai.tenant) && user.hostname !== INTEGRATION_HOSTNAME) {
                const previousHostname = user.hostname;
                user.hostname = INTEGRATION_HOSTNAME;
                await user.save();
                licenseHelper.clearLicenseCache(userId);
                console.log('[ServiceTitan][postSaveUserInfo] stored integration hostname', {
                    userId, previousHostname, hostname: INTEGRATION_HOSTNAME
                });
            }
        }
    } catch (e) {
        console.warn('[ServiceTitan][postSaveUserInfo] failed to store integration hostname:', e.message);
    }
    return userInfo;
}

// Helper function to generate ServiceTitan token. The tenant decides which auth host to use —
// integration credentials only authenticate against the integration host, and vice versa.
async function generateServiceTitanToken(clientId, clientSecret, tenantId) {
    const tokenUrl = getAccessTokenUrl(tenantId);
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
    const findContactUrl = `${getCrmBaseUrl(tenantId)}/${tenantId}/customers?phone=${phoneNumberWithoutCountryCode}&active=true`;
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
        const seenIds = new Set();
        for (let rawPersonInfo of personInfo.data.data) {
            if (seenIds.has(rawPersonInfo.id)) continue;
            seenIds.add(rawPersonInfo.id);

            rawPersonInfo['phoneNumber'] = phoneNumber;
            const contact = formatContact(rawPersonInfo);
            contact.additionalInfo = await jobs.buildJobAdditionalInfo({
                user,
                crmBaseUrl: getCrmBaseUrl(tenantId),
                tenantId,
                auth,
                stAppKey: user.dataValues.platformAdditionalInfo.st_app_key,
                customerId: contact.id,
                logPrefix: '[ServiceTitan] findContact:'
            });
            matchedContactInfo.push(contact);
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
        const findContactWithNameUrl = `${getCrmBaseUrl(tenantId)}/${tenantId}/customers?name=${name}&active=true`;
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
            const seenIds = new Set();
            for (let rawPersonInfo of personInfo.data.data) {
                if (seenIds.has(rawPersonInfo.id)) continue;
                seenIds.add(rawPersonInfo.id);

                const phone = rawPersonInfo.phones?.find(p => p.type === 'Primary')?.phone ?? '';
                rawPersonInfo['phoneNumber'] = phone;
                const contact = formatContact(rawPersonInfo);
                contact.additionalInfo = await jobs.buildJobAdditionalInfo({
                    user,
                    crmBaseUrl: getCrmBaseUrl(tenantId),
                    tenantId,
                    auth,
                    stAppKey,
                    customerId: contact.id,
                    logPrefix: '[ServiceTitan] findContactWithName:'
                });
                matchedContactInfo.push(contact);
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

        const createContactUrl = `${getCrmBaseUrl(tenantId)}/${tenantId}/customers`;
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

        await trackAnalytics({ user, crm: 'ServiceTitan', event: 'contactCreated' });

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

// When a call/message is logged against a customer picked by name, the number the interaction
// actually came in on is not one ServiceTitan has on that customer. Append it to the customer's
// contact methods (its `contacts` array natively holds multiple typed phones) so a later lookup
// of that number resolves to this customer instead of prompting a name search.
//
// The customer's stored numbers are NOT on contactInfo — core sets contactInfo.phoneNumber to
// the CALL's number — so read them from the customer by id and only append a genuinely new one.
async function appendContactNumberIfNew({ user, contactInfo, receivedNumber, auth, tenantId, stAppKey, logPrefix }) {
    if (!contactInfo?.id || !receivedNumber) return;

    const cleaned = String(receivedNumber).replace(' ', '+');
    const parsed = parsePhoneNumber(cleaned);
    const value = parsed.valid ? parsed.number.significant : cleaned;
    try {
        const customerUrl = `${getCrmBaseUrl(tenantId)}/${tenantId}/customers/${contactInfo.id}`;
        const existing = await serviceTitanApiClient.get(
            customerUrl,
            { headers: { Authorization: `Bearer ${auth}`, 'ST-App-Key': stAppKey }, _operation: 'appendContactNumber' }
        );
        // ServiceTitan exposes phones as a `phones` array ({ type, phone }); `contacts` ({ type,
        // value }) is the write shape. Gather both so an existing number isn't duplicated.
        const known = [
            ...(existing.data?.phones || []).map(p => p?.phone),
            ...(existing.data?.contacts || []).filter(c => String(c?.type || '').toLowerCase().includes('phone')).map(c => c?.value)
        ].filter(Boolean);
        if (!phoneWriteback.isNewNumberForContact(receivedNumber, known)) return;

        await serviceTitanApiClient.post(
            `${customerUrl}/contacts`,
            { type: 'Phone', value, memo: 'Added by RingCentral App Connect' },
            {
                headers: { Authorization: `Bearer ${auth}`, 'ST-App-Key': stAppKey, 'Content-Type': 'application/json' },
                _operation: 'appendContactNumber'
            }
        );
        console.log(`${logPrefix} appended new number to customer:`, contactInfo.id);
    } catch (err) {
        console.warn(`${logPrefix} failed to append contact number:`, err?.response?.data || err.message);
    }
}

async function getUserList({ user, authHeader }) {
    apiLog.logStart('ServiceTitan', 'getUserList', {});

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    try {
        const getUserListUrl = `${getCrmBaseUrl(tenantId)}/${tenantId}/customers`;
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

async function createCallLog({ user, contactInfo, callLog, note, aiNote, transcript, additionalSubmission }) {
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

    // Structural, not decorative: this line is how a later update or read finds this note again,
    // now that the log id is the ServiceTitan page path. It is written unconditionally so a setting
    // can never make a call log unfindable.
    if (callLog.sessionId) {
        headerLines.push(`${CALL_SESSION_LINE} ${callLog.sessionId}`);
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
        footerLines.push(`Start Time: ${formatDateTime({ user, time: callLog.startTime })}`);
        if (callLog.duration) {
            footerLines.push(`End Time: ${formatDateTime({ user, time: moment(callLog.startTime).add(callLog.duration, "seconds") })}`);
        }
    }

    let noteText = headerLines.join("\n");
    if (optionalSections) noteText += `\n\n${optionalSections}`;
    if (footerLines.length > 0) noteText += `\n\n${footerLines.join("\n")}`;

    const targetJob = await jobs.resolveTargetJob({
        user,
        crmBaseUrl: getCrmBaseUrl(tenantId),
        tenantId, auth, stAppKey,
        customerId: contactInfo.id,
        additionalSubmission,
        newJobSummary: newJobSummaryFor('call', callLog?.direction)
    });

    // The customer's notes always get the call, so a customer's full communication history stays in
    // one place regardless of which job each call was about. It is also written first because its
    // response carries the only real note id ServiceTitan gives us.
    const createCallLogUrl = `${getCrmBaseUrl(tenantId)}/${tenantId}/customers/${contactInfo.id}/notes`;
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
    const customerNoteId = addNoteRes.data.id;

    let logId = jobs.buildCustomerLogId(contactInfo.id);
    let placement = 'Call log created';

    // A selected job additionally gets the call, filed where dispatchers and technicians read.
    const { jobId, warning: jobNoteWarning } = await writeJobNote({
        targetJob, tenantId, auth, stAppKey, customerNoteId, noteText, operation: 'createCallLog'
    });
    if (jobId) {
        // The id points at the job so "view log" lands on the job page rather than the customer.
        logId = jobs.buildJobLogId(jobId);
        placement = targetJob.createdJobNumber
            ? `Call log created on new job #${targetJob.createdJobNumber} and the customer`
            : 'Call log created on the job and the customer';
    }

    apiLog.logSuccess('ServiceTitan', 'createCallLog', { logId, contactId: contactInfo.id, jobId: jobId ?? null, apiEndpoint: createCallLogUrl });

    // Write the number this call came in on into the CRM customer so a later lookup of it resolves
    // to this customer instead of prompting a name search.
    const receivedNumber = phoneWriteback.resolveCounterpartyNumber({ callLog });
    await appendContactNumberIfNew({ user, contactInfo, receivedNumber, auth, tenantId, stAppKey, logPrefix: '[ServiceTitan] createCallLog:' });

    await trackAnalytics({ user, crm: 'ServiceTitan', event: 'callLogCreated', eventDate: callLog?.startTime });

    // A job that could not be used is worth telling the agent about — the log still saved, just not
    // everywhere they asked for it.
    const warning = targetJob.warning ?? jobNoteWarning;

    return {
        logId,
        contactId: contactInfo.id,
        returnMessage: {
            message: warning ? `${placement}. ${warning}` : placement,
            messageType: warning ? "warning" : "success",
            ttl: warning ? 5000 : 2000
        }
    };
}


async function updateCallLog({ user, existingCallLog, recordingLink, note, aiNote, transcript, subject, duration: incomingDuration, startTime: incomingStartTime, result: incomingResult, additionalSubmission }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'updateCallLog', { logId: existingCallLog?.thirdPartyLogId, contactId: existingCallLog?.contactId });

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const contactId = existingCallLog.contactId;

    const { jobId: currentJobId, legacyNoteId } = jobs.parseLogId(existingCallLog.thirdPartyLogId);
    // The call session id is the handle on the customer note; the log id is a page path now.
    const sessionId = existingCallLog.sessionId;

    let direction = "";
    let startTime = "";
    let endTime = "";
    let callSessionId = "";
    let rcUsername = "";
    let rcPhone = "";
    let contactPhone = "";
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
    // Every call is written to the customer's notes whether or not it is also on a job, so the
    // customer note is the log's system of record and the previous content always comes from there.
    let body = "";
    const getLogRes = await serviceTitanApiClient.get(
        `${getCrmBaseUrl(tenantId)}/${tenantId}/customers/${contactId}/notes?pageSize=100`,
        {
            headers: {
                Authorization: `Bearer ${auth}`,
                "ST-App-Key": stAppKey
            },
            _operation: 'updateCallLog'
        }
    );

    const targetLog = findCallLogNote(getLogRes.data?.data, sessionId, legacyNoteId);
    // The note actually read is the one replaced below, so a stale or missing id cannot delete
    // somebody else's note.
    const previousNoteId = targetLog?.id ?? null;

    if (targetLog) {
        body = targetLog.text || "";
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
        callSessionId = normalized.match(/^\s*Call Session ID:\s*(.*)$/m)?.[1]?.trim() || "";
        rcUsername = normalized.match(/^\s*RingCentral Username:\s*(.*)$/m)?.[1]?.trim() || "";
        rcPhone = normalized.match(/^\s*RingCentral Phone Number:\s*(.*)$/m)?.[1]?.trim() || "";
        contactPhone = normalized.match(/^\s*Contact Number:\s*(.*)$/m)?.[1]?.trim() || "";
        result = normalized.match(/^\s*Result:\s*(.*)$/m)?.[1]?.trim() || "";
        duration = normalized.match(/^\s*Duration:\s*(.*)$/m)?.[1]?.replace(/\s*sec$/i, '').trim() || "";
        // Multi-line fields end at the next "Label:" line; single-line ones at the next newline.
        oldNote = normalized.match(/Agent Notes:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/)?.[1]?.trim() || "";
        oldAiNote = normalized.match(/AI Note\s*:\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/i)?.[1]?.trim() || "";
        oldTranscript = normalized.match(/(?:AI transcript|Transcript):\s*([\s\S]*?)(?:\n\s*[A-Z][^\n]*:|$)/i)?.[1]?.trim() || "";
        oldRecording = normalized.match(/Recording:\s*(.*?)(?:\n|$)/)?.[1]?.trim() || "";
    }

    // Override parsed values with fresh data from the framework when available.
    // The initial createCallLog fires with 1-sec duration; the later updateCallLog
    // call from the framework carries the finalized call metadata.
    if (incomingDuration != null) {
        duration = String(incomingDuration);
    }
    if (incomingResult) {
        result = incomingResult;
    }
    if (incomingStartTime) {
        startTime = formatDateTime({ user, time: incomingStartTime });
        if (incomingDuration != null) {
            endTime = formatDateTime({ user, time: moment(incomingStartTime).add(incomingDuration, "seconds") });
        }
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
    // Never leave the subject blank (matches the create-side fallback).
    if (!subjectToUse) {
        subjectToUse = direction ? `${direction} Call` : "Call";
    }

    // ---------------- FINAL STRUCTURED NOTE (left-aligned, no indentation) ----------------

    const headerLines = [];
    if (subjectToUse) headerLines.push(`Subject: ${subjectToUse}`);
    if (direction) headerLines.push(`Direction: ${direction}`);

    if (result && (user.userSettings?.addCallLogResult?.value ?? true)) {
        headerLines.push(`Result: ${result}`);
    }
    if (duration && (user.userSettings?.addCallLogDuration?.value ?? true)) {
        headerLines.push(`Duration: ${duration} sec`);
    }
    // Carried forward for the same reason it is written on create — see createCallLog.
    if (callSessionId) {
        headerLines.push(`${CALL_SESSION_LINE} ${callSessionId}`);
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
    if (startTime && (user.userSettings?.addCallLogDateTime?.value ?? true)) {
        footerLines.push(`Start Time: ${startTime}`);
    }
    if (endTime && (user.userSettings?.addCallLogDateTime?.value ?? true)) {
        footerLines.push(`End Time: ${endTime}`);
    }

    const optionalSections = sections.join("\n\n");
    let noteText = headerLines.join("\n");
    if (optionalSections) noteText += `\n\n${optionalSections}`;
    if (footerLines.length > 0) noteText += `\n\n${footerLines.join("\n")}`;

    let newLogId;

    // ---------------- UPDATE NOTES ----------------

    // The job is settled when the log is created and never changes afterwards. The edit form still
    // submits the Job dropdown, but acting on it would file the update against a different job and
    // strand the original — which would still show a call whose latest version lives elsewhere. So
    // updates always go to the job the log was created against, and to no other.
    const targetJob = { jobId: currentJobId };

    // ServiceTitan customer notes have no in-place update endpoint, so an edit is a
    // create-then-delete: post the replacement note, then delete the original so we don't
    // leave a duplicate. Order matters — create first so a delete failure never loses the
    // edited content (worst case is a leftover duplicate, not data loss).
    const addNoteRes = await serviceTitanApiClient.post(
        `${getCrmBaseUrl(tenantId)}/${tenantId}/customers/${contactId}/notes`,
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

    const newCustomerNoteId = addNoteRes.data.id;

    if (previousNoteId && String(newCustomerNoteId) !== String(previousNoteId)) {
        try {
            await serviceTitanApiClient.delete(
                `${getCrmBaseUrl(tenantId)}/${tenantId}/customers/${contactId}/notes/${previousNoteId}`,
                {
                    headers: { Authorization: `Bearer ${auth}`, "ST-App-Key": stAppKey },
                    _operation: 'updateCallLog'
                }
            );
        } catch (e) {
            console.warn('[ServiceTitan][updateCallLog] could not delete the old note — a duplicate may remain', { oldNoteId: previousNoteId, status: e?.response?.status, message: e?.message });
        }
    }

    const { jobId, warning: jobNoteWarning } = await writeJobNote({
        targetJob, tenantId, auth, stAppKey, customerNoteId: newCustomerNoteId, noteText, operation: 'updateCallLog'
    });
    // The id is a page path, so it does not change as the note behind it is replaced.
    newLogId = jobId ? jobs.buildJobLogId(jobId) : jobs.buildCustomerLogId(contactId);

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

    apiLog.logSuccess('ServiceTitan', 'updateCallLog', { logId: newLogId, contactId, jobId: jobId ?? null });

    await trackAnalytics({ user, crm: 'ServiceTitan', event: 'callLogUpdated' });

    const updatePlacement = jobId ? 'Call log updated on the job and the customer' : 'Call log updated';

    return {
        logId: newLogId,
        returnMessage: {
            message: jobNoteWarning ? `${updatePlacement}. ${jobNoteWarning}` : updatePlacement,
            messageType: jobNoteWarning ? "warning" : "success",
            ttl: jobNoteWarning ? 5000 : 2000
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

// An SMS thread is found by its own content rather than by the stored log id.
//
// ServiceTitan has no in-place note update, so every appended message replaces the note and changes
// its id. Core does not carry that new id forward: on the update path it stamps each message's row
// with the id as it was BEFORE the update (handlers/log.ts) and writes one row per message, all
// sharing a conversationLogId. Its unordered `findOne` then hands us whichever of those rows it
// likes — often one holding a note id that has since been replaced and deleted. Looking that id up
// finds nothing, and the thread silently restarts as a one-message note.
//
// So the id is not trusted. The thread is the newest note on the customer that this connector wrote
// for this counterparty, which stays correct no matter which row core passes in.
const CONVERSATION_HEADER = 'Conversation';

// The number is in the header because it both identifies the thread for the lookup below and tells
// a reader which number the exchange was with — a customer can have more than one.
function buildConversationHeader(counterpartyNumber) {
    return counterpartyNumber
        ? `${CONVERSATION_HEADER} with ${counterpartyNumber}:`
        : `${CONVERSATION_HEADER}:`;
}

// Matches both header forms so a thread started before the number was recorded still continues.
const CONVERSATION_BODY = /Conversation(?: with [^:\n]*)?:\s*([\s\S]*)/;

// Picks the thread note to continue: the most recent one for this counterparty, falling back to an
// un-numbered thread note when none carries the number yet.
function findConversationNote(notes, counterpartyNumber) {
    const byRecency = [...(notes ?? [])].sort(
        (a, b) => new Date(b.createdOn ?? 0).getTime() - new Date(a.createdOn ?? 0).getTime()
    );
    const header = buildConversationHeader(counterpartyNumber);
    return byRecency.find(note => String(note.text ?? '').trimStart().startsWith(header))
        ?? byRecency.find(note => String(note.text ?? '').trimStart().startsWith(`${CONVERSATION_HEADER}:`))
        ?? null;
}

// An SMS thread is rebuilt into a single note on every message, so it is capped and restarted
// rather than growing without limit. The overlap repeats the tail of the old thread at the top of
// the new note so the new one does not open mid-conversation.
const MAX_THREAD_MESSAGES = 10;
const THREAD_OVERLAP_MESSAGES = 1;
// Backstop for threads whose messages are long enough to outgrow a note before hitting the count.
const MAX_NOTE_SIZE = 30000;

// Each message starts with a bracketed timestamp: "[03/08/2026 10:00:00 AM] Jane Smith: text".
const CONVERSATION_MESSAGE_LINE = /^\[[^\]]+\]\s+[^:]+:/;

// Splits a stored conversation back into messages. A text can itself contain line breaks, so the
// split is on the timestamped line that opens each message rather than on every newline —
// counting raw lines would restart threads early and truncate multi-line texts on restart.
function splitConversationMessages(conversation) {
    const messages = [];
    for (const line of String(conversation ?? '').split('\n')) {
        if (CONVERSATION_MESSAGE_LINE.test(line)) {
            messages.push(line);
        } else if (messages.length > 0) {
            messages[messages.length - 1] += `\n${line}`;
        }
    }
    return messages;
}

// Mirrors the job note the call log path writes. Returns the job actually written to, or a warning
// when it could not be — the interaction is already safe on the customer either way, so a job note
// failure is never worth failing the log over.
async function writeJobNote({ targetJob, tenantId, auth, stAppKey, customerNoteId, noteText, operation }) {
    if (!targetJob.jobId) return { jobId: null };
    try {
        await jobs.postJobNote({
            crmBaseUrl: getCrmBaseUrl(tenantId),
            tenantId, auth, stAppKey,
            jobId: targetJob.jobId,
            text: noteText,
            operation
        });
        return { jobId: targetJob.jobId };
    } catch (err) {
        console.warn(`[ServiceTitan][${operation}] could not write the job note:`, err?.response?.data || err.message);
        return { jobId: null, warning: 'It could not be written to the job, so it is on the customer notes only.' };
    }
}

async function createMessageLog({ user, contactInfo, message, recordingLink, faxDocLink, additionalSubmission }) {
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
            `[${formatDateTime({ user, time: message.creationTime })}] ${direction}: ${message.subject}`;

        // The header carries the counterparty number so follow-up messages can find this thread
        // again — see findConversationNote.
        noteText = `
${buildConversationHeader(phoneWriteback.resolveCounterpartyNumber({ message }))}
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

    const targetJob = await jobs.resolveTargetJob({
        user,
        crmBaseUrl: getCrmBaseUrl(tenantId),
        tenantId, auth, stAppKey,
        customerId: contactId,
        additionalSubmission,
        newJobSummary: newJobSummaryFor(messageType.toLowerCase(), message?.direction)
    });

    // As with calls, the customer's notes always get the message and are written first — their
    // response carries the only real note id ServiceTitan returns.
    const createMessageLogUrl = `${getCrmBaseUrl(tenantId)}/${tenantId}/customers/${contactId}/notes`;
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
    const customerNoteId = addLogRes.data.id;

    // A message log with no job keeps its bare numeric id, exactly as before this feature — only a
    // job-linked log takes the suffixed form.
    let logId = jobs.buildCustomerLogId(contactId);
    let placement = 'Message logged as a note';
    const { jobId, warning } = await writeJobNote({
        targetJob, tenantId, auth, stAppKey, customerNoteId, noteText, operation: 'createMessageLog'
    });
    if (jobId) {
        logId = jobs.buildJobLogId(jobId);
        placement = targetJob.createdJobNumber
            ? `Message logged on new job #${targetJob.createdJobNumber} and the customer`
            : 'Message logged on the job and the customer';
    }

    apiLog.logSuccess('ServiceTitan', 'createMessageLog', { logId, contactId, jobId: jobId ?? null, apiEndpoint: createMessageLogUrl });

    // Same write-back as createCallLog: append the number this message came in on to the CRM customer.
    const receivedNumber = phoneWriteback.resolveCounterpartyNumber({ message });
    await appendContactNumberIfNew({ user, contactInfo, receivedNumber, auth, tenantId, stAppKey, logPrefix: '[ServiceTitan] createMessageLog:' });
    await trackAnalytics({ user, crm: 'ServiceTitan', event: 'messageLogCreated', eventDate: message?.creationTime });

    const messageWarning = targetJob.warning ?? warning;
    return {
        logId,
        contactId,
        returnMessage: {
            message: messageWarning ? `${placement}. ${messageWarning}` : placement,
            messageType: messageWarning ? "warning" : "success",
            ttl: messageWarning ? 5000 : 1000
        }
    };
}

async function updateMessageLog({ user, contactInfo, existingMessageLog, message, recordingLink, faxDocLink, additionalSubmission }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'updateMessageLog', { contactId: contactInfo?.id, logId: existingMessageLog?.thirdPartyLogId, direction: message?.direction });

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    const contactId = contactInfo.id;
    // Message logs predate job support and stored a bare note id; parseLogId reads both that and the
    // job-linked `{customerNoteId}_{jobId}_jobnote` form.
    const { jobId: currentJobId, legacyNoteId } = jobs.parseLogId(existingMessageLog.thirdPartyLogId);

    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    let noteText = "";
    // The replacement note normally carries the whole conversation forward, making the note it
    // replaces redundant. The one exception is an SMS thread restart — see below.
    let supersedesPreviousNote = true;
    // The note this update replaces. Resolved from the thread's own content rather than the stored
    // log id — core hands back ids of notes that have since been replaced and deleted.
    let previousNoteId = legacyNoteId;

    // ---------------- SMS CASE ----------------
    if (messageType === "SMS") {

        const getLogRes = await serviceTitanApiClient.get(
            `${getCrmBaseUrl(tenantId)}/${tenantId}/customers/${contactId}/notes?pageSize=100`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey
                },
                _operation: 'updateMessageLog'
            }
        );

        const counterpartyNumber = phoneWriteback.resolveCounterpartyNumber({ message });
        const targetLog = findConversationNote(getLogRes.data?.data, counterpartyNumber);
        previousNoteId = targetLog?.id ?? null;

        let previousConversation = "";

        if (targetLog?.text) {
            const match = targetLog.text.match(CONVERSATION_BODY);
            if (match) {
                previousConversation = match[1].trim();
            }
        }

        const direction =
            message.direction === "Inbound"
                ? contactInfo.name
                : "Agent";

        const newLine =
            `[${formatDateTime({ user, time: message.creationTime })}] ${direction}: ${message.subject}`;

        const updatedConversation =
            previousConversation
                ? `${previousConversation}\n${newLine}`
                : newLine;

        const previousMessages = splitConversationMessages(previousConversation);

        // The note is capped by message count so a thread breaks at a predictable point. The size
        // cap stays as a backstop: ten unusually long texts could still outgrow a ServiceTitan
        // note, and a rejected note would lose the message outright.
        if (previousMessages.length >= MAX_THREAD_MESSAGES || updatedConversation.length > MAX_NOTE_SIZE) {

            // Carry the tail of the old thread into the new note so it does not open without context.
            const newThreadConversation =
                [...previousMessages.slice(-THREAD_OVERLAP_MESSAGES), newLine].join("\n");

            noteText = `
${buildConversationHeader(counterpartyNumber)}
${newThreadConversation}
`.trim();

            // The thread has been restarted rather than carried forward, so the previous note is
            // the only copy of the conversation up to this point — it must be kept as history.
            supersedesPreviousNote = false;

        } else {

            noteText = `
${buildConversationHeader(counterpartyNumber)}
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

    // As with call logs, the job is settled when the thread is first logged. Later messages continue
    // on that job and are never re-filed against a different one.
    const targetJob = { jobId: currentJobId };

    const updateMessageLogUrl = `${getCrmBaseUrl(tenantId)}/${tenantId}/customers/${contactId}/notes`;
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
    const newCustomerNoteId = addLogRes.data.id;

    // The replacement note carries the whole conversation, so the one it supersedes is a strictly
    // shorter copy of it — remove it rather than leaving a note per message on the customer. Create
    // first, so a failed delete costs a duplicate and never the conversation itself.
    if (supersedesPreviousNote && previousNoteId && String(newCustomerNoteId) !== String(previousNoteId)) {
        try {
            await serviceTitanApiClient.delete(
                `${updateMessageLogUrl}/${previousNoteId}`,
                {
                    headers: { Authorization: `Bearer ${auth}`, "ST-App-Key": stAppKey },
                    _operation: 'updateMessageLog'
                }
            );
        } catch (e) {
            console.warn('[ServiceTitan][updateMessageLog] could not delete the superseded note — a duplicate may remain', { oldNoteId: previousNoteId, status: e?.response?.status, message: e?.message });
        }
    }

    let newLogId = jobs.buildCustomerLogId(contactId);
    const { jobId, warning } = await writeJobNote({
        targetJob, tenantId, auth, stAppKey, customerNoteId: newCustomerNoteId, noteText, operation: 'updateMessageLog'
    });
    if (jobId) {
        newLogId = jobs.buildJobLogId(jobId);
    }

    const messageLogID_db = await MessageLogModel.findOne({
        where: {
            thirdPartyLogId: existingMessageLog.thirdPartyLogId
        }
    });

    if (messageLogID_db) {
        messageLogID_db.thirdPartyLogId = newLogId;
        await messageLogID_db.save();
    }

    apiLog.logSuccess('ServiceTitan', 'updateMessageLog', { logId: newLogId, contactId, jobId: jobId ?? null, apiEndpoint: updateMessageLogUrl });


    await trackAnalytics({ user, crm: 'ServiceTitan', event: 'messageLogUpdated' });

    return {
        logId: newLogId,
        returnMessage: {
            message: warning
                ? `Message log updated. ${warning}`
                : (jobId ? 'Message log updated on the job and the customer' : 'Message log updated'),
            messageType: warning ? "warning" : "success",
            ttl: warning ? 5000 : 1000
        }
    };
}
async function getCallLog({ user, callLogId, telephonySessionId, contactId }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceTitan', 'getCallLog', { logId: callLogId });

    const { legacyNoteId } = jobs.parseLogId(callLogId);

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    let subject = "";
    let note = "";
    let full_data = {};

    try {

        // Several calls can share a log id now that it is a page path (every call on one job reads
        // `Job/Index/{jobId}`), so the log is resolved by telephonySessionId — CallLogModel's
        // primary key — rather than by the log id, which would match an arbitrary one of them.
        const existingCallLogDetails = telephonySessionId
            ? await CallLogModel.findByPk(telephonySessionId)
            : await CallLogModel.findOne({ where: { thirdPartyLogId: callLogId } });

        if (!existingCallLogDetails) {
            return {
                callLogInfo: {
                    subject: "",
                    note: "",
                    fullLogResponse: {}
                }
            };
        }

        const resolvedContactId = contactId ?? existingCallLogDetails.contactId;

        // Read from the customer note: it holds the same content as the job note and, unlike a job
        // note, it can be located and re-read.
        let rawBody = null;
        const getLogRes = await serviceTitanApiClient.get(
            `${getCrmBaseUrl(tenantId)}/${tenantId}/customers/${resolvedContactId}/notes?pageSize=100`,
            {
                headers: {
                    Authorization: `Bearer ${auth}`,
                    "ST-App-Key": stAppKey
                },
                _operation: 'getCallLog'
            }
        );

        const targetLog = findCallLogNote(getLogRes.data?.data, existingCallLogDetails.sessionId, legacyNoteId);
        if (targetLog) {
            rawBody = targetLog.text || "";
        }

        if (rawBody !== null) {

            const body = rawBody;
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

    } catch (error) {

        console.error(
            "Failed to fetch call log:",
            error?.response?.data || error.message
        );

    }

    apiLog.logSuccess('ServiceTitan', 'getCallLog', { logId: callLogId });

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
    const { client_id, client_secret, expiresAt, tenant } = platformAdditionalInfo;

    if (Date.now() < expiresAt) {
        return user.dataValues.accessToken;
    }

    // Same host the login used — a refresh against the other environment fails with invalid_client.
    const tokenUrl = getAccessTokenUrl(tenant);
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
exports.postSaveUserInfo = postSaveUserInfo;
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
export { };
