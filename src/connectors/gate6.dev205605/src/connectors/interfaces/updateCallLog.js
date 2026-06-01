const axios = require('axios');
const moment = require('moment');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const { 
    getHostname, 
    upsertCallAgentNote, 
    upsertCallDuration, 
    upsertCallResult, 
    upsertCallRecording, 
    upsertAiNote, 
    upsertTranscript,
    downloadAudioFile,
    uploadToServiceNow,
    validateLicenseOrFail,
    formatDuration
} = require('../utils/servicenowHelpers');
const models = initModels(sequelize);

// - note: note submitted by user
// - subject: subject submitted by user
// - startTime: more accurate startTime will be patched to this update function shortly after the call ends
// - duration: more accurate duration will be patched to this update function shortly after the call ends
// - result: final result will be patched to this update function shortly after the call ends
// - recordingLink: recordingLink updated from RingCentral. It's separated from createCallLog because recordings are not generated right after a call. It needs to be updated into existing call log
async function updateCallLog({ user, existingCallLog, authHeader, recordingLink, recordingDownloadLink, subject, note, startTime, duration, result, aiNote, transcript }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const userInfo = await getHostname(user.dataValues.hostname);
    const hostname = userInfo.hostname;
    const existingLogId = existingCallLog.thirdPartyLogId;

    const getLogRes = await axios.get(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        { headers: { 'Authorization': authHeader } }
    );
    const originalNote = getLogRes?.data?.result?.work_notes ?? '';
    const originalSubject = getLogRes?.data?.result?.short_description || '';
    let subjectToUse = originalSubject || "";

    if (subject && (user.userSettings?.addCallLogSubject?.value ?? true)) {
        subjectToUse = subject.trim();
    }

    let logBody = originalNote;
    if (!!note && (user.userSettings?.addCallLogNote?.value ?? true)) { logBody = upsertCallAgentNote({ body: logBody, note }); }
    if (!!duration && (user.userSettings?.addCallLogDuration?.value ?? true)) { logBody = upsertCallDuration({ body: logBody, duration }); }
    if (!!result && (user.userSettings?.addCallLogResult?.value ?? true)) { logBody = upsertCallResult({ body: logBody, result }); }
    if (!!recordingLink && (user.userSettings?.addCallLogRecording?.value ?? true)) { logBody = upsertCallRecording({ body: logBody, recordingLink: decodeURIComponent(recordingLink) }); }
    if (!!aiNote && (user.userSettings?.addCallLogAiNote?.value ?? true)) { logBody = upsertAiNote({ body: logBody, aiNote }); }
    if (!!transcript && (user.userSettings?.addCallLogTranscript?.value ?? true)) { logBody = upsertTranscript({ body: logBody, transcript }); }

    const patchBody = {
        short_description: subjectToUse,
        work_notes: logBody
    };

    patchBody.u_call_duration = formatDuration(duration);

    const patchLog = await axios.patch(
        `https://${hostname}/api/now/table/interaction/${existingLogId}`,
        patchBody,
        { headers: { 'Authorization': authHeader } }
    );

    if (recordingDownloadLink) {
        console.log("Downloading Recorded File...");
        const timestamp = moment().format("DD-MM-YYYY_HH_MM_SS");
        const fileName = `downloaded_audio_${timestamp}`;
        const s3Key = `${fileName}.mp3`;
        const s3Url = await downloadAudioFile(recordingDownloadLink, process.env.S3_BUCKET, s3Key);
        await uploadToServiceNow(s3Url, hostname, authHeader, existingLogId, fileName);
    }

    const patchLogRes = {
        data: {
            id: patchLog.data.result.sys_id
        }
    }

    return {
        updatedNote: note,
        returnMessage: {
            message: 'Call log updated.',
            messageType: 'success',
            ttl: 3000
        }
    };
}

module.exports = updateCallLog;
