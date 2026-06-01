const axios = require('axios');
const {
    getHostname,
    validateLicenseOrFail,
    generateFormatsFromE164,
    toDigits,
    isSamePhone,
    buildFallbackTokens,
    getAllAccounts
} = require('../utils/servicenowHelpers');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const models = initModels(sequelize);

async function findContact({ user, authHeader, phoneNumber, overridingFormat, isExtension }) {
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
        const stateSelection = await axios.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=state&sysparm_fields=sys_id,label,value`,
            { headers: { 'Authorization': authHeader } }
        );
        states = stateSelection.data.result.length > 0 ? stateSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : [];
    } catch (err) {
        console.log('sys_choice state lookup failed, continuing without state options:', err.response?.status);
    }
    try {
        const typeSelection = await axios.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=type&sysparm_fields=sys_id,label,value`,
            { headers: { 'Authorization': authHeader } }
        );
        interactionType = typeSelection.data.result.length > 0 ? typeSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : [];
    } catch (err) {
        console.log('sys_choice type lookup failed, continuing without type options:', err.response?.status);
    }

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
        const personInfo = await axios.get(
            `https://${hostname}/api/now/${contactTable}?sysparm_query=phoneLIKE${numberToQuery}^ORmobile_phoneLIKE${numberToQuery}`,
            {
                headers: { 'Authorization': authHeader }
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
            const fallbackRes = await axios.get(
                `https://${hostname}/api/now/${contactTable}?sysparm_query=${encodeURIComponent(fallbackQuery)}&sysparm_limit=200`,
                { headers: { 'Authorization': authHeader } }
            );

            for (const result of (fallbackRes.data?.result || [])) {
                if (isSamePhone(result?.phone, rcDigits) || isSamePhone(result?.mobile_phone, rcDigits)) {
                    addMatchedContact(result);
                }
            }
        }

        if (matchedContactInfo.length === 0) {
            const broadRes = await axios.get(
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

module.exports = findContact;
