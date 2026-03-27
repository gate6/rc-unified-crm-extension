const { sequelize } = require('../../../../servicenow-models/sequelize');
const { initModels } = require('../../../../servicenow-models/init-models');
const { authenticate } = require('../utils/agencyZoomHelpers');

const models = initModels(sequelize);

async function getUserInfo(authHeader) {
  const { hostname, additionalInfo } = authHeader;
  const username = additionalInfo?.username || additionalInfo?.email;
  const password = additionalInfo?.password;

  try {
    if (!hostname || !username || !password) {
      return {
        successful: false,
        platformUserInfo: {
          id: '',
          name: '',
          platformAdditionalInfo: {}
        },
        returnMessage: {
          messageType: 'error',
          message: 'Missing AgencyZoom login details.',
          ttl: 3000
        }
      };
    }

    const token = await authenticate(username, password);

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
          id: '',
          name: '',
          platformAdditionalInfo: {}
        },
        returnMessage: {
          messageType: 'danger',
          message: 'Could not find the company details.',
          ttl: 3000
        }
      };
    }

    const { maxAllowedUsers, customers = [] } = company;

    const customer = customers.find(c => c.email === username);

    if (!customer) {
      if (customers.length >= maxAllowedUsers) {
        return {
          successful: false,
          platformUserInfo: {
            id: '',
            name: '',
            timezoneName: '',
            timezoneOffset: '',
            platformAdditionalInfo: {}
          },
          returnMessage: {
            messageType: 'danger',
            message: 'You are not having an active license. Please contact us.',
            ttl: 3000
          }
        };
      }

      await models.customer.create({
        sysId: `az-user-${username}`,
        email: username,
        companyId: company.id,
        hostname,
        accessToken: token,
        tokenExpiry: Date.now() + (365 * 24 * 60 * 60 * 1000),
        platformAdditionalInfo: {
          email: username,
          username,
          password,
          expiresAt: Date.now() + (365 * 24 * 60 * 60 * 1000)
        },
        status: true,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    return {
      successful: true,
      platformUserInfo: {
        id: `az-user-${username}`,
        name: username,
        email: username,
        overridingApiKey: token,
        platformAdditionalInfo: {
          email: username,
          username,
          password
        }
      },
      returnMessage: {
        messageType: 'success',
        message: 'Successfully connected to AgencyZoom.',
        ttl: 3000
      }
    };
  } catch (err) {
    console.error('AgencyZoom login error:', err?.response?.data || err.message);

    return {
      successful: false,
      returnMessage: {
        messageType: 'error',
        message: 'AgencyZoom authentication failed.',
        ttl: 3000
      }
    };
  }
}

module.exports = getUserInfo;
