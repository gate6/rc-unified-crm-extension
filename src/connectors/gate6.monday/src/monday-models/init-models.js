var DataTypes = require("sequelize").DataTypes;
var _admin = require("./admin");
var _companies = require("./companies");
var _customer = require("./customer");

function initModels(sequelize) {
  var admin = _admin(sequelize, DataTypes);
  var companies = _companies(sequelize, DataTypes);
  var customer = _customer(sequelize, DataTypes);

  customer.belongsTo(companies, { as: "company", foreignKey: "companyId"});
  companies.hasMany(customer, { as: "customers", foreignKey: "companyId"});

  return {
    admin,
    companies,
    customer,
  };
}
module.exports = initModels;
module.exports.initModels = initModels;
module.exports.default = initModels;
