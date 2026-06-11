const { CallLogModel } = require('@app-connect/core/models/callLogModel');
const { getRefreshedAuthToken, validateLicenseOrFail, serviceTitanApiClient } = require('../utils/serviceTitanHelpers');

const SERVICE_TITAN_CRM_URL = 'https://api-integration.servicetitan.io/crm/v2/tenant';
const SERVICE_TITAN_JPM_URL = 'https://api-integration.servicetitan.io/jpm/v2/tenant';

/**
 * Parses the plain-text note body written by createCallLog / updateCallLog.
 *
 * Expected format:
 *   Subject: <value>
 *   Direction: <value>
 *   Start Time: <value>
 *   End Time: <value>
 *
 *   Agent Notes:
 *   <note text — may be multi-line with blank lines>
 *
 *   Result:
 *   ...
 */
function parseNoteBody(body) {
    const normalized = body.replace(/\r\n/g, '\n');

    // Extract Subject — single line value after "Subject:"
    const subjectMatch = normalized.match(/Subject:\s*([^\n]*)/);
    let subject = subjectMatch?.[1]?.trim() || '';
    // Guard: if subject accidentally bled into the next field, clear it
    if (subject.toLowerCase().startsWith('direction:')) {
        subject = '';
    }

    // Extract Agent Notes — NO multiline flag so $ = true end-of-string.
    // Captures everything after "Agent Notes:\n" until the next section header
    // (a line ending with ":\n", e.g. "Result:\n") or end of string.
    const agentMatch = normalized.match(/Agent Notes:\n([\s\S]*?)(?=\n[A-Za-z][^\n]*:\n|$)/);
    const note = agentMatch?.[1]?.trim() || '';

    return { subject, note };
}

async function getCallLog({ user, callLogId, authHeader }) {
    const licenseError = await validateLicenseOrFail(user);
    if (licenseError) return licenseError;

    const [realId, logType = 'note'] = callLogId.split('_');

    const auth = await getRefreshedAuthToken(user);
    const tenantId = user.dataValues.platformAdditionalInfo.tenant;
    const stAppKey = user.dataValues.platformAdditionalInfo.st_app_key;

    let subject = '';
    let note = '';
    let full_data = {};

    try {

        // ---------------- JOB LOG ----------------
        if (logType === 'job') {

            const jobRes = await serviceTitanApiClient.get(
                `${SERVICE_TITAN_JPM_URL}/${tenantId}/jobs/${realId}`,
                {
                    headers: {
                        Authorization: `Bearer ${auth}`,
                        'ST-App-Key': stAppKey
                    }
                }
            );

            const summary = jobRes.data?.summary || '';
            if (summary) {
                ({ subject, note } = parseNoteBody(summary));
                full_data = { subject, description: summary };
            }
        }

        // ---------------- NOTE LOG ----------------
        else {

            const existingCallLogDetails = await CallLogModel.findOne({
                where: { thirdPartyLogId: callLogId }
            });

            if (!existingCallLogDetails) {
                console.error(`[getCallLog] No DB record found for thirdPartyLogId: ${callLogId}`);
                return { callLogInfo: { subject: '', note: '', fullLogResponse: {} } };
            }

            const { contactId } = existingCallLogDetails.dataValues;

            const getLogRes = await serviceTitanApiClient.get(
                `${SERVICE_TITAN_CRM_URL}/${tenantId}/customers/${contactId}/notes`,
                {
                    headers: {
                        Authorization: `Bearer ${auth}`,
                        'ST-App-Key': stAppKey
                    }
                }
            );

            if (Array.isArray(getLogRes.data?.data)) {
                const targetLog = getLogRes.data.data.find(log => log.id == realId);

                if (targetLog?.text) {
                    ({ subject, note } = parseNoteBody(targetLog.text));
                    full_data = targetLog.text;
                }
            }
        }

    } catch (error) {
        console.error(
            `[getCallLog] Failed to fetch call log for ${callLogId}:`,
            error?.response?.data || error.message
        );
    }

    return {
        callLogInfo: {
            subject,
            note,
            fullLogResponse: full_data
        }
    };
}

module.exports = getCallLog;
