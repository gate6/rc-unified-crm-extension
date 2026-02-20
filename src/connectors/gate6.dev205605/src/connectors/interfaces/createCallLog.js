const axios = require('axios');
const moment = require('moment');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const { 
    getHostname, 
    upsertCallAgentNote, 
    upsertContactPhoneNumber, 
    upsertCallResult, 
    upsertCallDuration, 
    upsertCallRecording, 
    upsertAiNote, 
    upsertTranscript,
    downloadAudioFile,
    uploadToServiceNow,
    findStateValueByName,
    findStateValueById,
    findTypeValueByName,
    findTypeValueById
} = require('../utils/servicenowHelpers');
const models = initModels(sequelize);

async function createCallLog({ user, contactInfo, authHeader, callLog, note, additionalSubmission, aiNote, transcript }) {
    let body = '';
    if (user.userSettings?.addCallLogNote?.value ?? true) { body = upsertCallAgentNote({ body, note }); }
    if (user.userSettings?.addCallLogContactNumber?.value ?? true) { body = upsertContactPhoneNumber({ body, phoneNumber: contactInfo.phoneNumber, direction: callLog.direction }); }
    if (user.userSettings?.addCallLogResult?.value ?? true) { body = upsertCallResult({ body, result: callLog.result }); }
    if (user.userSettings?.addCallLogDuration?.value ?? true) { body = upsertCallDuration({ body, duration: callLog.duration }); }
    if (!!callLog.recording?.link && (user.userSettings?.addCallLogRecording?.value ?? true)) { body = upsertCallRecording({ body, recordingLink: callLog.recording.link }); }
    if (!!aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) { body = upsertAiNote({ body, aiNote }); }
    if (!!transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) { body = upsertTranscript({ body, transcript }); }

    const userInfo = await getHostname(user.dataValues.hostname);
    const { userDetailsPath } = await models.companies.findOne({
        where: { hostname: userInfo.hostname, status: true },
        raw: true
    });

    if (!userDetailsPath) {
        return {
            successful: false,
            returnMessage: {
                messageType: 'danger',
                message: `You are not having an active license. Please contact us.`,
                ttl: 3000
            }
        };
    }

    const hostname = userInfo.hostname;
    const companyData = await models.companies.findOne({
        where: { hostname: hostname, status: true }
    });

    if (!(companyData?.status)) {
        return {
            successful: false,
            returnMessage: {
                messageType: 'danger',
                message: `You are not having an active license. Please contact us.`,
                ttl: 3000
            }
        };
    }

    const caller_id = await axios.get(`https://${hostname}/api/${userDetailsPath}`, {
        headers: { 'Authorization': authHeader }
    });

    const postBody = {
        short_description: callLog.customSubject ?? `[Call] ${callLog.direction} Call ${callLog.direction === 'Outbound' ? 'to' : 'from'} ${contactInfo.name} [${contactInfo.phoneNumber}]`,
        work_notes: body //? `${workNotes} ${body}` : workNotes
    }

    postBody.assigned_to = caller_id.data.result.id;

    console.log("additionalSubmission", additionalSubmission)

    if (additionalSubmission?.state) {
        const returnedState = await findStateValueById(hostname, authHeader, additionalSubmission.state);
        postBody.state = returnedState ?? await findStateValueByName(hostname, authHeader, additionalSubmission.state);
    }

    postBody.opened_for = contactInfo.id;
    
    if (additionalSubmission?.type) {
        const returnedType = await findTypeValueById(hostname, authHeader, additionalSubmission.type);
        postBody.type = returnedType ?? await findTypeValueByName(hostname, authHeader, additionalSubmission.type);
    }

    const addLogRes = await axios.post(
        `https://${hostname}/api/now/table/interaction`,
        postBody,
        { headers: { 'Authorization': authHeader } }
    );
    
    if (callLog?.recording?.downloadUrl) {
        const timestamp = moment().format("DD-MM-YYYY_HH_MM_SS");
        const fileName = `downloaded_audio_${timestamp}`;
        const s3Key = `${fileName}.mp3`;
        const s3Url = await downloadAudioFile(callLog?.recording?.downloadUrl, process.env.S3_BUCKET, s3Key);
        await uploadToServiceNow(s3Url, hostname, authHeader, addLogRes?.data?.result?.sys_id, fileName);
    }

    return {
        logId: addLogRes.data.result.sys_id,
        returnMessage: {
            message: 'Call log added.',
            messageType: 'success',
            ttl: 3000
        }
    };
}

module.exports = createCallLog;