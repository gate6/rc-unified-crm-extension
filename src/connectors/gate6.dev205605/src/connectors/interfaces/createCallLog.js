const axios = require('axios');
const moment = require('moment');
const crypto = require('crypto');
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
    findTypeValueById,
    validateLicenseOrFail,
    applyClosedDatesIfNeeded,
    formatDuration
} = require('../utils/servicenowHelpers');
const models = initModels(sequelize);

async function createCallLog({ user, contactInfo, authHeader, callLog, note, additionalSubmission, aiNote, transcript }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    let subject =
        (user.userSettings?.addCallLogSubject?.value ?? true)
            ? (callLog?.customSubject?.trim() || "")
            : "";

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
        where: { hostname: userInfo.hostname },
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
    const caller_id = await axios.get(`https://${hostname}/api/${userDetailsPath}`, {
        headers: { 'Authorization': authHeader }
    });

    const callKeyParts = [
        callLog?.telephonySessionId || callLog?.id,
        callLog?.startTime,
        contactInfo?.id
    ]
        .map((value) => (value ?? '').toString().trim())
        .filter(Boolean);

    const uniqueCallId = callKeyParts.length > 0
        ? `rc_${crypto.createHash('sha1').update(callKeyParts.join('|')).digest('hex').slice(0, 32)}`
        : '';
    if (uniqueCallId) {
        const queryParts = [`correlation_id=${uniqueCallId}`];
        if (contactInfo?.id) {
            queryParts.push(`opened_for=${contactInfo.id}`);
        }
        const existing = await axios.get(
            `https://${hostname}/api/now/table/interaction?sysparm_query=${encodeURIComponent(queryParts.join('^'))}&sysparm_fields=sys_id,short_description,opened_for,sys_created_on&sysparm_limit=1`,
            { headers: { 'Authorization': authHeader } }
        );
        if (existing.data?.result?.length > 0) {
            const existingLog = existing.data.result[0];
            const existingOpenedFor = (existingLog?.opened_for?.value || existingLog?.opened_for || '').toString().trim();
            const isSameContact = !!contactInfo?.id && existingOpenedFor === contactInfo.id.toString().trim();
            const isSameSubject = (existingLog?.short_description || '').toString().trim() === (subject || '').toString().trim();
            const existingCreatedAt = Date.parse(existingLog?.sys_created_on || '');
            const isRecent = Number.isFinite(existingCreatedAt) && (Date.now() - existingCreatedAt) <= 10 * 60 * 1000;

            if (isSameContact && isSameSubject && isRecent) {
                return {
                    logId: existingLog.sys_id,
                    returnMessage: { message: 'Call log already exists.', messageType: 'warning', ttl: 3000 }
                };
            }
        }
    }

    const postBody = {
        short_description: subject,
        work_notes: body,
        ...(uniqueCallId && { correlation_id: uniqueCallId })
    }
    if (callLog?.startTime) {
        postBody.opened_at = callLog.startTime;
    }

    postBody.u_call_duration = formatDuration(callLog.duration);

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