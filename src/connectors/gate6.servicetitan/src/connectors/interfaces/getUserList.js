const { getRefreshedAuthToken, validateLicenseOrFail, serviceTitanApiClient } = require('../utils/serviceTitanHelpers');

async function getUserList({ user, authHeader }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return [];

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    try {
        const userListResp = await serviceTitanApiClient.get(
            `https://api-integration.servicetitan.io/crm/v2/tenant/${tenantId}/customers`,
            {
                headers: {
                    'Authorization': `Bearer ${auth}`,
                    'ST-App-Key': stAppKey
                }
            }
        );

        const userList = userListResp.data?.data?.map(employee => ({
            id: employee.id,
            name: employee.name
        })) || [];

        return userList;
    } catch (error) {
        console.error('Failed to fetch user list:', error?.response?.data || error.message);
        return [];
    }
}

module.exports = getUserList;
