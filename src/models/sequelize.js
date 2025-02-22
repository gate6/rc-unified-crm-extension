const { Sequelize } = require('sequelize');
const AWS = require('aws-sdk');

async function getSecret() {
    const secretName = "rcservicenow-prod";
    const regionName = "us-east-1";

    const client = new AWS.SecretsManager({
        region: regionName
    });

    try {
        const data = await client.getSecretValue({ SecretId: secretName }).promise();
        if ('SecretString' in data) {
            return JSON.parse(data.SecretString);
        }
    } catch (err) {
        console.log("Error retrieving secret: ", err);
        throw err;
    }
}

async function loadSecrets() {
    if (!process.env.MYSQL_HOST) {
        const secrets = await getSecret();
        console.log("secrets", secrets)
        if (secrets) {
            Object.keys(secrets).forEach(key => {
                process.env[key] = secrets[key];
            });
        }
    }
}

// Call loadSecrets at the start of the application
loadSecrets();

console.log("process.env.MYSQL_HOST", process.env.MYSQL_HOST)

const sequelize = new Sequelize(process.env.DATABASE_URL,
  {
    dialect: 'postgres',
    protocol: 'postgres',
    dialectOptions:{
      ssl: {
        rejectUnauthorized: false
      }
    },
    logging: false
  }
);
 

exports.sequelize = sequelize;