const Sequelize = require('sequelize');
const { sequelize2 } = require('./sequelize');

// Model for User data
const CompanyModel = sequelize2.define('company', {
  id: {
    type: Sequelize.STRING,
    primaryKey: true,
  },
  license_key_id: {
    type: Sequelize.STRING,
  },
  license_key_type: {
    type: Sequelize.STRING,
  },
  max_allowed_users:{
    type:Sequelize.BIGINT
  },
  hostname:{
    type: Sequelize.STRING,
  },
  clientId:{
    type: Sequelize.STRING,
  },
  clientSecret:{
    type: Sequelize.STRING,
  },
  username:{
    type: Sequelize.STRING,
  },
  password:{
    type: Sequelize.STRING,
  }
});
// ConfigModel1.associate = function(models) {
//   ConfigModel1.hasMany(models.UserModel1, { foreignKey: 'license_key_id' });
// };

exports.CompanyModel = CompanyModel
