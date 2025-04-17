const axios = require('axios');
const { cat } = require('shelljs');

const stateMapping = {
    "wrap up": "wrap_up",
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

async function findStateValueByName(hostname, authHeader, inputValue){
    
    try{
        console.log("findStateValueByName called with inputValue:", inputValue);
        const normalizedInputValue = inputValue.toLowerCase();
        const normalizedValue = stateMapping[normalizedInputValue] || null;

        if (!normalizedValue) {
            console.log("Invalid state value provided.");
            // throw new Error("Invalid state value provided.");
        }
        
        const stateSelection = await axios.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=state^label=${normalizedInputValue}&sysparm_fields=sys_id,label,value`,
            {
                headers: { 'Authorization':  authHeader }
            });
        
        if (stateSelection.data && stateSelection.data.result && stateSelection.data.result.length > 0) {
            return stateSelection.data.result[0].value;
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
        
        const stateSelection = await axios.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=state^sys_id=${inputId}&sysparm_fields=sys_id,label,value`,
            {
                headers: { 'Authorization':  authHeader }
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
        const normalizedInputValue = inputValue.toLowerCase();
        const normalizedValue = typeMapping[normalizedInputValue] || null;

        if (!normalizedValue) {
            console.log("Invalid type value provided.");
            // throw new Error("Invalid type value provided.");
        }
        
        const typeSelection = await axios.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=type^label=${normalizedInputValue}&sysparm_fields=sys_id,label,value`,
            {
                headers: { 'Authorization': authHeader }
            });
        
        if (typeSelection.data && typeSelection.data.result && typeSelection.data.result.length > 0) {
            return typeSelection.data.result[0].value;
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
        
        const typeSelection = await axios.get(
            `https://${hostname}/api/now/table/sys_choice?sysparm_query=name=interaction^element=type^sys_id=${inputId}&sysparm_fields=sys_id,label,value`,
            {
                headers: { 'Authorization': authHeader }
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


exports.findStateValueByName = findStateValueByName;
exports.findStateValueById = findStateValueById;
exports.findTypeValueByName = findTypeValueByName;
exports.findTypeValueById = findTypeValueById;