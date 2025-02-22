const { Sequelize } = require('sequelize');
const AWS = require('aws-sdk');

function getSecretSync() {
    const secretName = "rcservicenow-prod";
    const regionName = "us-east-1";

    const client = new AWS.SecretsManager({
        region: regionName
    });

    let secret;
    client.getSecretValue({ SecretId: secretName }, (err, data) => {
        if (err) {
            console.log("Error retrieving secret: ", err);
            throw err;
        } else {
            if ('SecretString' in data) {
                secret = JSON.parse(data.SecretString);
            }
        }
    });

    // Wait until the secret is retrieved
    while (!secret) {
        require('deasync').runLoopOnce();
    }

    return secret;
}

function loadSecretsSync() {
    if (!process.env.MYSQL_HOST) {
        const secrets = getSecretSync();
        console.log("secrets", secrets)
        if (secrets) {
            Object.keys(secrets).forEach(key => {
                process.env[key] = secrets[key];
            });
        }
    }
}

// Load secrets synchronously at the start of the application
loadSecretsSync();

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