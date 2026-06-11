const { AccountDataModel } = require('@app-connect/core/models/accountDataModel');
const {
  mondayRequest,
  getColumnIdByName,
  normalizePhone,
  generatePhoneFormats,
  getCompanyByHostname,
  validateLicenseOrFail
} = require('../utils/mondayHelpers');

async function findContact({ phoneNumber, accessToken, authHeader, user }) {
  const licenseError = await validateLicenseOrFail(user);
  if (licenseError) return licenseError;

  const company = await getCompanyByHostname({
    hostname: user.dataValues.hostname
  });
  const boardId = company.tenantId;
  const phone = normalizePhone(phoneNumber);
  const matchedContactInfo = [];
  const resolvedAccessToken = authHeader?.replace('Bearer ', '') || accessToken || user?.accessToken;
  const phoneColumnId = await getColumnIdByName({
    accessToken: resolvedAccessToken,
    boardId: boardId,
    columnName: 'Phone'
  });
  console.log('phoneColumnId', phoneColumnId);
  if (!phoneColumnId) {
    return {
      successful: false,
      returnMessage: {
        messageType: 'error',
        message: 'Monday phone column not found. Set MONDAY_PHONE_COLUMN_ID or MONDAY_PHONE_COLUMN_NAME.',
        ttl: 3000
      }
    };
  }

  if (phone) {
    // Monday phone column stores as JSON {phone, countryShortName} — try all common formats
    const phoneFallbacks = generatePhoneFormats(phone);

    let items = [];
    for (const searchValue of phoneFallbacks) {
      const res = await mondayRequest(
        resolvedAccessToken,
        `
        query ($value: String!) {
          items_page_by_column_values(
            board_id: ${boardId},
            columns: [{ column_id: "${phoneColumnId}", column_values: [$value] }]
          ) {
            items { id name }
          }
        }
        `,
        { value: searchValue }
      );
      if (res?.errors?.length) {
        return {
          successful: false,
          returnMessage: {
            messageType: 'error',
            message: res.errors[0].message || 'Failed to fetch contacts from Monday.',
            ttl: 3000
          }
        };
      }
      items = res?.data?.items_page_by_column_values?.items || [];
      if (items.length > 0) {
        console.log('[Monday] findContact: matched', items.length, 'contact(s) with format:', searchValue);
        break;
      }
    }

    for (const item of items) {
      matchedContactInfo.push({
        id: item.id,
        name: item.name,
        phone
      });
    }

    // No real contacts found in Monday — delete stale cache entry if it exists
    if (items.length === 0 && user?.rcAccountId) {
      try {
        const deleted = await AccountDataModel.destroy({
          where: {
            rcAccountId: user.rcAccountId,
            platformName: 'monday',
            dataKey: `contact-${phoneNumber}`
          }
        });
        if (deleted > 0) {
          console.log('[Monday] findContact: deleted stale cache for phone:', phoneNumber);
        }
      } catch (err) {
        console.warn('[Monday] findContact: failed to delete stale cache:', err.message);
      }
    }
  }

  matchedContactInfo.push({
    id: 'createNewContact',
    name: 'Create new contact...',
    isNewContact: true
  });

  return {
    successful: true,
    matchedContactInfo
  };
}

module.exports = findContact;
