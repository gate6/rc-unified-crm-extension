var DataTypes = require("sequelize").DataTypes;
var _companies = require("./companies");
var _customer = require("./customer");

function initModels(sequelize) {
  var companies = _companies(sequelize, DataTypes);
  var customer = _customer(sequelize, DataTypes);

  customer.belongsTo(companies, { as: "company", foreignKey: "company_id"});
  companies.hasMany(customer, { as: "customers", foreignKey: "company_id"});

  return {
    companies,
    customer,
  };
}
module.exports = initModels;
module.exports.initModels = initModels;
module.exports.default = initModels;
