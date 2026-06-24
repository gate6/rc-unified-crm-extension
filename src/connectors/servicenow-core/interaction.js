const axios = require('axios');
const moment = require('moment');
const apiLog = require('../shared/apiLogger');
const serviceNowApiClient = axios.create();

apiLog.installErrorInterceptor(serviceNowApiClient, 'ServiceNow');

const stateMapping = {
    // "wrap up": "wrap_up",
    "new": "new",
    "closed complete": "closed_complete",
    "on hold": "on_hold",
    "closed abandoned": "closed_abandoned",
    "work in progress": "work_in_progress"
};

const typeMapping = {
    "messaging": "messaging",
    "phone": "phone",
    "video": "video",
    "chat": "chat"
};

const stateRegexPatterns = [
    { regex: /^new$/i, value: 'new' },
    { regex: /^on\s*hold$/i, value: 'on_hold' },
    { regex: /^(work|wrk)\s*in\s*progress$/i, value: 'work_in_progress' },
    { regex: /^(closed?\s*)?ab(an)?don(ed)?$/i, value: 'closed_abandoned' },
    { regex: /^(closed?\s*)?comp(lete|leted)?$/i, value: 'closed_complete' }
];

const typeRegexPatterns = [
    { regex: /^mess(?:\s*|e)*aging$/i, value: 'messaging' },
    { regex: /^chat(?:ting)?$/i, value: 'chat' },
    { regex: /^phone$/i, value: 'phone' },
    { regex: /^video$/i, value: 'video' }
];

function collapseLabel(value = '') {
    return value.toLowerCase().replace(/\s+/g, '');
}

async function fetchChoices(hostname, authHeader, element) {
    const response = await serviceNowApiClient.get(
        `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=${element}&sysparm_fields=label,value&sysparm_limit=500`,
        {
            headers: { 'Authorization': authHeader }, _operation: 'fetchChoices'
        }
    );

    return response.data?.result || [];
}

async function findChoiceValue(hostname, authHeader, element, inputValue) {
    const trimmedInput = (inputValue || '').trim();
    if (!trimmedInput) {
        return null;
    }

    const collapsedInput = collapseLabel(trimmedInput);
    const choices = await fetchChoices(hostname, authHeader, element);

    for (const choice of choices) {
        const collapsedChoice = collapseLabel(choice.label);
        if (collapsedChoice === collapsedInput) {
            return choice.value;
        }
    }

    return null;
}

function matchByRegex(inputValue, patterns) {
    if (!inputValue) { return null; }
    for (const pattern of patterns) {
        if (pattern.regex.test(inputValue)) {
            return pattern.value;
        }
    }
    return null;
}

async function findStateValueByName(hostname, authHeader, inputValue){
    
    try {
        console.log("findStateValueByName called with inputValue:", inputValue);
        const sanitizedInputValue = (inputValue || '').trim();
        const normalizedLookupKey = sanitizedInputValue.toLowerCase();

        if (!sanitizedInputValue) {
            console.log("Invalid state value provided.");
            return null;
        }

        const collapsedMatchValue = await findChoiceValue(hostname, authHeader, 'state', sanitizedInputValue);
        if (collapsedMatchValue) {
            return collapsedMatchValue;
        }

        const normalizedValue = stateMapping[normalizedLookupKey] || null;
        const regexValue = matchByRegex(sanitizedInputValue, stateRegexPatterns);

        if (normalizedValue) {
            return normalizedValue;
        } else if (regexValue) {
            return regexValue;
        } else {
            return null;
        }
    } catch (error) {
        console.log("Error in findStateValueByName:", error);
        return null;
    }
    
} 

async function findStateValueById(hostname, authHeader, inputId){

    try {
        console.log("findStateValueById called with inputId:", inputId);
        if (!inputId) {
            console.log("Invalid state id provided.");
        }
        
        const stateSelection = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=state^sys_id=${inputId}&sysparm_fields=sys_id,label,value`,
            {
                headers: { 'Authorization':  authHeader }, _operation: 'findStateValueById'
            });
        
        if (stateSelection.data && stateSelection.data.result && stateSelection.data.result.length > 0) {
            return stateSelection.data.result[0].value;
        } else {
            return null;
        }
    } catch (error) {
        console.log("Error in findStateValueById:", error);
        return null;
    }
} 

async function findTypeValueByName(hostname, authHeader, inputValue) {
    
    try {
        console.log("findTypeValueByName called with inputValue:", inputValue);
        const sanitizedInputValue = (inputValue || '').trim();
        const normalizedLookupKey = sanitizedInputValue.toLowerCase();

        if (!sanitizedInputValue) {
            console.log("Invalid type value provided.");
            return null;
        }

        const collapsedMatchValue = await findChoiceValue(hostname, authHeader, 'type', sanitizedInputValue);
        if (collapsedMatchValue) {
            return collapsedMatchValue;
        }

        const normalizedValue = typeMapping[normalizedLookupKey] || null;
        const regexValue = matchByRegex(sanitizedInputValue, typeRegexPatterns);

        if (normalizedValue) {
            return normalizedValue;
        } else if (regexValue) {
            return regexValue;
        } else {
            return null;
        }
    } catch (error) {
        console.log("Error in findTypeValueByName:", error);
        return null;
    }
    
}

async function findTypeValueById(hostname, authHeader, inputId) {
    
    try {
        if (!inputId) {
            console.log("Invalid type id provided.");
        }
        
        const typeSelection = await serviceNowApiClient.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=type^sys_id=${inputId}&sysparm_fields=sys_id,label,value`,
            {
                headers: { 'Authorization': authHeader }, _operation: 'findTypeValueById'
            });
        
        if (typeSelection.data && typeSelection.data.result && typeSelection.data.result.length > 0) {
            return typeSelection.data.result[0].value;
        } else {
            return null;
        }
    } catch (error) {
        console.log("Error in findTypeValueById:", error);
        return null;
    }
    
}

const accountCache = new Map(); // key: hostname, value: { data, expiresAt }
const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getAllAccounts(hostname, authHeader) {
    const cached = accountCache.get(hostname);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.data;
    }
    try {
        const response = await serviceNowApiClient.get(
            `https://${hostname}/api/now/account?sysparm_limit=1000`,
            { headers: { Authorization: authHeader }, _operation: 'getAllAccounts' }
        );
        const data = response.data?.result || [];
        accountCache.set(hostname, { data, expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS });
        return data;
    } catch (error) {
        console.log('Error fetching accounts:', error);
        return cached?.data || []; // return stale data if available
    }
}

function isClosedInteractionState(stateValue) {
    const normalized = (stateValue || '').toString().trim().toLowerCase();
    return normalized === 'closed_complete' || normalized === 'closed_abandoned';
}

function toServiceNowUtcDateTime(valueMs) {
    const numericMs = Number(valueMs);
    if (!Number.isFinite(numericMs) || numericMs <= 0) {
        return moment.utc().format('YYYY-MM-DD HH:mm:ss');
    }
    return moment.utc(numericMs).format('YYYY-MM-DD HH:mm:ss');
}

function applyClosedDatesIfNeeded(payload, stateValue, callLog) {
    if (!isClosedInteractionState(stateValue)) {
        return;
    }

    const startTimeMs = Number(callLog?.startTime);
    const durationMs = Number(callLog?.durationMs);
    const durationSec = Number(callLog?.duration);
    const computedDurationMs = Number.isFinite(durationMs) && durationMs > 0
        ? durationMs
        : (Number.isFinite(durationSec) && durationSec > 0 ? durationSec * 1000 : 1000);

    if (Number.isFinite(startTimeMs) && startTimeMs > 0) {
        if (!payload.opened_at) {
            payload.opened_at = toServiceNowUtcDateTime(startTimeMs);
        }
        if (!payload.closed_at) {
            payload.closed_at = toServiceNowUtcDateTime(startTimeMs + computedDurationMs);
        }
        return;
    }

    const nowMs = Date.now();
    if (!payload.opened_at) {
        payload.opened_at = toServiceNowUtcDateTime(nowMs - 1000);
    }
    if (!payload.closed_at) {
        payload.closed_at = toServiceNowUtcDateTime(nowMs);
    }
}

function formatDuration(seconds) {
    seconds = Number(seconds);

    if (seconds < 60) {
        return `${seconds} Second${seconds !== 1 ? 's' : ''}`;
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    let result = '';

    if (hours > 0) {
        result += `${hours} Hour${hours !== 1 ? 's' : ''} `;
    }

    if (minutes > 0) {
        result += `${minutes} Minute${minutes !== 1 ? 's' : ''} `;
    }

    if (remainingSeconds > 0) {
        result += `${remainingSeconds} Second${remainingSeconds !== 1 ? 's' : ''}`;
    }

    return result.trim();
}

exports.findStateValueByName = findStateValueByName;
exports.findStateValueById = findStateValueById;
exports.findTypeValueByName = findTypeValueByName;
exports.findTypeValueById = findTypeValueById;
exports.getAllAccounts = getAllAccounts;
exports.applyClosedDatesIfNeeded = applyClosedDatesIfNeeded;
exports.formatDuration = formatDuration;