const Sequelize = require('sequelize');
module.exports = function(sequelize, DataTypes) {
  return sequelize.define('companies', {
    id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true
    },
    licenseKeyId: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    companyName: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    maxAllowedUsers: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    hostname: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    clientId: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    clientSecret: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    username: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    tokenUrl: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    crmRedirectUrl: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    userDetailsPath: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    instanceUrl: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true
    },
    rcAccountId: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    contactTable: {
      type: DataTypes.ENUM('user', 'contact'),
      allowNull: false,
      defaultValue: 'contact'
    },
    subscriptionEndDate: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: Sequelize.literal("CURRENT_DATE + INTERVAL 15 DAY") 
    }
  }, {
    sequelize,
    tableName: 'companies',
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
    ]
  });
};
