const axios = require('axios');
const moment = require('moment');
const { parsePhoneNumber } = require('awesome-phonenumber');
const FormData = require('form-data');
const AWS = require('aws-sdk');
const s3Helper = require('../../servicenow-core/s3');
const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const { findStateValueByName, findStateValueById, findTypeValueByName, findTypeValueById } = require('../../servicenow-core/interaction');
const { secondsToHoursMinutesSeconds } = require('@app-connect/core/lib/util');
const models = initModels(sequelize);

function generateAlphanumericString(length) {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * chars.length);
        result += chars[randomIndex];
    }
    return result.toLowerCase();
}

async function getHostname(hostname) {
    const { UserModel } = require('@app-connect/core/models/userModel');
    const existingUser = await UserModel.findOne({
        where: {
           hostname: hostname
        },
        attributes:['id','hostname'],
        raw:true
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

async function getCompanyByHostname(hostname) {
    const company = await models.companies.findOne({
        where: {
            hostname: hostname,
            status: true
        },
        raw: true
    });

    if (!company) {
        throw new Error('Company not found or inactive');
    }
    return company;
}

function upsertCallAgentNote({ body, note }) {
    console.log("Note in upsertCallAgentNote", note);
    if (!!!note) {
        return body;
    }
    const noteRegex = RegExp('- Agent note: ([\\s\\S]+?)\n');
    if (noteRegex.test(body)) {
        body = body.replace(noteRegex, `- Agent note: ${note}\n`);
    }
    else {
        body += `- Agent note: ${note}\n`;
    }
    return body;
}

function upsertContactPhoneNumber({ body, phoneNumber, direction }) {
    const phoneNumberRegex = RegExp('- Contact Number: (.+?)\n');
    if (phoneNumberRegex.test(body)) {
        body = body.replace(phoneNumberRegex, `- Contact Number: ${phoneNumber}\n`);
    } else {
        body += `- Contact Number: ${phoneNumber}\n`;
    }
    return body;
}

function upsertCallResult({ body, result }) {
    const resultRegex = RegExp('- Result: (.+?)\n');
    if (resultRegex.test(body)) {
        body = body.replace(resultRegex, `- Result: ${result}\n`);
    } else {
        body += `- Result: ${result}\n`;
    }
    return body;
}

function upsertCallDuration({ body, duration }) {
    const durationRegex = RegExp('- Duration: (.+?)\n');
    if (durationRegex.test(body)) {
        body = body.replace(durationRegex, `- Duration: ${secondsToHoursMinutesSeconds(duration)}\n`);
    } else {
        body += `- Duration: ${secondsToHoursMinutesSeconds(duration)}\n`;
    }
    return body;
}

function upsertCallRecording({ body, recordingLink }) {
    const recordingLinkRegex = RegExp('- Call recording link: (.+?)\n');
    if (!!recordingLink && recordingLinkRegex.test(body)) {
        body = body.replace(recordingLinkRegex, `- Call recording link: ${recordingLink}\n`);
    } else if (!!recordingLink) {
        body += `- Call recording link: ${recordingLink}\n`;
    }
    return body;
}

function upsertAiNote({ body, aiNote }) {
    const aiNoteRegex = RegExp('- AI Note:([\\s\\S]*?)--- END');
    const clearedAiNote = aiNote.replace(/\n+$/, '');
    if (aiNoteRegex.test(body)) {
        body = body.replace(aiNoteRegex, `- AI Note:\n${clearedAiNote}\n--- END`);
    } else {
        body += `- AI Note:\n${clearedAiNote}\n--- END\n`;
    }
    return body;
}

function upsertTranscript({ body, transcript }) {
    const transcriptRegex = RegExp('- Transcript:([\\s\\S]*?)--- END');
    if (transcriptRegex.test(body)) {
        body = body.replace(transcriptRegex, `- Transcript:\n${transcript}\n--- END`);
    } else {
        body += `- Transcript:\n${transcript}\n--- END\n`;
    }
    return body;
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
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
            responseType: "stream",
        });

        const uploadParams = {
            Bucket: s3Bucket,
            Key: s3Key,
            Body: response.data
        };

        const uploadResult = await s3.upload(uploadParams).promise();

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

        const response = await axios.post(serviceNowURL, formData, {
            headers: {
                "Authorization": accessToken,
                ...formData.getHeaders(),
            },
        });

        console.log("File uploaded to ServiceNow:", response.data);

        await s3Helper.deleteObject(s3Key, "audio");
        console.log("File deleted from S3:", s3Key);

    } catch (error) {
        console.log("Error uploading file:", error.response ? error.response.data : error.message);
    }
}

module.exports = {
    generateAlphanumericString,
    getHostname,
    getCompanyByHostname,
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
};
