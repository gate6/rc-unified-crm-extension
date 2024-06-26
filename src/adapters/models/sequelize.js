const { Sequelize } = require('sequelize');

const sequelize2 = new Sequelize('ringcentraldev', 'ringcentraldev', 'RnG#4WE4^CeTRaL74QP', {
  host: '127.0.0.1', // for local use 52.12.152.111
  dialect: 'mysql',
  dialectOptions:  {
    ssl: {
      rejectUnauthorized: false
    }
  },
  pool: {
    max: 15,
    min: 5,
    idle: 20000,
    evict: 15000,
    acquire: 30000
  },
  logging: false
}
);
 

exports.sequelize2 = sequelize2;