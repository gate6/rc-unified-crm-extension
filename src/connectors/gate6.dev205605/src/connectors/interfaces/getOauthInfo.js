const { initModels } = require('../../servicenow-models/init-models');
const { sequelize } = require('../../servicenow-models/sequelize');
const models = initModels(sequelize);

async function getOauthInfo(requestData) {
    console.log("getOauthInfo requestData", requestData);

    const companyData = await models.companies.findOne({
        where: {
            hostname: requestData.hostname
        },
        raw: true
    });

    if (!companyData) {
        return {
            failMessage: 'Company data not found for the provided hostname.'
        };
    }
    
    const { clientId, clientSecret, crmRedirectUrl, tokenUrl } = companyData;
    
    if (!clientId || !clientSecret || !crmRedirectUrl || !tokenUrl) {
        return {
            failMessage: 'RingCentral Account is not fully configured with Gate6.'
        };
    }
    
    return {
        clientId,
        clientSecret,
        accessTokenUri: tokenUrl,
        redirectUri: crmRedirectUrl
    };
}

module.exports = getOauthInfo;