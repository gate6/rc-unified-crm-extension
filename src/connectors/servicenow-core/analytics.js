const Sequelize = require('sequelize');
const { sequelize } = require('../servicenow-models/sequelize');
const { initModels } = require('../servicenow-models/init-models');

const models = sequelize ? initModels(sequelize) : null;

const EVENT_COLUMNS = {
  callLogCreated: 'callLogsCreated',
  callLogUpdated: 'callLogsUpdated',
  messageLogCreated: 'messageLogsCreated',
  messageLogUpdated: 'messageLogsUpdated',
  contactCreated: 'contactsCreated'
};

const EVENT_MESSAGES = {
  callLogCreated: 'Call log created successfully and inserted in analytics',
  callLogUpdated: 'Call log updated successfully and inserted in analytics',
  messageLogCreated: 'Message log created successfully and inserted in analytics',
  messageLogUpdated: 'Message log updated successfully and inserted in analytics',
  contactCreated: 'Contact created successfully and inserted in analytics'
};

let analyticsTableReadyPromise;

function getUserValue(user, key) {
  return user?.[key] ?? user?.dataValues?.[key] ?? null;
}

function getAnalyticsDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

async function ensureAnalyticsTable() {
  if (!models?.analytics) return false;
  if (!analyticsTableReadyPromise) {
    analyticsTableReadyPromise = (async () => {
      await models.analytics.sync();

      const queryInterface = sequelize.getQueryInterface();
      const tableDefinition = await queryInterface.describeTable('analytics');

      if (!tableDefinition.analyticsDate) {
        await queryInterface.addColumn('analytics', 'analyticsDate', {
          type: Sequelize.DATEONLY,
          allowNull: true
        });
        console.log('[Analytics] Added analyticsDate column to analytics table');
      }
    })().catch((error) => {
      analyticsTableReadyPromise = null;
      throw error;
    });
  }
  await analyticsTableReadyPromise;
  return true;
}

async function findCompany({ hostname, rcAccountId }) {
  if (!models?.companies || !hostname) return null;

  if (rcAccountId) {
    const company = await models.companies.findOne({
      where: {
        hostname,
        rcAccountId
      }
    });
    if (company) return company;

    return models.companies.findOne({
      where: {
        hostname,
        rcAccountId: {
          [Sequelize.Op.is]: null
        }
      }
    });
  }

  return models.companies.findOne({
    where: {
      hostname
    }
  });
}

async function getRegisteredUsers(companyId) {
  if (!models?.customer || !companyId) return 0;
  return models.customer.count({
    where: {
      companyId
    }
  });
}

async function getAnalyticsRow({ company, hostname, rcAccountId, crm, analyticsDate }) {
  const companyId = company?.id ?? company?.dataValues?.id ?? null;
  const where = companyId
    ? { companyId, crm, analyticsDate }
    : {
      hostname,
      crm,
      rcAccountId: rcAccountId || null,
      analyticsDate
    };

  const existing = await models.analytics.findOne({ where });
  if (existing) return existing;

  return models.analytics.create({
    companyId,
    companyName: company?.companyName ?? company?.dataValues?.companyName ?? null,
    hostname,
    rcAccountId: rcAccountId || null,
    crm,
    analyticsDate,
    registeredUsers: companyId ? await getRegisteredUsers(companyId) : 0
  });
}

async function trackAnalytics({ user, crm, event, eventDate }) {
  try {
    const eventColumn = EVENT_COLUMNS[event];
    if (!eventColumn || !crm || !models) return;

    await ensureAnalyticsTable();

    const hostname = getUserValue(user, 'hostname');
    const rcAccountId = getUserValue(user, 'rcAccountId');
    if (!hostname) return;

    const analyticsDate = getAnalyticsDate(eventDate);
    const company = await findCompany({ hostname, rcAccountId });
    const companyId = company?.id ?? company?.dataValues?.id ?? null;
    const registeredUsers = await getRegisteredUsers(companyId);
    const analytics = await getAnalyticsRow({ company, hostname, rcAccountId, crm, analyticsDate });

    await analytics.increment({
      [eventColumn]: 1,
      totalEvents: 1
    });

    await models.analytics.update({
      companyId,
      companyName: company?.companyName ?? company?.dataValues?.companyName ?? null,
      hostname,
      rcAccountId: rcAccountId || null,
      analyticsDate,
      registeredUsers,
      lastEventAt: Sequelize.fn('NOW')
    }, {
      where: {
        id: analytics.id
      }
    });

    console.log('[Analytics]', EVENT_MESSAGES[event], {
      crm,
      companyName: company?.companyName ?? company?.dataValues?.companyName ?? null,
      hostname,
      rcAccountId: rcAccountId || null,
      analyticsDate,
      counter: eventColumn
    });
  } catch (error) {
    console.error('[Analytics] Failed to track connector event', {
      crm,
      event,
      message: error?.message || error
    });
  }
}

module.exports = {
  trackAnalytics
};
