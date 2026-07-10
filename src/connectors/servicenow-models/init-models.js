var DataTypes = require("sequelize").DataTypes;
var _admin = require("./admin");
var _analytics = require("./analytics");
var _companies = require("./companies");
var _customer = require("./customer");

function initModels(sequelize) {
  var admin = _admin(sequelize, DataTypes);
  var analytics = _analytics(sequelize, DataTypes);
  var companies = _companies(sequelize, DataTypes);
  var customer = _customer(sequelize, DataTypes);

  customer.belongsTo(companies, { as: "company", foreignKey: "companyId"});
  companies.hasMany(customer, { as: "customers", foreignKey: "companyId"});

  return {
    admin,
    analytics,
    companies,
    customer,
  };
}
module.exports = initModels;
module.exports.initModels = initModels;
module.exports.default = initModels;
