const axios = require('axios');

async function upsertCallDisposition({ user, existingCallLog, authHeader, callDisposition }) {
    //--------------------------------------
    //--- TODO: Add CRM API call here ------
    //--------------------------------------
    const existingLogId = existingCallLog.thirdPartyLogId;
    if (callDisposition?.dispositionItem) {
        console.log("callDisposition", callDisposition?.dispositionItem);
    }
    return {
        logId: existingLogId
    }
}

module.exports = upsertCallDisposition;