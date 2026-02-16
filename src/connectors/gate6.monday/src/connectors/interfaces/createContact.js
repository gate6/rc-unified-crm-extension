const { initModels } = require('../../monday-models/init-models');
const { sequelize } = require('../../monday-models/sequelize');
const models = initModels(sequelize);
const { mondayRequest, getColumnIdByName, getCompanyByHostname } = require('../utils/mondayHelpers');

async function createContact({ phoneNumber, newContactName, accessToken, authHeader, user }) {
  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname,
    models
  })
  const boardId = company.tenantId
  console.log('boardId', boardId)

  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken
  const phoneColumnId = await getColumnIdByName({
    accessToken: resolvedAccessToken,
    boardId: boardId,
    columnName: 'Phone'
  })
  if (!phoneColumnId) {
    return {
      contactInfo: null,
      returnMessage: {
        messageType: 'error',
        message: 'Monday phone column not found. Set MONDAY_PHONE_COLUMN_ID or MONDAY_PHONE_COLUMN_NAME.',
        ttl: 3000
      }
    }
  }

  const res = await mondayRequest(
    resolvedAccessToken,

    `
    mutation ($name: String!, $values: JSON!) {
      create_item(
        board_id: ${boardId},
        item_name: $name,
        column_values: $values
      ) {
        id
        name
      }
    }
    `,
    {
      name: newContactName,
      values: JSON.stringify({
        [phoneColumnId]: phoneNumber
      })
    }
  )

  return {
    contactInfo: {
      id: res.data.create_item.id,
      name: res.data.create_item.name
    },
    returnMessage: {
      messageType: 'success',
      message: 'New contact created',
      ttl: 3000
    }
  }
}

module.exports = createContact;