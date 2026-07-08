// @ts-nocheck
module.exports = function(sequelize, DataTypes) {
  return sequelize.define('analytics', {
    id: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true
    },
    companyId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'companies',
        key: 'id'
      }
    },
    companyName: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    hostname: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    rcAccountId: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    crm: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    analyticsDate: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    registeredUsers: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    callLogsCreated: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    callLogsUpdated: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    messageLogsCreated: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    messageLogsUpdated: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    contactsCreated: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    totalEvents: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    lastEventAt: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    tableName: 'analytics',
    timestamps: true,
    indexes: [
      {
        name: 'PRIMARY',
        unique: true,
        using: 'BTREE',
        fields: [
          { name: 'id' }
        ]
      },
      {
        name: 'analytics_company_crm',
        using: 'BTREE',
        fields: [
          { name: 'companyId' },
          { name: 'crm' },
          { name: 'analyticsDate' }
        ]
      },
      {
        name: 'analytics_hostname_rc_crm',
        using: 'BTREE',
        fields: [
          { name: 'hostname' },
          { name: 'rcAccountId' },
          { name: 'crm' },
          { name: 'analyticsDate' }
        ]
      }
    ]
  });
};

export {};
