const { Sequelize } = require('sequelize');
const path = require('path')
require('dotenv').config({path:path.join(__dirname,'..','..','.env')});

const sequelize = new Sequelize(
  process.env.SERVICENOW_DB_NAME,
  process.env.DB_USERNAME,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: process.env.DB_DIALECT || 'postgres',
    dialectOptions: {
      ssl: {
        rejectUnauthorized: false
      }
    },
    logging: false
  }
);

 

exports.sequelize = sequelize;