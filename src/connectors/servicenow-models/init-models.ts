// @ts-nocheck
var DataTypes = require("sequelize").DataTypes;
var _admin = require("./admin");
var _companies = require("./companies");
var _customer = require("./customer");
var _analytics = require("./analytics")

function initModels(sequelize) {
  var admin = _admin(sequelize, DataTypes);
  var companies = _companies(sequelize, DataTypes);
  var customer = _customer(sequelize, DataTypes);
  var analytics = _analytics(sequelize, DataTypes);

  customer.belongsTo(companies, { as: "company", foreignKey: "companyId"});
  companies.hasMany(customer, { as: "customers", foreignKey: "companyId"});

  return {
    admin,
    companies,
    customer,
    analytics
  };
}
module.exports = initModels;
module.exports.initModels = initModels;
module.exports.default = initModels;

export {};
