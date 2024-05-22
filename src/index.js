const path = require('path');
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser')
const { UserModel } = require('./models/userModel');
const { CallLogModel } = require('./models/callLogModel');
const { MessageLogModel } = require('./models/messageLogModel');
const cors = require('cors')
const jwt = require('./lib/jwt');
const logCore = require('./core/log');
const contactCore = require('./core/contact');
const authCore = require('./core/auth');
const releaseNotes = require('../releaseNotes.json');

async function initDB() {
    console.log('creating db tables if not exist...');
    await UserModel.sync();
    await CallLogModel.sync();
    await MessageLogModel.sync();
    console.log('db tables created');
}

function getHashValue(string, secretKey) {
    return crypto.createHash('sha256').update(
        `${string}:${secretKey}`
    ).digest('hex');
}
initDB();
const app = express();
app.use(bodyParser.json())

app.use(cors({
    methods: ['GET', 'POST', 'PATCH']
}));

app.get('/crmManifest', (req, res) => {
    try {
        if (!!!req.query.platformName) {
            const defaultCrmManifest = require('./adapters/manifest.json');
            res.json(defaultCrmManifest);
            return;
        }
        const crmManifest = require(`./adapters/${req.query.platformName}/manifest.json`);
        if (!!crmManifest) {
            res.json(crmManifest);
        }
        else {
            res.status(400).send('Platform not found');
        }
    }
    catch (e) {
        res.status(400).send('Platform not found');
    }
})

app.get('/is-alive', (req, res) => { res.send(`OK`); });
// Unique: Pipedrive
app.get('/pipedrive-redirect', function (req, res) {
    try {
        res.sendFile(path.join(__dirname, 'adapters/pipedrive/redirect.html'));
    }
    catch (e) {
        console.log(e);
        res.status(500).send(e);
    }
})
// Unique: Pipedrive
app.delete('/pipedrive-redirect', async function (req, res) {
    try {
        const basicAuthHeader = Buffer.from(`${process.env.PIPEDRIVE_CLIENT_ID}:${process.env.PIPEDRIVE_CLIENT_SECRET}`).toString('base64');
        if (`Basic ${basicAuthHeader}` === req.get('authorization')) {
            const platformModule = require(`./adapters/pipedrive`);
            await platformModule.unAuthorize({ id: req.body.user_id });
            await UserModel.destroy({
                where: {
                    id: req.body.user_id,
                    platform: 'pipedrive'
                }
            });
        }
    }
    catch (e) {
        console.log(e);
        res.status(500).send(e);
    }
})
app.get('/hostname', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!!jwtToken) {
            const unAuthData = jwt.decodeJwt(jwtToken);
            const user = await UserModel.findOne({
                where: {
                    id: unAuthData.id,
                    platform: unAuthData.platform
                }
            });
            if (!!!user) {
                res.status(400).send('unknown user');
            }
            res.status(200).send(user.hostname);
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        console.log(e);
        res.status(500).send(e);
    }
})
app.get('/oauth-callback', async function (req, res) {
    try {
        if (!!!req.query?.callbackUri || req.query.callbackUri === 'undefined') {
            throw 'missing callbackUri';
        }
        const platform = req.query.state ?
            req.query.state.split('platform=')[1] :
            decodeURIComponent(req.originalUrl.split('state=')[1].split('&')[0]).split('platform=')[1];
        const hostname = req.query.hostname;
        const tokenUrl = req.query.tokenUrl;
        if (!platform) {
            throw 'missing platform name';
        }
        const userInfo = await authCore.onOAuthCallback({
            platform,
            hostname,
            tokenUrl,
            callbackUri: req.query.callbackUri,
            apiUrl: req.query.apiUrl,
            username: req.query.username
        });
        const jwtToken = jwt.generateJwt({
            id: userInfo.id.toString(),
            platform: platform
        });
        res.status(200).send({ jwtToken, name: userInfo.name });
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
})
app.post('/apiKeyLogin', async function (req, res) {
    try {
        const platform = req.body.platform;
        const apiKey = req.body.apiKey;
        const hostname = req.body.hostname;
        const additionalInfo = req.body.additionalInfo;
        if (!platform) {
            throw 'missing platform name';
        }
        if (!apiKey) {
            throw 'missing api key';
        }
        const userInfo = await authCore.onApiKeyLogin({ platform, hostname, apiKey, additionalInfo });
        const jwtToken = jwt.generateJwt({
            id: userInfo.id.toString(),
            platform: platform
        });
        res.status(200).send({ jwtToken, name: userInfo.name });
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
})
app.post('/unAuthorize', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!!jwtToken) {
            const unAuthData = jwt.decodeJwt(jwtToken);
            const userToLogout = await UserModel.findOne({
                where: {
                    id: unAuthData.id,
                    platform: unAuthData.platform
                }
            });
            if (!!!userToLogout) {
                res.status(400).send('unknown user');
                return;
            }
            const platformModule = require(`./adapters/${unAuthData.platform}`);
            await platformModule.unAuthorize({ user: userToLogout });
            res.status(200).send();
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
});
app.get('/userInfoHash', async function (req, res) {
    try {
        const extensionId = getHashValue(req.query.extensionId, process.env.HASH_KEY);
        const accountId = getHashValue(req.query.accountId, process.env.HASH_KEY);
        res.status(200).send({ extensionId, accountId });
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
})
app.get('/contact', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!!jwtToken) {
            const { id: userId, platform } = jwt.decodeJwt(jwtToken);
            const { successful, message, contact } = await contactCore.getContact({ platform, userId, phoneNumber: req.query.phoneNumber, overridingFormat: req.query.overridingFormat });
            res.status(200).send({ successful, message, contact });
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
});
app.post('/contact', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!!jwtToken) {
            const { id: userId, platform } = jwt.decodeJwt(jwtToken);
            const { successful, message, contact } = await contactCore.createContact({ platform, userId, phoneNumber: req.body.phoneNumber, newContactName: req.body.newContactName, newContactType: req.body.newContactType });
            res.status(200).send({ successful, message, contact });
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
});
app.get('/callLog', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!!jwtToken) {
            const { id: userId, platform } = jwt.decodeJwt(jwtToken);
            const { successful, logs } = await logCore.getCallLog({ userId, sessionIds: req.query.sessionIds, platform });
            res.status(200).send({ successful, logs });
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
});
app.post('/callLog', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!!jwtToken) {
            const { id: userId, platform } = jwt.decodeJwt(jwtToken);
            const { successful, message, logId } = await logCore.addCallLog({ platform, userId, incomingData: req.body });
            res.status(200).send({ successful, message, logId });
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
});
app.patch('/callLog', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!!jwtToken) {
            const { id: userId, platform } = jwt.decodeJwt(jwtToken);
            const { successful, logId, updatedDescription } = await logCore.updateCallLog({ platform, userId, incomingData: req.body });
            res.status(200).send({ successful, logId, updatedDescription });
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
});
app.post('/messageLog', async function (req, res) {
    try {
        const jwtToken = req.query.jwtToken;
        if (!!jwtToken) {
            const { id: userId, platform } = jwt.decodeJwt(jwtToken);
            const { successful, message, logIds } = await logCore.addMessageLog({ platform, userId, incomingData: req.body });
            res.status(200).send({ successful, message, logIds });
        }
        else {
            res.status(400).send('Please go to Settings and authorize CRM platform');
        }
    }
    catch (e) {
        console.log(e);
        res.status(400).send(e);
    }
});

app.get('/releaseNotes', async function (req, res) {
    res.json(releaseNotes);
})

exports.server = app;