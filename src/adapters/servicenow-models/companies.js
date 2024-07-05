const Sequelize = require('sequelize');
module.exports = function(sequelize, DataTypes) {
  return sequelize.define('companies', {
    id: {
      type: DataTypes.STRING(255),
      allowNull: false,
      primaryKey: true
    },
    license_key_id: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    license_key_type: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    max_allowed_users: {
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
    user_details_path: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    instanceUrl: {
      type: DataTypes.STRING(255),
      allowNull: true
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
