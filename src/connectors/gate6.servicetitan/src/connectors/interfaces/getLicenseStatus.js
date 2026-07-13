const { UserModel } = require('@app-connect/core/models/userModel');
const { sequelize } = require('../../servicetitan-models/sequelize');
const { initModels } = require('../../servicetitan-models/init-models');

const models = initModels(sequelize);

async function getLicenseStatus({ userId }) {
    try {
        const user = await UserModel.findByPk(userId);
        if (!user) {
            return {
                isLicenseValid: false,
                licenseStatus: 'User Not Found',
                licenseStatusDescription: ''
            };
        }

        const company = await models.companies.findOne({
            where: { hostname: user.hostname },
            raw: true
        });

        if (!company || company.status !== true) {
            return {
                isLicenseValid: false,
                licenseStatus: 'Inactive',
                licenseStatusDescription: 'Purchase license to continue'
            };
        }

        return {
            isLicenseValid: true,
            licenseStatus: 'Active',
            licenseStatusDescription: 'Basic'
        };
    } catch (error) {
        console.error('getLicenseStatus error:', error);
        return {
            isLicenseValid: false,
            licenseStatus: 'Error',
            licenseStatusDescription: 'Error validating license'
        };
    }
}

module.exports = getLicenseStatus;
