const {
    S3Client,
    HeadObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand
} = require('@aws-sdk/client-s3'),
{getSignedUrl} = require('@aws-sdk/s3-request-presigner');
const { Readable } = require('stream');

const region = process.env.AWS_REGION;
const s3Client = new S3Client({
    region,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});
const buckets = {
    audio: process.env.S3_BUCKET
}

module.exports.makeImageVideoKey = ({id, name}) => {
    return `${id}-${name}`;
}

module.exports.makeGetUrl = (Key, type) => {
    return `https://${buckets[type]}.s3.${region}.amazonaws.com/${Key}`;
}

module.exports.generateUploadUrl = async (Key, type, mimeType) => {
    try {
        const expiresIn = 3600;
        const params = {
            Bucket: buckets[type],
            Key,
            ...(mimeType ? {ContentType: mimeType} : null)
        };
        const url = await getSignedUrl(s3Client, new PutObjectCommand(params), {expiresIn});
        return {url, expiresIn};
    } catch (error) {
        console.error('Error in signing url', error);
        throw error;
    }
}

module.exports.headObject = async (Key, type) => {
    try {
        const params = {
            Bucket: buckets[type], Key,
        };
        const headObjectCommand = new HeadObjectCommand(params);
        await s3Client.send(headObjectCommand);
        return true;
    } catch (error) {
        if (error.name === 'NotFound') {
            return false;
        } else {
            console.error('Error while checking object S3', error);
            throw error;
        }
    }
}

module.exports.deleteObject = async (Key, type) => {
    try {
        const params = {
            Bucket: buckets[type], Key,
        };
        const deleteObjectCommand = new DeleteObjectCommand(params);
        await s3Client.send(deleteObjectCommand);
        return true;
    } catch (error) {
        console.error('Error while deleting object S3', error);
        throw error;
    }
}

module.exports.uploadToFirstS3 = async (passThroughStream, key, bucketType) => {
    try {
        const uploadParams = {
            Bucket: buckets[bucketType],
            Key: key,
            Body: passThroughStream,
            ContentLength: passThroughStream.readableLength,
        };
        const command = new PutObjectCommand(uploadParams);
        await s3Client.send(command);
    } catch (error) {
        console.error('Error while uploading object S3', error);
        throw error;
    }

}

module.exports.getObject = async (Key, type) => {
    try {
        const params = {
            Bucket: buckets[type],
            Key,
        };

        const command = new GetObjectCommand(params);
        const { Body } = await s3Client.send(command);

        if (!(Body instanceof Readable)) {
            throw new Error("S3 response body is not a readable stream.");
        }

        return Body; // Return the stream
    } catch (error) {
        console.error('Error while getting object from S3', error);
        throw error;
    }
};