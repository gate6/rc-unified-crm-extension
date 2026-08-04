// @ts-nocheck
// ServiceTitan job management.
//
// A ServiceTitan customer's work is organised into jobs, and dispatchers and technicians read a
// job's own notes rather than the customer's. So the call log form offers a Job dropdown: pick one
// of the customer's open jobs and the call is written to that job's notes IN ADDITION to the
// customer's, so the customer keeps a complete communication history either way.
//
// Everything job-related lives here — job/job-type lookup, option building, job creation, and the
// job-note read/write helpers — so the connector's index.ts stays focused on call and message
// logging. Nothing here imports the connector back: the caller passes in the resolved CRM base URL
// and credentials, which keeps this module free of circular requires and testable on its own.

const axios = require('axios');
const moment = require('moment');
const apiLog = require('../shared/apiLogger');
const { trackAnalytics } = require('../shared/analytics');

const serviceTitanApiClient = axios.create();
apiLog.installErrorInterceptor(serviceTitanApiClient, 'ServiceTitan');

// The statuses worth offering — a call is logged against work that is still open. ServiceTitan's
// `jobStatus` filter takes ONE value (not a comma-separated list), so each status is its own request.
const ACTIVE_JOB_STATUSES = ['Scheduled', 'Dispatched', 'InProgress', 'Hold'];

const JOB_OPTION_NONE = 'none';
const JOB_OPTION_CREATE_NEW = 'createNewJob';
const JOB_OPTION_NONE_TITLE = 'None (log to customer notes only)';
const JOB_OPTION_CREATE_NEW_TITLE = 'Create new job...';

// A job note cannot be edited or removed once written, so an updated log necessarily appends a new
// note and the job keeps every superseded version. This is a ServiceTitan limitation, not a gap
// here: GET /jpm/v2/tenant/{t}/jobs/{id}/notes returns notes as
//   { text, isPinned, createdById, createdOn, modifiedOn }
// with no id of any kind, so there is nothing to address a PATCH or DELETE to. Verified against the
// integration tenant on 2026-08-03. Do not add a delete-then-recreate pass — it cannot work.
// The customer note is the log's system of record and IS rewritten cleanly on every update.

// Job types are tenant-level and change rarely, but they are needed on every contact match to fill
// the job type dropdown. Cache them briefly so contact lookup stays fast.
const JOB_TYPE_CACHE_TTL_MS = 10 * 60 * 1000;
const jobTypeCache = new Map();
const jobTypeRequests = new Map();

// ---------------------------------------------------------------------------
// API bases and headers
// ---------------------------------------------------------------------------

// Customers live under ServiceTitan's crm/v2 area, but jobs live under jpm/v2, business units under
// settings/v2 and campaigns under marketing/v2. All four share the tenant's API host, so derive them
// from the one CRM base the connector already resolves rather than adding three more env vars that
// could drift out of sync with it — and with the integration-tenant override it applies.
function getApiBaseUrl(crmBaseUrl, area) {
    const base = String(crmBaseUrl ?? '');
    const derived = base.replace(/\/crm\/v2(?=\/tenant\b|\/?$)/, `/${area}/v2`);
    if (derived === base) {
        console.warn(`[ServiceTitan] cannot derive the ${area} API base from "${base}" — the configured CRM URI must contain /crm/v2. Job features will fail until it does.`);
    }
    return derived;
}

function getJpmBaseUrl(crmBaseUrl) {
    return getApiBaseUrl(crmBaseUrl, 'jpm');
}

function stHeaders(auth, stAppKey, extraHeaders) {
    return {
        Authorization: `Bearer ${auth}`,
        'ST-App-Key': stAppKey,
        ...extraHeaders
    };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function isJobLoggingEnabled(user) {
    return (user?.userSettings?.logCallToJob?.value ?? true) === true;
}

// Raising work from a phone call is a bigger commitment than filing a note against it, so creating
// jobs is off unless an admin turns it on.
function isJobCreationEnabled(user) {
    return (user?.userSettings?.allowCreateJob?.value ?? false) === true;
}

// The job type an interaction falls back to when nobody picked a job — the case that matters most,
// since automatic logging never shows a form for anyone to pick from.
function getDefaultJobTypeName(user) {
    return String(user?.userSettings?.defaultJobName?.value ?? '').trim();
}

// The default is typed by hand into a settings text field, so it is matched forgivingly: case and
// spacing are ignored, the same leniency ServiceNow documents for its typed state/type defaults.
function normalizeJobTypeName(name) {
    return String(name ?? '').toLowerCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

async function fetchJobTypes({ crmBaseUrl, tenantId, auth, stAppKey }) {
    const cached = jobTypeCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.jobTypes;
    }
    // Matching a contact can ask for job types twice at once — to name the customer's jobs and to
    // fill the job type dropdown — so the in-flight request is shared as well as the result;
    // otherwise a cold cache fires the same call twice on every contact match.
    let inFlight = jobTypeRequests.get(tenantId);
    if (!inFlight) {
        const fetchJobTypesUrl = `${getJpmBaseUrl(crmBaseUrl)}/${tenantId}/job-types?active=true&pageSize=200`;
        inFlight = serviceTitanApiClient
            .get(fetchJobTypesUrl, { headers: stHeaders(auth, stAppKey), _operation: 'fetchJobTypes' })
            .then(res => {
                const jobTypes = (res.data?.data ?? []).map(jobType => ({ id: jobType.id, name: jobType.name }));
                jobTypeCache.set(tenantId, { expiresAt: Date.now() + JOB_TYPE_CACHE_TTL_MS, jobTypes });
                return jobTypes;
            })
            .finally(() => jobTypeRequests.delete(tenantId));
        jobTypeRequests.set(tenantId, inFlight);
    }
    return inFlight;
}

async function fetchActiveJobs({ crmBaseUrl, tenantId, auth, stAppKey, customerId }) {
    if (!customerId) return [];

    const jpmBaseUrl = getJpmBaseUrl(crmBaseUrl);
    // One status failing (a tenant that doesn't use Hold, say) must not cost us the others.
    const responses = await Promise.all(ACTIVE_JOB_STATUSES.map(status =>
        serviceTitanApiClient.get(
            `${jpmBaseUrl}/${tenantId}/jobs?customerId=${customerId}&jobStatus=${status}&pageSize=50`,
            { headers: stHeaders(auth, stAppKey), _operation: 'fetchActiveJobs' }
        ).catch(err => {
            console.warn(`[ServiceTitan] fetchActiveJobs: ${status} lookup failed:`, err?.response?.data || err.message);
            return null;
        })
    ));

    const jobs = [];
    const seenIds = new Set();
    for (const res of responses) {
        for (const job of res?.data?.data ?? []) {
            if (seenIds.has(job.id)) continue;
            seenIds.add(job.id);
            jobs.push(job);
        }
    }

    // A job carries only jobTypeId; the agent needs the readable type name to tell jobs apart.
    let jobTypeNames = new Map();
    try {
        jobTypeNames = new Map((await fetchJobTypes({ crmBaseUrl, tenantId, auth, stAppKey })).map(t => [t.id, t.name]));
    } catch (err) {
        console.warn('[ServiceTitan] fetchActiveJobs: job type lookup failed:', err?.response?.data || err.message);
    }
    for (const job of jobs) {
        job.jobTypeName = jobTypeNames.get(job.jobTypeId) || 'Job';
    }

    return jobs;
}

// ---------------------------------------------------------------------------
// Form options
// ---------------------------------------------------------------------------

function buildJobOptions({ jobs, allowCreate, defaultJobTypeName }) {
    const options = [
        // With a default job type configured, "no choice" is not the same as "no job" — so the first
        // option says what leaving it alone will actually do rather than claiming customer-only.
        defaultJobTypeName
            ? {
                const: JOB_OPTION_NONE,
                title: `Default: ${defaultJobTypeName}`,
                description: `Uses the customer's open ${defaultJobTypeName} job, or opens one`
            }
            : { const: JOB_OPTION_NONE, title: JOB_OPTION_NONE_TITLE },
        ...jobs.map(job => ({
            const: String(job.id),
            title: `#${job.jobNumber || job.id} - ${job.jobTypeName}`,
            description: job.jobStatus || job.status || ''
        }))
    ];
    // "Create new job" goes last, after every existing job, so linking the job the caller is
    // actually phoning about stays at the top of the list and raising new work is a deliberate
    // scroll rather than a mis-click.
    if (allowCreate) {
        options.push({
            const: JOB_OPTION_CREATE_NEW,
            title: JOB_OPTION_CREATE_NEW_TITLE,
            description: 'Pick the work in the Job type dropdown'
        });
    }
    return options;
}

// The Job and Job type dropdowns are `contactDependent`, so their options have to travel back
// attached to the matched contact. A job lookup problem must never cost us the contact match, so
// every failure degrades to a customer-notes-only dropdown.
async function buildJobAdditionalInfo({ user, crmBaseUrl, tenantId, auth, stAppKey, customerId, logPrefix }) {
    if (!isJobLoggingEnabled(user)) {
        return null;
    }
    const allowCreate = isJobCreationEnabled(user);
    try {
        const [jobs, jobTypes] = await Promise.all([
            fetchActiveJobs({ crmBaseUrl, tenantId, auth, stAppKey, customerId }),
            // Job types are only ever used to raise new work, so skip the lookup entirely when an
            // admin has not enabled that.
            allowCreate
                ? fetchJobTypes({ crmBaseUrl, tenantId, auth, stAppKey }).catch(() => [])
                : Promise.resolve([])
        ]);
        return {
            associatedJob: buildJobOptions({ jobs, allowCreate, defaultJobTypeName: getDefaultJobTypeName(user) }),
            newJobType: jobTypes.map(jobType => ({ const: String(jobType.id), title: jobType.name }))
        };
    } catch (err) {
        console.warn(`${logPrefix} failed to load jobs for customer ${customerId}:`, err?.response?.data || err.message);
        return {
            associatedJob: [{ const: JOB_OPTION_NONE, title: JOB_OPTION_NONE_TITLE }],
            newJobType: []
        };
    }
}

// ---------------------------------------------------------------------------
// Job creation
// ---------------------------------------------------------------------------

async function resolveNewJobLocationId({ crmBaseUrl, tenantId, auth, stAppKey, customerId }) {
    const locationsUrl = `${crmBaseUrl}/${tenantId}/locations?customerId=${customerId}&active=true&pageSize=1`;
    const res = await serviceTitanApiClient.get(
        locationsUrl,
        { headers: stHeaders(auth, stAppKey), _operation: 'createJob' }
    );
    return res.data?.data?.[0]?.id ?? null;
}

async function resolveNewJobBusinessUnitId({ user, crmBaseUrl, tenantId, auth, stAppKey, existingJobs }) {
    const configured = String(user.userSettings?.newJobBusinessUnitId?.value ?? '').trim();
    if (configured) return configured;
    // Prefer the unit the customer's existing work already sits in, so the new job lands with the
    // crew the caller is most likely phoning about.
    const fromExistingJob = existingJobs?.find(job => job.businessUnitId)?.businessUnitId;
    if (fromExistingJob) return fromExistingJob;

    const businessUnitsUrl = `${getApiBaseUrl(crmBaseUrl, 'settings')}/${tenantId}/business-units?active=true&pageSize=1`;
    const res = await serviceTitanApiClient.get(
        businessUnitsUrl,
        { headers: stHeaders(auth, stAppKey), _operation: 'createJob' }
    );
    return res.data?.data?.[0]?.id ?? null;
}

async function resolveNewJobCampaignId({ user, crmBaseUrl, tenantId, auth, stAppKey }) {
    const configured = String(user.userSettings?.newJobCampaignId?.value ?? '').trim();
    if (configured) return configured;

    const campaignsUrl = `${getApiBaseUrl(crmBaseUrl, 'marketing')}/${tenantId}/campaigns?active=true&pageSize=1`;
    const res = await serviceTitanApiClient.get(
        campaignsUrl,
        { headers: stHeaders(auth, stAppKey), _operation: 'createJob' }
    );
    return res.data?.data?.[0]?.id ?? null;
}

// ServiceTitan will not create a job without a business unit, job type, campaign, location and an
// appointment window — far more than a call log form should ask an agent for mid-call. So the agent
// picks only the job type, and the rest resolves from the connector's job-defaults settings, then
// the customer's existing work, then the tenant's first active record.
async function createJobForCustomer({ user, crmBaseUrl, tenantId, auth, stAppKey, customerId, jobTypeId, existingJobs, summary }) {
    const [locationId, businessUnitId, campaignId] = await Promise.all([
        resolveNewJobLocationId({ crmBaseUrl, tenantId, auth, stAppKey, customerId }),
        resolveNewJobBusinessUnitId({ user, crmBaseUrl, tenantId, auth, stAppKey, existingJobs }),
        // Campaign is the one field ServiceTitan sometimes accepts as absent, so a lookup failure
        // is not fatal — try the create without it and let ServiceTitan be the judge.
        resolveNewJobCampaignId({ user, crmBaseUrl, tenantId, auth, stAppKey }).catch(err => {
            console.warn('[ServiceTitan] createJobForCustomer: campaign lookup failed:', err?.response?.data || err.message);
            return null;
        })
    ]);

    if (!locationId) {
        throw new Error('the customer has no active service location');
    }
    if (!businessUnitId) {
        throw new Error('no business unit could be resolved — set a default in the ServiceTitan job defaults settings');
    }

    const appointmentMinutes = Number(user.userSettings?.newJobAppointmentDuration?.value) || 60;
    const appointmentStart = moment();
    const payload = {
        customerId: Number(customerId),
        locationId: Number(locationId),
        businessUnitId: Number(businessUnitId),
        jobTypeId: Number(jobTypeId),
        priority: user.userSettings?.newJobPriority?.value || 'Normal',
        campaignId: campaignId == null ? undefined : Number(campaignId),
        summary,
        appointments: [{
            start: appointmentStart.toISOString(),
            end: appointmentStart.clone().add(appointmentMinutes, 'minutes').toISOString()
        }]
    };

    const createJobUrl = `${getJpmBaseUrl(crmBaseUrl)}/${tenantId}/jobs`;
    const res = await serviceTitanApiClient.post(
        createJobUrl,
        payload,
        { headers: stHeaders(auth, stAppKey, { 'Content-Type': 'application/json' }), _operation: 'createJob' }
    );

    apiLog.logSuccess('ServiceTitan', 'createJob', { jobId: res.data?.id, customerId, jobTypeId, apiEndpoint: createJobUrl });
    await trackAnalytics({ user, crm: 'ServiceTitan', event: 'jobCreated' });
    return res.data;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

// Applied when nobody picked a job. Automatic call logging is the reason this exists: it writes the
// log with no form and therefore no selection, so without a default every auto-logged call would
// land on the customer only, never on the work it was about.
//
// The setting holds a job TYPE name. An open job of that type is reused when the customer has one —
// several calls about the same visit then collect on one job — and a new job of that type is opened
// when they do not.
async function resolveDefaultJob({ user, crmBaseUrl, tenantId, auth, stAppKey, customerId, newJobSummary }) {
    const defaultJobTypeName = getDefaultJobTypeName(user);
    if (!defaultJobTypeName) {
        return { jobId: null };
    }
    const wanted = normalizeJobTypeName(defaultJobTypeName);

    try {
        const activeJobs = await fetchActiveJobs({ crmBaseUrl, tenantId, auth, stAppKey, customerId });
        const openJob = activeJobs.find(job => normalizeJobTypeName(job.jobTypeName) === wanted);
        if (openJob) {
            return { jobId: openJob.id };
        }

        const jobType = (await fetchJobTypes({ crmBaseUrl, tenantId, auth, stAppKey }))
            .find(type => normalizeJobTypeName(type.name) === wanted);
        if (!jobType) {
            // Worth a loud warning: the setting is free text, so a typo here silently costs every
            // auto-logged call its job for as long as it goes unnoticed.
            console.warn(`[ServiceTitan] resolveDefaultJob: no active job type matches the configured default job "${defaultJobTypeName}" — check the spelling in settings.`);
            return { jobId: null, warning: `No job type called "${defaultJobTypeName}" exists, so it was logged to the customer only.` };
        }

        const job = await createJobForCustomer({
            user, crmBaseUrl, tenantId, auth, stAppKey, customerId,
            jobTypeId: jobType.id,
            existingJobs: activeJobs,
            summary: newJobSummary || 'Opened from a RingCentral interaction.'
        });
        return { jobId: job.id, createdJobNumber: job.jobNumber || job.id };
    } catch (err) {
        const detail = err?.response?.data?.title || err?.response?.data?.message || err.message;
        console.warn('[ServiceTitan] resolveDefaultJob: could not resolve the default job:', err?.response?.data || err.message);
        return { jobId: null, warning: `Could not use the default job (${detail}). It was logged to the customer only.` };
    }
}

// Works out which job a log should additionally be written to. Never throws and never blocks the
// log: any job problem returns a null job with a warning, because the call detail always reaches
// the customer's notes regardless and losing it would be far worse than filing it one level up.
async function resolveTargetJob({ user, crmBaseUrl, tenantId, auth, stAppKey, customerId, additionalSubmission, newJobSummary }) {
    if (!isJobLoggingEnabled(user)) {
        return { jobId: null };
    }

    // No pick covers both an agent leaving the dropdown alone and automatic logging, which submits
    // nothing at all — the configured default (if any) decides for both.
    const selected = additionalSubmission?.associatedJob;
    if (!selected || selected === JOB_OPTION_NONE) {
        return resolveDefaultJob({ user, crmBaseUrl, tenantId, auth, stAppKey, customerId, newJobSummary });
    }

    if (selected === JOB_OPTION_CREATE_NEW) {
        if (!isJobCreationEnabled(user)) {
            return { jobId: null, warning: 'Creating jobs is switched off, so it was logged to the customer only.' };
        }
        const jobTypeId = additionalSubmission?.newJobType;
        if (!jobTypeId) {
            return { jobId: null, warning: 'No job type was chosen, so it was logged to the customer only.' };
        }
        try {
            const existingJobs = await fetchActiveJobs({ crmBaseUrl, tenantId, auth, stAppKey, customerId }).catch(() => []);
            const job = await createJobForCustomer({
                user, crmBaseUrl, tenantId, auth, stAppKey, customerId, jobTypeId, existingJobs,
                summary: newJobSummary || 'Opened from a RingCentral interaction.'
            });
            return { jobId: job.id, createdJobNumber: job.jobNumber || job.id };
        } catch (err) {
            const detail = err?.response?.data?.title || err?.response?.data?.message || err.message;
            console.warn('[ServiceTitan] resolveTargetJob: job creation failed:', err?.response?.data || err.message);
            return { jobId: null, warning: `Could not create the job (${detail}). It was logged to the customer only.` };
        }
    }

    // The dropdown options were cached when the contact matched, so the job may have closed since.
    try {
        const activeJobs = await fetchActiveJobs({ crmBaseUrl, tenantId, auth, stAppKey, customerId });
        if (!activeJobs.some(job => String(job.id) === String(selected))) {
            return { jobId: null, warning: 'That job is no longer active, so it was logged to the customer only.' };
        }
    } catch (err) {
        console.warn('[ServiceTitan] resolveTargetJob: could not verify the selected job:', err?.response?.data || err.message);
        return { jobId: null, warning: 'The selected job could not be verified, so it was logged to the customer only.' };
    }

    return { jobId: selected };
}

// ---------------------------------------------------------------------------
// Job notes
// ---------------------------------------------------------------------------

async function postJobNote({ crmBaseUrl, tenantId, auth, stAppKey, jobId, text, operation }) {
    return serviceTitanApiClient.post(
        `${getJpmBaseUrl(crmBaseUrl)}/${tenantId}/jobs/${jobId}/notes`,
        { text },
        { headers: stHeaders(auth, stAppKey, { 'Content-Type': 'application/json' }), _operation: operation }
    );
}

// ---------------------------------------------------------------------------
// Log ids
//
// A log id doubles as the ServiceTitan page path that "view log" opens:
//   job log      ->  Job/Index/{jobId}     ->  https://<host>/#/Job/Index/2689328
//   customer log ->  customer/{contactId}  ->  https://<host>/#/customer/2673343
//
// App Connect substitutes {logId} into ONE fixed `logPageUrl` template with no way to branch on the
// kind of log, and the two ServiceTitan pages have different path shapes — so carrying the path in
// the id is the only way the link can reach the right page. That leaves no room for the customer
// note id, which is why the note is located by the call's session id instead (see the connector's
// findCallLogNote). Nor is the id unique per call — several calls share a job — so nothing may look
// a log up by it; getCallLog resolves through telephonySessionId, the CallLogModel primary key.
// ---------------------------------------------------------------------------

function buildJobLogId(jobId) {
    return `Job/Index/${jobId}`;
}

function buildCustomerLogId(contactId) {
    return `customer/${contactId}`;
}

function parseLogId(thirdPartyLogId) {
    const raw = String(thirdPartyLogId ?? '');

    const jobMatch = raw.match(/^Job\/Index\/(\d+)$/);
    if (jobMatch) {
        return { logType: 'job', jobId: jobMatch[1], legacyNoteId: null };
    }
    if (/^customer\/\d+$/.test(raw)) {
        return { logType: 'note', jobId: null, legacyNoteId: null };
    }

    // Ids written before the path scheme: `{noteId}_note` and `{customerNoteId}_{jobId}_jobnote`.
    // Their first segment is a real customer note id, so it still resolves a note directly.
    const [first, second, third] = raw.split('_');
    if (third === 'jobnote') {
        return { logType: 'job', jobId: second, legacyNoteId: first };
    }
    return { logType: 'note', jobId: null, legacyNoteId: first || null };
}

module.exports = {
    ACTIVE_JOB_STATUSES,
    JOB_OPTION_NONE,
    JOB_OPTION_CREATE_NEW,
    getApiBaseUrl,
    getJpmBaseUrl,
    stHeaders,
    isJobLoggingEnabled,
    isJobCreationEnabled,
    getDefaultJobTypeName,
    resolveDefaultJob,
    fetchJobTypes,
    fetchActiveJobs,
    buildJobOptions,
    buildJobAdditionalInfo,
    createJobForCustomer,
    resolveTargetJob,
    postJobNote,
    buildJobLogId,
    buildCustomerLogId,
    parseLogId
};

export {};
