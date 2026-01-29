const { sequelize } = require('../../servicenow-models/sequelize');
const { initModels } = require('../../servicenow-models/init-models');
const { generateServiceTitanToken } = require('../utils/serviceTitanHelpers');
const models = initModels(sequelize);

async function getUserInfo(authHeader) {
  const { hostname, additionalInfo } = authHeader;
  const email = additionalInfo?.email;

  try {
    const company = await models.companies.findOne({
      where: { hostname },
      include: [{ model: models.customer, as: 'customers', required: false }],
      raw: false,
      logging: false
    });

    if (!company) {
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
          message: 'Could not find the company details.',
          ttl: 3000
        }
      };
    }

    const {
      clientId,
      clientSecret,
      maxAllowedUsers,
      status,
      tenantId,
      apiKey : stAppKey,
      customers = []
    } = company;

    if (!clientId || !clientSecret || !tenantId || !stAppKey) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: 'ServiceTitan configuration incomplete.',
          ttl: 3000
        }
      };
    }

    if (status !== true) {
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
          message: 'You do not have an active license. Please contact us.',
          ttl: 3000
        }
      };
    }

    let customer = customers.find(c => c.email === email);
    const accessToken = await generateServiceTitanToken(clientId, clientSecret);
    
    if (!customer) {
      if (customers.length >= maxAllowedUsers) {
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

      await models.customer.create({
        sysId: `st-user-${email}`,
        email,
        companyId: company.id,
        hostname: hostname,
        accessToken: accessToken,
        tokenExpiry: Date.now() + ((900 - 60) * 1000),
        platformAdditionalInfo: {
          client_id: clientId,
          client_secret: clientSecret,
          st_app_key: stAppKey,
          tenant: tenantId,
          expiresAt: Date.now() + ((900 - 60) * 1000)
        },
        status: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    return {
      successful: true,
      platformUserInfo: {
        id: `st-user-${email}`,
        name: email,
        email,
        overridingApiKey: accessToken,
        platformAdditionalInfo: {
          client_id: clientId,
          client_secret: clientSecret,
          st_app_key: stAppKey,
          tenant: tenantId,
          expiresAt: Date.now() + ((900 - 60) * 1000)
        }
      },
      returnMessage: {
        messageType: 'success',
        message: 'Successfully connected to ServiceTitan.',
        ttl: 3000
      }
    };

  } catch (err) {
    console.error('AUTO ST LOGIN ERROR:', err?.response?.data || err.message);

    return {
      successful: false,
      returnMessage: {
        messageType: 'error',
        message: 'Automatic ServiceTitan authentication failed.',
        ttl: 3000
      }
    };
  }
}

module.exports = getUserInfo;
