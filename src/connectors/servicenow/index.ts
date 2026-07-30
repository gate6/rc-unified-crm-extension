// @ts-nocheck
const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { saveUserInfo } = require('../servicenow-core/auth');
const { findStateValueByName, findStateValueById, findTypeValueByName, findTypeValueById, getAllAccounts, applyClosedDatesIfNeeded, formatDuration } = require('../servicenow-core/interaction');
const { UserModel } = require('@app-connect/core/models/userModel');
const managedOAuthCore = require('@app-connect/core/handlers/managedOAuth');
const Op = require('sequelize').Op;
const { initModels } = require('../servicenow-models/init-models');
const Sequelize = require('sequelize');
const { sequelize } = require('../servicenow-models/sequelize');
const { raw } = require('mysql2');
const models = sequelize ? initModels(sequelize) : null;
const licenseHelper = require('../shared/license');
const { secondsToHoursMinutesSeconds } = require('@app-connect/core/lib/util');
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const s3Helper = require('../servicenow-core/s3');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const apiLog = require('../shared/apiLogger');
const { trackAnalytics } = require('../shared/analytics');
const phoneWriteback = require('../shared/phoneWriteback');
const serviceNowApiClient = axios.create();

function stringifyForLog(value, maxLength = 1200) {
    try {
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
    } catch (error) {
        return String(value);
    }
}

apiLog.installErrorInterceptor(serviceNowApiClient, 'ServiceNow');

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

// Pick a human-readable agent name out of whatever the scripted REST resource returns. The shape
// is NOT fixed — it is customer-authored per instance — so this reads the fields in descending
// order of friendliness rather than demanding one. Observed on dev388800:
//   {result:{id, user_name:'admin', email, first_name:'System', last_name:'Administrator', ...}}
// `name` is preferred but often absent; first/last is the readable form; user_name is the last
// resort because it shows the login ('admin') to end users in the work note.
function pickAgentName(result: any = {}) {
    const direct = (result.name ?? '').toString().trim();
    if (direct) return direct;
    const fullName = [result.first_name, result.last_name]
        .map(part => (part ?? '').toString().trim())
        .filter(Boolean)
        .join(' ');
    if (fullName) return fullName;
    return (result.user_name ?? '').toString().trim();
}

// Resolve the ServiceNow user behind the connection — the same scripted REST endpoint
// (companies.userDetailsPath) that createCallLog/createMessageLog already use to fill `assigned_to`
// from `result.id`. Here we want a display name, so outbound messages are attributed to the agent
// who sent them instead of a generic "You". Non-fatal: the name is cosmetic, so a missing path or
// a failing call falls back rather than breaking the log.
async function fetchAgentName({ hostname, authHeader, userDetailsPath, operation }) {
    if (!userDetailsPath) return '';
    try {
        const res = await serviceNowApiClient.get(
            `https://${hostname}/api/${userDetailsPath}`,
            { headers: { Authorization: authHeader }, _operation: operation }
        );
        return pickAgentName(res.data?.result);
    } catch (e) {
        console.warn(`[ServiceNow] ${operation}: could not resolve the agent name (status ${e?.response?.status ?? 'n/a'}) — falling back to "You" on outbound messages.`);
        return '';
    }
}

// Build a message-log work note in the same format as the Monday connector, adapted to
// ServiceNow's plain-text journal field (\n instead of <br>). Create writes this as the first
// work note; update appends the line into that same entry via writeWorkNote.
// Sender naming: inbound lines are attributed to the contact, outbound to the agent who sent them
// (`agentName`, from the same scripted REST lookup that fills `assigned_to`), falling back to "You"
// only when that lookup yields nothing.
function buildMessageLogBody({ user, message, contactInfo, messageType, recordingLink, faxDocLink, includeHeader = true, agentName = '' }) {
    if (messageType === 'Voicemail') {
        return `Voicemail from ${contactInfo.name}\n\nRecording:\n${recordingLink}`;
    }
    if (messageType === 'Fax') {
        return `Fax from ${contactInfo.name}\n\nDocument:\n${faxDocLink}`;
    }
    const sender = message.direction === 'Inbound' ? contactInfo.name : (agentName || 'You');
    const text = message.subject || message.text || '';
    const line = `[${formatDateTime({ user, time: message.creationTime || Date.now() })}] ${sender}: ${text}`;
    return includeHeader ? `SMS conversation with ${contactInfo.name}\n${line}` : line;
}

// Normalize a hostname to the bare host the companies table stores:
// strips scheme (http/https), any path/query, port, and trailing slash; lowercased.
function normalizeHostname(raw) {
    if (!raw) return raw;
    let host = String(raw).trim();
    host = host.replace(/^https?:\/\//i, '');   // drop scheme
    host = host.split('/')[0];                   // drop path / trailing slash
    host = host.split('?')[0];                   // drop query
    host = host.split(':')[0];                   // drop port
    return host.toLowerCase();
}

// Resolve the companies row for a connection. ServiceNow uses admin-managed OAuth:
// clientId/clientSecret/authorizationUri/accessTokenUri/hostname all live in the
// accountData table keyed by rcAccountId (managed-oauth-account), so rcAccountId is
// the authoritative tenant key. The hostname reaching us is the managed-OAuth one and
// may not match what the companies row was provisioned with — so lookups are tiered:
//   1. rcAccountId + hostname — disambiguates accounts with one row per instance
//   2. rcAccountId only       — rows without a hostname (admin-managed provisioning)
//   3. hostname only          — LEGACY rows that predate rcAccountId (prevents lockout)
async function findCompany({ rcAccountId, hostname }) {
    if (!models?.companies) return null;
    const cleanHostname = normalizeHostname(hostname);
    let company = null;
    if (rcAccountId && cleanHostname) {
        company = await models.companies.findOne({
            where: { rcAccountId: String(rcAccountId), hostname: cleanHostname, status: true },
            raw: true
        });
    }
    if (!company && rcAccountId) {
        company = await models.companies.findOne({
            where: { rcAccountId: String(rcAccountId), status: true },
            raw: true
        });
    }
    if (!company && cleanHostname) {
        company = await models.companies.findOne({
            where: { hostname: cleanHostname, status: true },
            raw: true
        });
    }
    return company;
}

async function getLicenseStatus({ userId }) {
    return licenseHelper.getLicenseStatus({ models, userId });
}

async function validateLicenseOrFail(user) {
    return licenseHelper.validateLicenseOrFail({ models, user });
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
        attributes: ['id', 'hostname'],
        raw: true
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

// Managed-OAuth credentials are stored per (rcAccountId, platformName), so resolving the
// right platform key matters — this connector is registered under several of them
// (servicenow, gate6.servicenow, ...; see src/index.ts) and a hardcoded key reads another
// tenant's credentials. The users table already records which key the user connected
// under, and that is the authoritative source: core resolves managed OAuth itself during
// login and only calls getOauthInfo on token REFRESH, where the user row always exists.
async function resolvePlatformName({ hostname, rcAccountId }) {
    const where = {};
    if (hostname) where.hostname = hostname;
    if (rcAccountId) where.rcAccountId = String(rcAccountId);
    if (Object.keys(where).length === 0) return null;
    try {
        const user = await UserModel.findOne({ where, attributes: ['platform'], raw: true });
        return user?.platform ?? null;
    } catch (error) {
        console.error('[ServiceNow][getOauthInfo] failed to resolve platform name:', error.message);
        return null;
    }
}

async function getOauthInfo({ hostname, rcAccountId, platform } = {}) {
    // Credentials are managed via AppConnect admin-managed OAuth (clientId/clientSecret/
    // accessTokenUri live in accountData keyed by rcAccountId). During login the core
    // resolves this before calling us; but the token-REFRESH paths (log/contact handlers)
    // call getOauthInfo directly with only a hostname — no rcAccountId — so we resolve the
    // managed config here too. Without it, refresh builds an OAuth app with no accessTokenUri
    // and client-oauth2 crashes ("Cannot read properties of undefined (reading 'clone')"),
    // which logs the user out a few minutes after login when the access token expires.
    let accountId = rcAccountId;
    if (!accountId && hostname) {
        const company = await findCompany({ hostname });
        accountId = company?.rcAccountId;
    }
    if (accountId) {
        try {
            const resolvedPlatform = platform ?? await resolvePlatformName({ hostname, rcAccountId: accountId });
            if (resolvedPlatform) {
                const managed = await managedOAuthCore.resolveManagedOAuthInfo({ rcAccountId: accountId, platform: resolvedPlatform });
                if (managed?.oauthInfo?.clientId && managed?.oauthInfo?.accessTokenUri) {
                    return managed.oauthInfo;
                }
            }
        } catch (error) {
            console.error('[ServiceNow][getOauthInfo] failed to resolve managed OAuth:', error.message);
        }
    }
    // This fallback is only reached if managed OAuth is not yet configured.
    return {
        failMessage: 'ServiceNow OAuth credentials have not been configured. Please ask your admin to set up the connector via the AppConnect admin panel.'
    };
}

async function getUserInfo({ authHeader, hostname, query, platform }) {
    // OAuth callback already provides `query` with rcAccountId — no framework change needed.
    const rcAccountId = query?.rcAccountId;
    try {
        apiLog.logStart('ServiceNow', 'getUserInfo', { hostname, rcAccountId });
        const userInfoUrl = `https://${hostname}/api/now/table/sys_user?sysparm_query=user_name=javascript:gs.getUserName()&sysparm_fields=sys_id,email,user_name,first_name,last_name,time_zone,time_zone_offset&sysparm_limit=1`;
        const userInfoResponse = await serviceNowApiClient.get(
            userInfoUrl,
            { headers: { Authorization: authHeader }, _operation: 'getUserInfo' }
        );

        const result = userInfoResponse.data?.result?.[0];
        if (!result) {
            return {
                successful: false,
                returnMessage: { messageType: 'warning', message: 'Could not retrieve user info from ServiceNow.', ttl: 3000 }
            };
        }

        let id = result.sys_id;
        const name = result.user_name;
        const timezoneName = result.time_zone ?? '';
        const timezoneOffset = result.time_zone_offset ?? null;

        const rcUserEmail = query?.rcUserEmail;
        const rcUserName = query?.rcUserName;

        // Admin sys_id is identical across ALL ServiceNow instances (out-of-box record),
        // so it can't be used as-is. It must map to a STABLE id — a random one would mint
        // a new user (and seat) on every login. Same approach as ServiceTitan: key on the
        // RC identity — rcExtensionId when genuinely distinct from rcAccountId, else the
        // normalized email — falling back to a per-instance hash (deterministic, never random).
        if (id === '6816f79cc0a8016401c5a33be04be441') {
            const rcExtensionId = query?.rcExtensionId;
            const emailKey = rcUserEmail ? String(rcUserEmail).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : '';
            const perUserKey =
                (rcExtensionId && String(rcExtensionId) !== String(rcAccountId)) ? String(rcExtensionId)
                    : (emailKey || (rcExtensionId ? String(rcExtensionId) : ''));
            id = perUserKey
                ? `admin-${perUserKey}`
                : crypto.createHash('sha256').update(`snow-admin:${normalizeHostname(hostname)}`).digest('hex').slice(0, 32);
        }

        // Tenant-scope the id so the same ServiceNow user under different RC accounts
        // never collides (multi-tenant isolation + per-tenant seat counting).
        if (!rcAccountId) {
            console.warn('[ServiceNow][getUserInfo] missing rcAccountId — falling back to non-tenant-scoped id');
        }
        if (rcAccountId) {
            id = `snow-${rcAccountId}-${id}`;
        }

        if (models && models.companies && models.customer && rcAccountId) {
            try {
                // Reaching this point means the core already resolved the managed-OAuth
                // config from accountData for this rcAccountId (our getOauthInfo only
                // returns a failMessage), so rcAccountId is the reliable tenant key here.
                const company = await findCompany({ rcAccountId, hostname });
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
                    where: { companyId: company.id, sysId: String(id) },
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
                        sysId: String(id),
                        companyId: company.id,
                        email: rcUserEmail || result.email || '',
                        firstname: rcUserName || name || 'ServiceNow User',
                        platform,
                        hostname,
                        rcAccountId
                    });
                }
            } catch (err) {
                console.error('Error enforcing customer seat limits:', err);
            }
        }

        apiLog.logSuccess('ServiceNow', 'getUserInfo', { contactId: id, apiEndpoint: userInfoUrl });
        return {
            successful: true,
            platformUserInfo: {
                id,
                name,
                timezoneName,
                timezoneOffset,
                platformAdditionalInfo: {}
            },
            returnMessage: { messageType: 'success', message: 'Successfully connected to ServiceNow.', ttl: 3000 }
        };
    } catch (error) {
        console.log('Exception in getUserInfo', error);
        return {
            successful: false,
            returnMessage: { messageType: 'warning', message: 'Failed to get user info.', ttl: 3000 }
        };
    }
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
    const removedUserId = user.id ?? user.dataValues?.id;
    await user.destroy();
    licenseHelper.clearLicenseCache(removedUserId);
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
            `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`,      // (800) 353-4676
            `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,        // 800-353-4676
            `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`,        // 800.353.4676
            `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`,   // +1 (800) 353-4676
            `+1-${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,     // +1-800-353-4676
            `(${d.slice(0, 3)})${d.slice(3, 6)}-${d.slice(6)}`,       // (800)353-4676
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

    apiLog.logStart('ServiceNow', 'findContact', { phoneNumber, isExtension });

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

    const companyData = await findCompany({ rcAccountId: user.rcAccountId, hostname });

    let states = [];
    let interactionType = [];
    try {
        const stateSelection = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=state&sysparm_fields=sys_id,label,value`,
            { headers: { 'Authorization': authHeader }, _operation: 'findContact' }
        );
        states = stateSelection.data.result.length > 0 ? stateSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : [];
    } catch (err) {
        console.log('sys_choice state lookup failed, continuing without state options:', err.response?.status);
    }
    try {
        const typeSelection = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=type&sysparm_fields=sys_id,label,value`,
            { headers: { 'Authorization': authHeader }, _operation: 'findContact' }
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
                headers: { 'Authorization': authHeader }, _operation: 'findContact'
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
                { headers: { 'Authorization': authHeader }, _operation: 'findContact' }
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
                { headers: { 'Authorization': authHeader }, _operation: 'findContact' }
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
    apiLog.logSuccess('ServiceNow', 'findContact', { phoneNumber, matchedCount: matchedContactInfo.length, apiEndpoint: `https://${hostname}/api/now/${contactTable}` });
    return {
        successful: true,
        matchedContactInfo
    };
}

async function findContactWithName({ user, authHeader, name }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceNow', 'findContactWithName', { name });

    const term = (name || '').trim();
    if (!term) {
        return { successful: true, matchedContactInfo: [] };
    }

    const userInfo = await getHostname(user.dataValues.hostname);
    const hostname = userInfo.hostname;

    const companyData = await findCompany({ rcAccountId: user.rcAccountId, hostname });
    const contactTable = (companyData?.contactTable?.trim().toLowerCase() == 'user') ? 'table/sys_user' : 'contact';

    // The call log form declares `state` and `type` as contactDependent selections, so every
    // contact returned here must carry the same option lists findContact attaches. Without them
    // the form renders empty dropdowns for a manually searched contact.
    let states = [];
    let interactionType = [];
    try {
        const stateSelection = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=state&sysparm_fields=sys_id,label,value`,
            { headers: { 'Authorization': authHeader }, _operation: 'findContactWithName' }
        );
        states = stateSelection.data.result.length > 0 ? stateSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : [];
    } catch (err) {
        console.log('sys_choice state lookup failed, continuing without state options:', err.response?.status);
    }
    try {
        const typeSelection = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=type&sysparm_fields=sys_id,label,value`,
            { headers: { 'Authorization': authHeader }, _operation: 'findContactWithName' }
        );
        interactionType = typeSelection.data.result.length > 0 ? typeSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : [];
    } catch (err) {
        console.log('sys_choice type lookup failed, continuing without type options:', err.response?.status);
    }

    // sys_user carries the display name on `name` and the login on `user_name`; the contact
    // table only has `name`. Search both on sys_user so either spelling matches.
    const nameQuery = contactTable == 'table/sys_user'
        ? `nameLIKE${term}^ORuser_nameLIKE${term}`
        : `nameLIKE${term}`;

    let results = [];
    try {
        const searchRes = await serviceNowApiClient.get(
            `https://${hostname}/api/now/${contactTable}?sysparm_query=${encodeURIComponent(nameQuery)}&sysparm_fields=sys_id,name,user_name,phone,mobile_phone,email&sysparm_limit=25`,
            { headers: { 'Authorization': authHeader }, _operation: 'findContactWithName' }
        );
        results = searchRes.data?.result || [];
    } catch (err) {
        // Degrade to an empty result instead of throwing — the framework surfaces a thrown
        // error as a generic "Contact search by name failed" with no way for the user to retry.
        console.warn('[ServiceNow] findContactWithName: search failed', err.response?.status || err.message);
        return { successful: true, matchedContactInfo: [] };
    }

    const matchedContactInfo = results.map((result) => {
        const additionalInfo = {};
        if (states.length > 0) {
            additionalInfo.state = states;
        }
        if (interactionType.length > 0) {
            additionalInfo.type = interactionType;
        }
        return {
            id: result.sys_id,
            name: (contactTable == 'table/sys_user') ? (result.name || result.user_name) : result.name,
            type: 'Contact',
            // The interface contract requires the same shape as findContact — including `phone`,
            // so a manually picked contact can still be reconciled with phone-based lookups.
            phone: result.phone || result.mobile_phone || '',
            email: result.email || '',
            additionalInfo
        };
    });

    apiLog.logSuccess('ServiceNow', 'findContactWithName', { name: term, matchedCount: matchedContactInfo.length, apiEndpoint: `https://${hostname}/api/now/${contactTable}` });
    return {
        successful: true,
        matchedContactInfo
    };
}

// Write the number this interaction actually came in on into the contact record's `phone`
// field. ServiceNow has no multi-value phone field, so the number is comma-appended to the
// existing value; a later lookup then matches it (findContact queries phoneLIKE / mobile_phone
// with a LIKE, so a comma-joined list still resolves). No-op unless the number is new to the
// contact, so repeat calls don't keep growing the field.
//
// The contact's stored number is NOT available on contactInfo — core builds contactInfo with
// phoneNumber set to the CALL's number, not the contact's — so we read it from the CRM by id.
async function appendContactNumberIfNew({ hostname, authHeader, contactTable, contactInfo, receivedNumber, logPrefix }) {
    if (!contactInfo?.id || !receivedNumber) return;

    // Here `contact` is only a scripted REST endpoint (api/now/contact), NOT a real Table-API
    // table — GET/PATCH on api/now/table/contact returns "Invalid table contact". Contacts in CSM
    // live in `customer_contact`, which EXTENDS sys_user, so the base `sys_user` table resolves the
    // same sys_id for both plain users and contacts, and phone/mobile_phone are sys_user fields.
    // So always address the record through the sys_user Table API.
    const recordUrl = `https://${hostname}/api/now/table/sys_user/${contactInfo.id}`;
    try {
        const current = await serviceNowApiClient.get(
            `${recordUrl}?sysparm_fields=phone,mobile_phone`,
            { headers: { 'Authorization': authHeader }, _operation: 'appendContactNumber' }
        );
        const result = current.data?.result || {};
        const existingPhone = (result.phone || '').toString().trim();
        // The stored number can live in phone (possibly comma-joined) or mobile_phone; check both
        // so we neither duplicate a number the record already has nor grow the field on repeats.
        const knownNumbers = [...existingPhone.split(','), (result.mobile_phone || '').toString()];
        if (!phoneWriteback.isNewNumberForContact(receivedNumber, knownNumbers)) return;
        const nextPhone = existingPhone ? `${existingPhone}, ${receivedNumber}` : String(receivedNumber);
        await serviceNowApiClient.patch(
            recordUrl,
            { phone: nextPhone },
            { headers: { 'Authorization': authHeader }, _operation: 'appendContactNumber' }
        );
        console.log(`${logPrefix} appended new number to contact:`, contactInfo.id);
    } catch (err) {
        console.warn(`${logPrefix} failed to append contact number:`, err?.response?.data || err.message);
    }
}

async function createCallLog({ user, contactInfo, authHeader, callLog, note, additionalSubmission, aiNote, transcript }) {
    // ------------------------------------
    // ---TODO.4: Implement call logging---
    // ------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceNow', 'createCallLog', { contactId: contactInfo?.id, direction: callLog?.direction, duration: callLog?.duration });

    let subject =
        (user.userSettings?.addCallLogSubject?.value ?? true)
            ? (callLog?.customSubject?.trim() || "")
            : "";

    let body = '';
    if (user.userSettings?.addCallLogNote?.value ?? true) { body = upsertCallAgentNote({ body, note }); }
    if (user.userSettings?.addCallLogContactNumber?.value ?? true) { body = upsertContactPhoneNumber({ body, phoneNumber: contactInfo.phoneNumber || contactInfo.phone, direction: callLog.direction }); }
    if (user.userSettings?.addCallLogResult?.value ?? true) { body = upsertCallResult({ body, result: callLog.result }); }
    if (user.userSettings?.addCallLogDuration?.value ?? true) { body = upsertCallDuration({ body, duration: callLog.duration }); }
    if (user.userSettings?.addCallSessionId?.value ?? true) { body = upsertCallSessionId({ body, sessionId: callLog.sessionId }); }
    const agentParty = callLog?.direction === 'Inbound' ? callLog?.to : callLog?.from;
    const rcNameFromLog = agentParty?.name;
    const effectiveRcUserName = rcNameFromLog || '';
    if (effectiveRcUserName && (user.userSettings?.addRingCentralUserName?.value ?? true)) { body = upsertRingCentralUserName({ body, rcUserName: effectiveRcUserName }); }
    const rcPhoneNumberFromLog = agentParty?.phoneNumber;
    const effectiveRcPhoneNumber = rcPhoneNumberFromLog || callLog?.extensionNumber;
    if (effectiveRcPhoneNumber && (user.userSettings?.addRingCentralNumber?.value ?? true)) { body = upsertRingCentralNumber({ body, rcPhoneNumber: effectiveRcPhoneNumber }); }
    if (user.userSettings?.addCallLogDateTime?.value ?? true) { body = upsertCallDateTime({ body, startTime: callLog.startTime, duration: callLog.duration, user }); }
    if (!!callLog.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) { body = upsertCallRecording({ body, recordingLink: callLog.recording.link }); }
    if (!!aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) { body = upsertAiNote({ body, aiNote }); }
    if (!!transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) { body = upsertTranscript({ body, transcript }); }

    const userInfo = await getHostname(user.dataValues.hostname);

    const companyData = await findCompany({ rcAccountId: user.rcAccountId, hostname: userInfo.hostname });
    const userDetailsPath = companyData?.userDetailsPath;

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

    const contactTable = (companyData?.contactTable == 'user') ? 'table/sys_user' : 'contact';

    const caller_id = await serviceNowApiClient.get(`https://${hostname}/api/${userDetailsPath}`, {
        headers: {
            'Authorization': authHeader
        },
        _operation: 'createCallLog'
    });

    // const workNotes = `\nContact Number: ${contactInfo.phoneNumber}\nCall Result: ${callLog.result}\nNote: ${note}${callLog.recording ? `\n[Call recording link] ${callLog.recording.link}` : ''}\n\n--- Created via RingCentral CRM Extension`;

    const callKeyParts = [
        callLog?.telephonySessionId,
        callLog?.sessionId,
        callLog?.id,
        callLog?.startTime
    ]
        .map((value) => (value ?? '').toString().trim())
        .filter(Boolean);

    // A session or record id is required. startTime alone is not distinctive enough to key
    // on, and hashing a partial key would make unrelated calls look like the same one.
    const hasCallIdentifier = [callLog?.telephonySessionId, callLog?.sessionId, callLog?.id]
        .some((value) => !!(value ?? '').toString().trim());

    // Stored in client_session_id: a stock Interaction Management string column (40 chars by
    // default, so 'rc_' + 32 hex fits), read only by the chat/Virtual Agent stack, which never
    // touches the interactions this connector creates. It replaces correlation_id, which does
    // not exist on interaction — that table is a base table and does not extend task.
    const uniqueCallId = hasCallIdentifier
        ? `rc_${crypto.createHash('sha1').update(callKeyParts.join('|')).digest('hex').slice(0, 32)}`
        : '';
    if (uniqueCallId) {
        const existing = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/interaction?sysparm_query=${encodeURIComponent(`client_session_id=${uniqueCallId}`)}&sysparm_fields=sys_id,client_session_id&sysparm_limit=1`,
            { headers: { 'Authorization': authHeader }, _operation: 'createCallLog' }
        );
        const existingLog = existing.data?.result?.[0];
        // Verify the key on the returned record instead of trusting the query filter.
        // ServiceNow drops a condition naming a column the table does not have rather than
        // erroring, so such a query silently widens to match everything. Comparing the value
        // back means an instance without client_session_id disables dedup instead of matching
        // the wrong record — which is exactly how the previous correlation_id version failed.
        if (existingLog && (existingLog.client_session_id || '').toString().trim() === uniqueCallId) {
            apiLog.logSuccess('ServiceNow', 'createCallLog', { logId: existingLog.sys_id, contactId: contactInfo?.id, deduped: true, apiEndpoint: `https://${hostname}/api/now/table/interaction` });
            return {
                logId: existingLog.sys_id,
                returnMessage: { message: 'Call log already exists.', messageType: 'warning', ttl: 3000 }
            };
        }
    }

    const postBody = {
        short_description: subject,
        work_notes: body,
        ...(uniqueCallId && { client_session_id: uniqueCallId })
    }
    if (callLog?.startTime) {
        postBody.opened_at = callLog.startTime;
    }

    postBody.u_call_duration = formatDuration(callLog.duration);
    postBody.u_call_result = callLog.result;

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
            headers: { 'Authorization': authHeader }, _operation: 'createCallLog'
        }
    );

    if (callLog?.recording?.downloadUrl) {
        const timestamp = moment().format("DD-MM-YYYY_HH_MM_SS");
        const fileName = `downloaded_audio_${timestamp}`;
        const s3Key = `${fileName}.mp3`;
        const s3Url = await downloadAudioFile(callLog?.recording?.downloadUrl, process.env.S3_BUCKET, s3Key);
        await uploadToServiceNow(s3Url, hostname, authHeader, addLogRes?.data?.result?.sys_id, fileName);
    }

    //----------------------------------------------------------------------------
    //---CHECK.4: Open db.sqlite and CRM website to check if call log is saved ---
    //----------------------------------------------------------------------------
    // Write the number this call came in on into the CRM contact so a later lookup of it resolves
    // to this contact (findContactWithName never receives a phone number, so the manually picked
    // contact wouldn't otherwise own the number that was called).
    const receivedNumber = phoneWriteback.resolveCounterpartyNumber({ callLog });
    await appendContactNumberIfNew({ hostname, authHeader, contactTable, contactInfo, receivedNumber, logPrefix: '[ServiceNow] createCallLog:' });

    apiLog.logSuccess('ServiceNow', 'createCallLog', { logId: addLogRes.data.result.sys_id, contactId: contactInfo?.id, apiEndpoint: `https://${hostname}/api/now/table/interaction` });
    await trackAnalytics({ user, crm: 'ServiceNow', event: 'callLogCreated' });
    return {
        logId: addLogRes.data.result.sys_id,
        returnMessage: {
            message: 'Call log added.',
            messageType: 'success',
            ttl: 3000
        }
    };
}

// The edit form sends state/type through a SEPARATE /callDisposition request (not /callLog), so
// this — not updateCallLog — is where a changed disposition gets written to the interaction. Core
// passes them as `dispositions` ({ state, type, note }).
//
// Only `state` is patched: the interaction's Type is locked read-only by a ServiceNow Data Policy
// after creation (PATCHing it returns 403 "The following fields are read only: Type"), and because
// the request always echoes the current type, including it would fail the whole PATCH and drop the
// state change too. Type is therefore set once at create time only.
async function upsertCallDisposition({ user, existingCallLog, authHeader, dispositions }) {
    const existingLogId = existingCallLog.thirdPartyLogId;
    if (!existingLogId || !dispositions?.state) {
        return { logId: existingLogId };
    }

    const userInfo = await getHostname(user.dataValues.hostname);
    const hostname = userInfo.hostname;

    const returnedState = await findStateValueById(hostname, authHeader, dispositions.state);
    const patchBody = { state: returnedState ?? await findStateValueByName(hostname, authHeader, dispositions.state) };
    applyClosedDatesIfNeeded(patchBody, patchBody.state, null);

    await serviceNowApiClient.patch(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        patchBody,
        { headers: { Authorization: authHeader }, _operation: 'upsertCallDisposition' }
    );

    return {
        logId: existingLogId,
        returnMessage: { message: 'Disposition updated.', messageType: 'success', ttl: 2000 }
    };
}

// The agent note is what people read first, so it is pinned to the TOP of the body: any existing
// block is stripped and re-inserted at the front. That also lifts notes back up on logs written
// before this rule existed, where adding a note to an already-populated body appended it last.
//
// `note` distinguishes two cases that used to be conflated:
//   null/undefined -> not submitted (e.g. a recording- or transcript-only update). Leave as is.
//   '' (empty)     -> the user CLEARED the field. The block must be removed, not preserved.
// The old `if (!!!note) return body` treated both as "leave as is", so clearing a note silently
// kept the previous text.
function upsertCallAgentNote({ body, note }) {
    if (note == null) {
        return body;
    }
    // Drop the existing block wherever it currently sits — top, middle or bottom.
    const noteRegex = RegExp('\\n?- Agent Note:\\n[\\s\\S]*?\\n\\n');
    const rest = body.replace(noteRegex, '').replace(/^\n+/, '');
    const trimmedNote = note.toString().trim();
    if (!trimmedNote) {
        return rest;
    }
    // Labeled block like the AI Note, with a blank line below separating it from the fields.
    return `- Agent Note:\n${trimmedNote}\n\n${rest}`;
}

function upsertContactPhoneNumber({ body, phoneNumber, direction }) {
    if (!!!phoneNumber) {
        return body;
    }
    const phoneNumberRegex = RegExp('- Contact Number: (.+?)\n');
    if (phoneNumberRegex.test(body)) {
        body = body.replace(phoneNumberRegex, `- Contact Number: ${phoneNumber}\n`);
    } else {
        body += `- Contact Number: ${phoneNumber}\n`;
    }
    return body;
}

function upsertCallResult({ body, result }) {
    if (!!!result) {
        return body;
    }
    const resultRegex = RegExp('- Result: (.+?)\n');
    if (resultRegex.test(body)) {
        body = body.replace(resultRegex, `- Result: ${result}\n`);
    } else {
        body += `- Result: ${result}\n`;
    }
    return body;
}

function upsertCallDuration({ body, duration }) {
    if (duration == null || duration === '') {
        return body;
    }
    const durationRegex = RegExp('- Duration: (.+?)\n');
    if (durationRegex.test(body)) {
        body = body.replace(durationRegex, `- Duration: ${secondsToHoursMinutesSeconds(duration)}\n`);
    } else {
        body += `- Duration: ${secondsToHoursMinutesSeconds(duration)}\n`;
    }
    return body;
}

function upsertCallSessionId({ body, sessionId }) {
    if (!!!sessionId) {
        return body;
    }
    const sessionIdRegex = RegExp('- Call Session ID: (.+?)\n');
    if (sessionIdRegex.test(body)) {
        body = body.replace(sessionIdRegex, `- Call Session ID: ${sessionId}\n`);
    } else {
        body += `- Call Session ID: ${sessionId}\n`;
    }
    return body;
}

function upsertRingCentralUserName({ body, rcUserName }) {
    if (!!!rcUserName) {
        return body;
    }
    const rcUserNameRegex = RegExp('- RingCentral Username: (.+?)\n');
    if (rcUserNameRegex.test(body)) {
        body = body.replace(rcUserNameRegex, `- RingCentral Username: ${rcUserName}\n`);
    } else {
        body += `- RingCentral Username: ${rcUserName}\n`;
    }
    return body;
}

function upsertRingCentralNumber({ body, rcPhoneNumber }) {
    if (!!!rcPhoneNumber) {
        return body;
    }
    const rcPhoneNumberRegex = RegExp('- RingCentral Phone Number: (.+?)\n');
    if (rcPhoneNumberRegex.test(body)) {
        body = body.replace(rcPhoneNumberRegex, `- RingCentral Phone Number: ${rcPhoneNumber}\n`);
    } else {
        body += `- RingCentral Phone Number: ${rcPhoneNumber}\n`;
    }
    return body;
}

function upsertCallDateTime({ body, startTime, duration, user }) {
    if (!!!startTime) {
        return body;
    }
    const formattedStartTime = formatDateTime({ user, time: startTime });
    const startTimeRegex = RegExp('- Start Time: (.+?)\n');
    if (startTimeRegex.test(body)) {
        body = body.replace(startTimeRegex, `- Start Time: ${formattedStartTime}\n`);
    } else {
        // Leading blank line so the date/time block is visually separated from the fields above
        // (the previous field already ends with \n, so \n here yields exactly one blank line).
        body += `\n- Start Time: ${formattedStartTime}\n`;
    }

    if (duration != null && duration !== '') {
        const formattedEndTime = formatDateTime({ user, time: moment(startTime).add(duration, "seconds") });
        const endTimeRegex = RegExp('- End Time: (.+?)\n');
        if (endTimeRegex.test(body)) {
            body = body.replace(endTimeRegex, `- End Time: ${formattedEndTime}\n`);
        } else {
            body += `- End Time: ${formattedEndTime}\n`;
        }
    }
    return body;
}

function upsertCallRecording({ body, recordingLink }) {
    const recordingLinkRegex = RegExp('- Call recording link: (.+?)\n');
    if (!!recordingLink && recordingLinkRegex.test(body)) {
        body = body.replace(recordingLinkRegex, `- Call recording link: ${recordingLink}\n`);
    } else if (!!recordingLink) {
        body += `\n- Call recording link: ${recordingLink}\n`;
    }
    return body;
}

function upsertAiNote({ body, aiNote }) {
    const aiNoteRegex = RegExp('- AI Note:([\\s\\S]*?)--- END');
    // Strip markdown bold markers (**) that RC adds, and trailing blank lines.
    const clearedAiNote = aiNote.replace(/\*+/g, '').replace(/\n+$/, '');
    if (aiNoteRegex.test(body)) {
        body = body.replace(aiNoteRegex, `- AI Note:\n${clearedAiNote}\n\n--- END`);
    } else {
        body += `\n- AI Note:\n${clearedAiNote}\n\n--- END\n`;
    }
    return body;
}

function upsertTranscript({ body, transcript }) {
    const transcriptRegex = RegExp('- Transcript:([\\s\\S]*?)--- END');
    if (transcriptRegex.test(body)) {
        body = body.replace(transcriptRegex, `- Transcript:\n${transcript}\n\n--- END`);
    } else {
        body += `\n- Transcript:\n${transcript}\n\n--- END\n`;
    }
    return body;
}

// work_notes is a JOURNAL field, not a column: every PATCH of interaction.work_notes appends a
// NEW row to sys_journal_field, and the Table API GET on interaction returns the field empty.
// So the current body has to be read back from sys_journal_field — newest entry first.
async function getLatestWorkNote({ hostname, authHeader, recordId, operation }) {
    const journalRes = await serviceNowApiClient.get(
        `https://${hostname}/api/now/table/sys_journal_field?sysparm_query=element_id=${recordId}^element=work_notes^ORDERBYDESCsys_created_on&sysparm_fields=sys_id,value,sys_created_on`,
        { headers: { Authorization: authHeader }, _operation: operation }
    );
    const latest = (journalRes.data?.result ?? [])
        .sort((a, b) => new Date(b.sys_created_on) - new Date(a.sys_created_on))[0];
    return { sysId: latest?.sys_id ?? null, value: latest?.value ?? '' };
}

// The form does NOT render work notes from sys_journal_field. The Activity formatter reads
// sys_history_line — a denormalized cache built on demand and keyed by a sys_history_set row —
// which materializes a COPY of the journal text when the entry is first written. So editing the
// journal entry updates the data (getCallLog reads it back correctly) while the record keeps
// displaying the pre-edit note. Dropping the history set makes ServiceNow rebuild it from source
// on the next view, which picks up the edit.
// Best-effort by design: the connector user may lack delete rights on sys_history_set, and a stale
// display cache is a cosmetic problem, not a data one — never fail a log update over it.
async function invalidateHistorySet({ hostname, authHeader, recordId, operation }) {
    try {
        const setRes = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/sys_history_set?sysparm_query=id=${recordId}&sysparm_fields=sys_id`,
            { headers: { Authorization: authHeader }, _operation: operation }
        );
        for (const historySet of setRes.data?.result ?? []) {
            await serviceNowApiClient.delete(
                `https://${hostname}/api/now/table/sys_history_set/${historySet.sys_id}`,
                { headers: { Authorization: authHeader }, _operation: operation }
            );
        }
    } catch (e) {
        console.warn(`[ServiceNow] ${operation}: could not invalidate the activity cache for ${recordId} (status ${e?.response?.status ?? 'n/a'}) — the edited work note may keep showing its previous text on the form until ServiceNow rebuilds the cache itself.`);
    }
}

// Write the log body by EDITING the existing journal entry in place rather than appending another
// one — sys_journal_field is a normal table, so the entry can be PATCHed by sys_id. Editing a log
// used to leave a trail of near-identical work notes; now it rewrites the single one.
// Falls back to the appending PATCH on interaction.work_notes when there is no entry yet (first
// write), or when the instance has not granted write access on sys_journal_field: a missing ACL
// has to degrade to a duplicate note, never to a lost log.
async function writeWorkNote({ hostname, authHeader, recordId, journalSysId, body, operation }) {
    if (journalSysId) {
        try {
            await serviceNowApiClient.patch(
                `https://${hostname}/api/now/table/sys_journal_field/${journalSysId}`,
                { value: body },
                { headers: { Authorization: authHeader }, _operation: operation }
            );
            await invalidateHistorySet({ hostname, authHeader, recordId, operation });
            return { updatedInPlace: true };
        } catch (e) {
            const status = e?.response?.status ?? null;
            // Only an access/existence problem is recoverable by appending; anything else is a real
            // failure and must surface.
            if (![401, 403, 404].includes(status)) { throw e; }
            console.warn(`[ServiceNow] ${operation}: cannot edit journal entry ${journalSysId} (status ${status}) — appending a new work note instead. Grant write access on sys_journal_field to update notes in place.`);
        }
    }
    await serviceNowApiClient.patch(
        `https://${hostname}/api/now/table/interaction/${recordId}`,
        { work_notes: body },
        { headers: { Authorization: authHeader }, _operation: operation }
    );
    return { updatedInPlace: false };
}

async function getCallLog({ user, callLogId, authHeader }) {
    // -----------------------------------------
    // ---TODO.5: Implement call log fetching---
    // -----------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceNow', 'getCallLog', { logId: callLogId });

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;

    const getLogRes = await serviceNowApiClient.get(
        `https://${hostname}/api/now/table/interaction/${callLogId}`,
        {
            headers: { 'Authorization': authHeader }, _operation: 'getCallLog'
        });

    const { value: latestNote } = await getLatestWorkNote({ hostname, authHeader, recordId: callLogId, operation: 'getCallLog' });
    const agentNoteMatch = latestNote.match(/- Agent note:\s*([\s\S]*?)(?=\n- |$)/i);
    const agentNote = agentNoteMatch ? agentNoteMatch[1].trim() : '';

    //-------------------------------------------------------------------------------------
    //---CHECK.5: In extension, for a logged call, click edit to see if info is fetched ---
    //-------------------------------------------------------------------------------------
    apiLog.logSuccess('ServiceNow', 'getCallLog', { logId: callLogId, apiEndpoint: `https://${hostname}/api/now/table/interaction/${callLogId}` });
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

async function updateCallLog({ user, existingCallLog, authHeader, recordingLink, recordingDownloadLink, subject, note, startTime, duration, result, aiNote, transcript, additionalSubmission }) {
    // ---------------------------------------
    // ---TODO.6: Implement call log update---
    // ---------------------------------------
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    apiLog.logStart('ServiceNow', 'updateCallLog', { logId: existingCallLog?.thirdPartyLogId, duration });

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;

    const existingLogId = existingCallLog.thirdPartyLogId;
    const getLogRes = await serviceNowApiClient.get(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        {
            headers: { 'Authorization': authHeader }, _operation: 'updateCallLog'
        });
    // Read the latest journal entry (the full note body written at create/last edit). Its sys_id is
    // what lets the update rewrite that same entry instead of appending a second one.
    // Without the body, originalNote is '' and it gets rebuilt from scratch, which drops the
    // Contact Number and RingCentral Username and makes the phone fall back to the extension.
    const { sysId: journalSysId, value: originalNote } = await getLatestWorkNote({ hostname, authHeader, recordId: existingLogId, operation: 'updateCallLog' });
    const originalSubject = getLogRes?.data?.result?.short_description || '';
    let patchBody = {};

    let subjectToUse = originalSubject || "";

    if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
        subjectToUse = subject.trim();
    }

    let logBody = originalNote;
    // `note != null` not `!!note`: an empty string is a real edit (the user cleared the field) and
    // has to reach upsertCallAgentNote so the block gets removed. Only an absent note is skipped.
    if (note != null && (user.userSettings?.addCallLogNote?.value ?? true)) { logBody = upsertCallAgentNote({ body: logBody, note }); }
    if (!!duration && (user.userSettings?.addCallLogDuration?.value ?? true)) { logBody = upsertCallDuration({ body: logBody, duration }); }
    if (!!result && (user.userSettings?.addCallLogResult?.value ?? true)) { logBody = upsertCallResult({ body: logBody, result }); }
    if (existingCallLog?.sessionId && (user.userSettings?.addCallSessionId?.value ?? true)) { logBody = upsertCallSessionId({ body: logBody, sessionId: existingCallLog.sessionId }); }
    const agentParty = existingCallLog?.direction === 'Inbound' ? existingCallLog?.to : existingCallLog?.from;
    const rcNameFromLog = agentParty?.name;
    const effectiveRcUserName = rcNameFromLog || '';
    if (effectiveRcUserName && (user.userSettings?.addRingCentralUserName?.value ?? true)) { logBody = upsertRingCentralUserName({ body: logBody, rcUserName: effectiveRcUserName }); }
    const existingRcPhoneNumber = originalNote.match(/- RingCentral Phone Number: (.+?)\n/)?.[1]?.trim();
    const rcPhoneNumberFromLog = agentParty?.phoneNumber;
    const effectiveRcPhoneNumber = rcPhoneNumberFromLog || existingRcPhoneNumber || existingCallLog?.extensionNumber;
    if (effectiveRcPhoneNumber && (user.userSettings?.addRingCentralNumber?.value ?? true)) { logBody = upsertRingCentralNumber({ body: logBody, rcPhoneNumber: effectiveRcPhoneNumber }); }
    if (!!startTime && (user.userSettings?.addCallLogDateTime?.value ?? true)) { logBody = upsertCallDateTime({ body: logBody, startTime, duration, user }); }
    if (!!recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) { logBody = upsertCallRecording({ body: logBody, recordingLink: decodeURIComponent(recordingLink) }); }
    if (!!aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) { logBody = upsertAiNote({ body: logBody, aiNote }); }
    if (!!transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) { logBody = upsertTranscript({ body: logBody, transcript }); }

    // work_notes is deliberately NOT in this patch — it goes through writeWorkNote, which edits the
    // existing journal entry instead of appending a new one.
    patchBody = {
        short_description: subjectToUse
    }

    patchBody.u_call_duration = formatDuration(duration);
    patchBody.u_call_result = result;

    const patchLog = await serviceNowApiClient.patch(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        patchBody,
        {
            headers: { 'Authorization': authHeader }, _operation: 'updateCallLog'
        }
    );

    await writeWorkNote({ hostname, authHeader, recordId: existingLogId, journalSysId, body: logBody, operation: 'updateCallLog' });

    if (recordingDownloadLink) {
        console.log("Downloading Recorded File...");
        const timestamp = moment().format("DD-MM-YYYY_HH_MM_SS");
        const fileName = `downloaded_audio_${timestamp}`;
        const s3Key = `${fileName}.mp3`;
        const s3Url = await downloadAudioFile(recordingDownloadLink, process.env.S3_BUCKET, s3Key);
        await uploadToServiceNow(s3Url, hostname, authHeader, existingLogId, fileName)
    }

    const patchLogRes = {
        data: {
            id: patchLog.data.result.sys_id
        }
    }

    //-----------------------------------------------------------------------------------------
    //---CHECK.6: In extension, for a logged call, click edit to see if info can be updated ---
    //-----------------------------------------------------------------------------------------
    apiLog.logSuccess('ServiceNow', 'updateCallLog', { logId: existingLogId, apiEndpoint: `https://${hostname}/api/now/table/interaction/${existingLogId}` });

    await trackAnalytics({ user, crm: 'ServiceNow', event: 'callLogUpdated' });

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

    apiLog.logStart('ServiceNow', 'createMessageLog', { contactId: contactInfo?.id, direction: message?.direction });

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;

    const messageLogCompany = await findCompany({ rcAccountId: user.rcAccountId, hostname });
    const userDetailsPath = messageLogCompany?.userDetailsPath;

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
        },
        _operation: 'createMessageLog'
    });

    // detect message type (SMS / Voicemail / Fax)
    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    // Same response that supplies assigned_to below also carries the agent's name fields.
    const workNotes = buildMessageLogBody({ user, message, contactInfo, messageType, recordingLink, faxDocLink, agentName: pickAgentName(caller_id.data?.result) });

    const postBody = {
        short_description: `[${messageType}] ${message.direction} ${messageType} - ${contactInfo.name}`,
        work_notes: workNotes,
        assigned_to: caller_id.data.result.id,
        opened_for: contactInfo.id
    };

    if (message?.startTime) {
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
            headers: { 'Authorization': authHeader }, _operation: 'createMessageLog'
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

    //-------------------------------------------------------------------------------------------------------------
    //---CHECK.7: For single message logging, open db.sqlite and CRM website to check if message logs are saved ---
    //-------------------------------------------------------------------------------------------------------------
    apiLog.logSuccess('ServiceNow', 'createMessageLog', { logId: addLogRes.data.result.sys_id, contactId: contactInfo?.id, apiEndpoint: `https://${hostname}/api/now/table/interaction` });

    // Same write-back as createCallLog: append the number this message came in on to the CRM contact.
    const contactTable = (messageLogCompany?.contactTable == 'user') ? 'table/sys_user' : 'contact';
    const receivedNumber = phoneWriteback.resolveCounterpartyNumber({ message });
    await appendContactNumberIfNew({ hostname, authHeader, contactTable, contactInfo, receivedNumber, logPrefix: '[ServiceNow] createMessageLog:' });

    await trackAnalytics({ user, crm: 'ServiceNow', event: 'messageLogCreated' });

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

    apiLog.logStart('ServiceNow', 'updateMessageLog', { contactId: contactInfo?.id, logId: existingMessageLog?.thirdPartyLogId, direction: message?.direction });

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

    // Every appended line names its sender, so the agent has to be resolved here too — via the same
    // userDetailsPath lookup createMessageLog uses for assigned_to. Unlike create, a missing path is
    // NOT fatal here: the message still logs, the outbound line just reads "You".
    const messageLogCompany = await findCompany({ rcAccountId: user.rcAccountId, hostname });
    const agentName = await fetchAgentName({ hostname, authHeader, userDetailsPath: messageLogCompany?.userDetailsPath, operation: 'updateMessageLog' });

    // Read the running conversation from sys_journal_field, not from the interaction record — the
    // Table API GET returns the journal field empty, so reading it there yielded '' every time and
    // every message restarted the thread in a brand-new work note.
    const { sysId: journalSysId, value: originalNote } = await getLatestWorkNote({ hostname, authHeader, recordId: existingLogId, operation: 'updateMessageLog' });

    // detect message type
    const messageType = recordingLink ? 'Voicemail' : (faxDocLink ? 'Fax' : 'SMS');

    // Same append flow as before — just Monday-style formatting. Only add the "SMS
    // conversation with…" header when starting a fresh note; otherwise append the line.
    const updatedText = buildMessageLogBody({ user, message, contactInfo, messageType, recordingLink, faxDocLink, includeHeader: !originalNote, agentName });

    const updatedWorkNotes = originalNote ? `${originalNote}\n${updatedText}` : updatedText;

    // work_notes goes through writeWorkNote so the thread keeps growing inside the one entry.
    const patchBody = {
        short_description: `[${messageType}] ${message.direction} ${messageType} - ${existingMessageLog.contactName ?? ''}`
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
            headers: { 'Authorization': authHeader }, _operation: 'updateMessageLog'
        });

    await writeWorkNote({ hostname, authHeader, recordId: existingLogId, journalSysId, body: updatedWorkNotes, operation: 'updateMessageLog' });

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

    //---------------------------------------------------------------------------------------------------------------------------------------------
    //---CHECK.8: For multiple messages or additional message during the day, open db.sqlite and CRM website to check if message logs are saved ---
    //---------------------------------------------------------------------------------------------------------------------------------------------
    apiLog.logSuccess('ServiceNow', 'updateMessageLog', { logId: existingLogId, contactId: contactInfo?.id, apiEndpoint: `https://${hostname}/api/now/table/interaction/${existingLogId}` });

    await trackAnalytics({ user, crm: 'ServiceNow', event: 'messageLogUpdated' });

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

    apiLog.logStart('ServiceNow', 'createContact', { phoneNumber, newContactType });

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;

    const companyData = await findCompany({ rcAccountId: user.rcAccountId, hostname });

    const postBody = {
        phone: phoneNumber,
        type: newContactType,
        // account: account.data.result[0].sys_id
    }

    let contactInfoRes;
    let createContactEndpoint;
    const isExtensionNumber = phoneNumber.toString().length <= 8 && phoneNumber.toString().length >= 3;

    if (companyData?.contactTable == 'contact' && !isExtensionNumber) {
        const selectedAccountId = (additionalSubmission?.account || '').trim();

        if (selectedAccountId) {
            postBody.account = selectedAccountId;
        } else {
            const account = await serviceNowApiClient.get(
                `https://${hostname}/api/now/account?sysparm_limit=1`,
                { headers: { Authorization: authHeader }, _operation: 'createContact' }
            );
            const fallbackAccountId = account?.data?.result?.[0]?.sys_id;
            if (fallbackAccountId) {
                postBody.account = fallbackAccountId;
            }
        }

        postBody.name = newContactName;
        createContactEndpoint = `https://${hostname}/api/now/contact`;
        contactInfoRes = await serviceNowApiClient.post(
            createContactEndpoint,
            postBody,
            {
                headers: { 'Authorization': authHeader }, _operation: 'createContact'
            }
        );
    } else {
        postBody.user_name = newContactName?.toLowerCase();
        createContactEndpoint = `https://${hostname}/api/now/table/sys_user`;
        contactInfoRes = await serviceNowApiClient.post(
            createContactEndpoint,
            postBody,
            {
                headers: { 'Authorization': authHeader }, _operation: 'createContact'
            }
        );
    }

    //--------------------------------------------------------------------------------
    //---CHECK.9: In extension, try create a new contact against an unknown number ---
    //--------------------------------------------------------------------------------
    apiLog.logSuccess('ServiceNow', 'createContact', { contactId: contactInfoRes.id, apiEndpoint: createContactEndpoint });

    await trackAnalytics({ user, crm: 'ServiceNow', event: 'contactCreated' });

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
            _operation: 'downloadAudioFile',
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
            _operation: 'uploadToServiceNow',
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
exports.findContactWithName = findContactWithName;
exports.createContact = createContact;
exports.unAuthorize = unAuthorize;
exports.upsertCallDisposition = upsertCallDisposition;
exports.getLicenseStatus = getLicenseStatus
export { };
