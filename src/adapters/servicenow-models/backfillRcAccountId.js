const { Op } = require('sequelize');
const { UserModel } = require('@app-connect/core/models/userModel');

// One-time proactive back-fill of each company's RingCentral Account ID.
//
// Existing companies hold a dummy rcAccountId, so we cannot rely on the value being null.
// The `isRcAccountId` flag is the source of truth: false/null means "still the dummy / not
// yet real", true means "real value already set". We therefore select companies by the flag,
// not by the rcAccountId value, and overwrite the dummy when we find a real id.
//
// The real, raw rcAccountId lives only in the core `users` table (captured at OAuth connect).
// The ServiceNow `companies`/`customer` tables do not carry it, so we join across the two
// databases in code, on `hostname` (the reliable key shared by both). For every not-yet-filled
// company, we copy the value from any connected user on the same hostname that has one, and
// mark the company filled. This fills every company that has at least one recently-connected
// user, instead of waiting for that user's first contact search.
//
// Companies where every connected user is "genuinely old" (no stored rcAccountId anywhere)
// cannot be filled here — there is no source value — and stay on the dummy until someone
// reconnects.
async function backfillCompanyRcAccountId(models) {
    // Companies not yet filled with a real value (flag is null or false).
    const pendingCompanies = await models.companies.findAll({
        where: { isRcAccountId: { [Op.or]: [null, false] } },
        attributes: ['id', 'hostname'],
        raw: true
    });

    if (pendingCompanies.length === 0) {
        return;
    }

    const hostnames = [...new Set(pendingCompanies.map((company) => company.hostname).filter(Boolean))];
    if (hostnames.length === 0) {
        return;
    }

    // Users (core DB) on those hostnames that carry a raw rcAccountId.
    const users = await UserModel.findAll({
        where: {
            hostname: { [Op.in]: hostnames },
            rcAccountId: { [Op.not]: null }
        },
        attributes: ['hostname', 'rcAccountId'],
        raw: true
    });

    // hostname -> first non-empty rcAccountId found for it.
    const rcAccountIdByHostname = new Map();
    for (const user of users) {
        if (user.rcAccountId && !rcAccountIdByHostname.has(user.hostname)) {
            rcAccountIdByHostname.set(user.hostname, user.rcAccountId);
        }
    }

    let filled = 0;
    for (const company of pendingCompanies) {
        const rcAccountId = rcAccountIdByHostname.get(company.hostname);
        if (!rcAccountId) {
            continue;
        }
        try {
            await models.companies.update(
                { rcAccountId, isRcAccountId: true },
                { where: { id: company.id } }
            );
            filled++;
        } catch (err) {
            console.log(`[backfill] could not fill company "${company.hostname}":`, err?.message);
        }
    }

    console.log(`[backfill] rcAccountId back-fill complete: filled ${filled} of ${pendingCompanies.length} pending companies`);
}

let backfillPromise = null;

// Runs the back-fill once per app start. Never throws: on failure it logs and clears the
// memory so a later start retries. Safe to run on every instance — it only touches companies
// whose flag is still unset, so once everything is filled it is effectively a no-op.
function runRcAccountIdBackfillOnce(models) {
    if (!backfillPromise) {
        backfillPromise = backfillCompanyRcAccountId(models).catch((err) => {
            console.log('[backfill] failed; will retry on next start:', err?.message);
            backfillPromise = null;
        });
    }
    return backfillPromise;
}

exports.backfillCompanyRcAccountId = backfillCompanyRcAccountId;
exports.runRcAccountIdBackfillOnce = runRcAccountIdBackfillOnce;
