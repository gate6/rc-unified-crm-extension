const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);
const { mondayRequest, getColumnIdByName, normalizePhone, getCompanyByHostname, validateLicenseOrFail } = require('../utils/mondayHelpers');

async function findContact({ phoneNumber, accessToken, authHeader, user }) {
  const licenseError = await validateLicenseOrFail(user)
  if (licenseError) return licenseError

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
  })
  const boardId = company.tenantId
  const phone = normalizePhone(phoneNumber)
  const matchedContactInfo = []
  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  const phoneColumnId = await getColumnIdByName({
    accessToken: resolvedAccessToken,
    boardId: boardId,
    columnName: 'Phone'
  })
  console.log('phoneColumnId', phoneColumnId)
  if (!phoneColumnId) {
    return {
      successful: false,
      returnMessage: {
        messageType: 'error',
        message: 'Monday phone column not found. Set MONDAY_PHONE_COLUMN_ID or MONDAY_PHONE_COLUMN_NAME.',
        ttl: 3000
      }
    }
  }

  if (phone) {
    const res = await mondayRequest(
      resolvedAccessToken,

      `
      query ($value: String!) {
        items_page_by_column_values(
          board_id: ${boardId},
          columns: [{ column_id: "${phoneColumnId}", column_values: [$value] }]
        ) {
          items {
            id
            name
          }
        }
      }
      `,
      { value: phone }
    )
    const items = res?.data?.items_page_by_column_values?.items
    if (res?.errors?.length || !items) {
      return {
        successful: false,
        returnMessage: {
          messageType: 'error',
          message: res?.errors?.[0]?.message || 'Failed to fetch contacts from Monday.',
          ttl: 3000
        }
      }
    }

    for (const item of items || []) {
      matchedContactInfo.push({
        id: item.id,
        name: item.name,
        phone
      })
    }
  }

  matchedContactInfo.push({
    id: 'createNewContact',
    name: 'Create new contact...',
    isNewContact: true
  })

  return {
    successful: true,
    matchedContactInfo
  }
}

module.exports = findContact;
