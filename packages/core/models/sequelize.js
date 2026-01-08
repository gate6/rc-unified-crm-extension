require('dotenv').config();
const { Sequelize } = require('sequelize');

// Use DATABASE_URL for database connection
const sequelize = new Sequelize(
  process.env.DATABASE_URL,
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