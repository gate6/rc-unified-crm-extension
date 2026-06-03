const Sequelize = require('sequelize');
module.exports = function(sequelize, DataTypes) {
  return sequelize.define('customer', {
    sysId: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    hostname: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    timezoneName: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    timezoneOffset: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    platform: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    accessToken: {
      type: DataTypes.STRING(20000),
      allowNull: true
    },
    refreshToken: {
      type: DataTypes.STRING(20000),
      allowNull: true
    },
    tokenExpiry: {
      type: DataTypes.DATE,
      allowNull: true
    },
    platformAdditionalInfo: {
      type: DataTypes.JSON,
      allowNull: true
    },
    firstname: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    lastname: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'companies',
        key: 'id'
      }
    },
    id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true
    }
  }, {
    sequelize,
    tableName: 'customer',
    timestamps: true,
    indexes: [
      {
        name: "PRIMARY",
        unique: true,
        using: "BTREE",
        fields: [
          { name: "id" },
        ]
      },
      {
        name: "customer_FK",
        using: "BTREE",
        fields: [
          { name: "companyId" },
        ]
      },
    ]
  });
};
