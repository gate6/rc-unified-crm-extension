const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);

async function getUserInfo({ authHeader, hostname, query }) {
  try {
    const callbackUri = query.callbackUri;
    const code = new URL(callbackUri).searchParams.get('code');
    const where = { hostname, status: "true" }
    if (query.rcAccountId) {
      where.rcAccountId = query.rcAccountId
    }
    const company = await models.companies.findOne({
      where,
      include: [{ model: models.customer, as: 'customers', required: false }],
      raw: false,
      logging: false
    });

    // Company not found
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
      customers = []
    } = company;

    // Config validation
    if (!clientId || !clientSecret) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: 'Monday configuration incomplete.',
          ttl: 3000
        }
      };
    }

    // License inactive
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
    const accessToken = authHeader.replace('Bearer ', '');
    if (!accessToken) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: 'Failed to get access token.',
          ttl: 3000
        }
      };
    }

    const userDataResponse = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`, // 
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: "query { me { id name email } }"
      })
    });

    const result = await userDataResponse.json();

    // 
    if (!result?.data?.me) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: 'Failed to get user data.',
          ttl: 3000
        }
      };
    }

    // 
    const userData = {
      id: result.data.me.id,
      name: result.data.me.name,
      email: result.data.me.email
    };

    let customer = customers.find(c => c.email === userData.email);
    // Create user if not exists
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
        sysId: userData.id,
        email: userData.email,
        companyId: company.id,
        hostname: hostname,
        accessToken: accessToken,
        tokenExpiry: Date.now() + (365 * 24 * 60 * 60 * 1000),
        platformAdditionalInfo: {
          client_id: clientId,
          client_secret: clientSecret,
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
        id: userData.id,
        name: userData.name,
        email: userData.email,
        overridingApiKey: accessToken,

        platformAdditionalInfo: {
          client_id: clientId,
          client_secret: clientSecret,
          expiresAt: Date.now() + ((900 - 60) * 1000) // 15 min - 1 min buffer
        }
      },
      returnMessage: {
        messageType: 'success',
        message: 'Successfully connected to Monday.',
        ttl: 3000
      }
    };

  } catch (err) {
    console.error('AUTO MONDAY LOGIN ERROR:', err?.response?.data || err.message);

    return {
      successful: false,
      returnMessage: {
        messageType: 'error',
        message: 'Automatic Monday authentication failed.',
        ttl: 3000
      }
    };
  }
}

module.exports = getUserInfo;