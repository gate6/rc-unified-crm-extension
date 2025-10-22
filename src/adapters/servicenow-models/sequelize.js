const { Sequelize } = require('sequelize');
const path = require('path')
require('dotenv').config({path:path.join(__dirname,'..','..','..','.env')});

const sequelize = new Sequelize(
  process.env.SERVICENOW_DB_URL,
  {
    dialect: 'postgres',
    protocol: 'postgres',
    dialectOptions: {
      ssl: {
        rejectUnauthorized: false
      }
    },
    logging: false
  }
);

 

exports.sequelize = sequelize;