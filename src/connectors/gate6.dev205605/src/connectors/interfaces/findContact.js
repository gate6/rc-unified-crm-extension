const axios = require('axios');
const { getHostname } = require('../utils/servicenowHelpers');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const models = initModels(sequelize);

async function findContact({ user, authHeader, phoneNumber, overridingFormat, isExtension }) {
    // ----------------------------------------
    // ---TODO.3: Implement contact matching---
    // ----------------------------------------

    const numberToQueryArray = [];
    console.log("authHeader", authHeader)

    if (overridingFormat === '') {
        numberToQueryArray.push(phoneNumber.replace(/^\+/, ''));
    }
    else {
        const formats = overridingFormat.split(',');
        for (var format of formats) {
            let phoneNumberObj;
            if(isExtension) {
                numberToQueryArray.push(phoneNumber);
            } else {
                phoneNumberObj = parsePhoneNumber(phoneNumber.replace(' ', '+'));
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
    }

    const userInfo = await getHostname(user.dataValues.hostname);
    const instanceId = userInfo.instanceId;
    const hostname = userInfo.hostname;

    console.log("hostname", hostname)

    const companyData = await models.companies.findOne({
        where: {
            hostname: hostname,
            status: true
        }
    });

    if (!(companyData?.status)) {
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
        `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=state&sysparm_fields=sys_id,label,value`,
        {
            headers: { 'Authorization':  authHeader }
        });
    
    const typeSelection = await axios.get(
        `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=type&sysparm_fields=sys_id,label,value`,
        {
            headers: { 'Authorization':  authHeader }
        });

    const states = stateSelection.data.result.length > 0 ? stateSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : null;

    const interactionType = typeSelection.data.result.length > 0 ? typeSelection.data.result.map(m => { return { const: m.sys_id, title: m.label } }) : null;
    

    // You can use parsePhoneNumber functions to further parse the phone number
    const matchedContactInfo = [];
    const isExtensionBool = isExtension === true || isExtension === 'true';
    const contactTable = (companyData?.contactTable?.trim().toLowerCase() == 'user' || isExtensionBool) ? 'table/sys_user' : 'contact';

    for (var numberToQuery of numberToQueryArray) {
        const personInfo = await axios.get(
            `https://${hostname}/api/now/${contactTable}?sysparm_query=phoneLIKE${numberToQuery}`,
            {
                headers: { 'Authorization':  authHeader }
            });

        if (personInfo.data.result.length > 0) {
            for (var result of personInfo.data.result) {
                matchedContactInfo.push({
                    id: result.sys_id,
                    name: (contactTable == 'table/sys_user') ? result.user_name : result.name,
                    phone: numberToQuery,
                    additionalInfo: {state: states, type: interactionType}
                })
            }
        }
    }

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
        successful: true,
        matchedContactInfo
    };
}

module.exports = findContact;