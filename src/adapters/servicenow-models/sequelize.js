const { Sequelize } = require('sequelize');
const path = require('path')
console.log(path.join(__dirname,'..','..','.env'));
require('dotenv').config({path:path.join(__dirname,'..','..','.env')});
// console.log(process.env.MYSQL_DATABASE);
// return 0
const sequelize = new Sequelize(process.env.MYSQL_DATABASE, process.env.MYSQL_USER, process.env.MYSQL_PASSWORD, {
  host: process.env.MYSQL_HOST,
  dialect: 'mysql',
  dialectOptions:  {
    ssl: {
      rejectUnauthorized: false
    }
  },
  logging: false
}
);
 

exports.sequelize = sequelize;