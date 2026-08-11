// @ts-nocheck
// Monday GraphQL transport.
//
// Everything that talks to Monday goes through here: the axios instance, the retrying request
// wrapper, the GraphQL error contract, and the board-column lookup cache. It is shared by the
// connector (src/connectors/monday/index.ts) and the work-management module (projects.ts), so
// neither has to duplicate the retry/logging rules — and projects.ts can stay free of a circular
// require back into the connector.

const axios = require('axios');
const apiLog = require('../shared/apiLogger');

// A per-request timeout so a slow/hanging Monday call fails fast instead of blocking
// findContact (the contact-existence check) until the extension itself times out and
// aborts the whole "create new contact + log" flow. On timeout the request rejects, the
// caller's try/catch treats it as "no match", and the create prompt still appears.
const MONDAY_REQUEST_TIMEOUT_MS = 12000;
const mondayApiClient = axios.create({ timeout: MONDAY_REQUEST_TIMEOUT_MS });

apiLog.installErrorInterceptor(mondayApiClient, 'Monday');

// Read the API url per call rather than at module load: tests (and the server's own env loading)
// set it after this module is first required, and a load-time snapshot would freeze in an empty
// value for the life of the process.
function getMondayApiUrl() {
  return process.env.MONDAY_API_URL;
}

function stringifyForLog(value, maxLength = 1200) {
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
  } catch (error) {
    return String(value);
  }
}

// Monday update/item IDs are numeric. A non-numeric stored thirdPartyLogId (e.g. a
// hash from a stale record) is invalid and must not be sent to the API.
function isNumericMondayId(id) {
  return id != null && /^\d+$/.test(String(id));
}

let mondayApiCallCounter = 0;

// Extract the GraphQL operation kind + first root field for concise logging.
function describeGraphqlOperation(query) {
  const text = String(query || '');
  const kind = /\bmutation\b/.test(text) ? 'mutation' : 'query';
  const fieldMatch = text.match(/\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/);
  return `${kind} ${fieldMatch ? fieldMatch[1] : 'unknown'}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Monday's "monolith" backend intermittently returns INTERNAL_SERVER_ERROR (status_code
// 500) as a GraphQL error on otherwise-valid queries (commonly items_page_by_column_values).
// These are transient, so a short retry usually succeeds instead of degrading to "no match".
function hasTransientMondayError(errors) {
  return Array.isArray(errors) && errors.some((e) => {
    const code = e?.extensions?.code;
    const status = e?.extensions?.status_code;
    return code === 'INTERNAL_SERVER_ERROR' || (typeof status === 'number' && status >= 500);
  });
}

// `operation` names the connector function making the call (e.g. 'createCallLog') so every
// API log line is attributable — same idea as ServiceTitan's `_operation` axios tag.
//
// Error contract: transient failures (HTTP 5xx / timeout / network, or Monday's
// INTERNAL_SERVER_ERROR GraphQL errors) are retried up to `maxAttempts`. Once retries are
// exhausted, HTTP/transport errors are re-thrown to the caller; GraphQL errors are returned
// in the body (Monday sends them with HTTP 200) — callers that require data must check
// `res.errors` or use assertNoGraphqlErrors.
async function mondayRequest(accessToken, query, variables = {}, { maxAttempts = 2, operation = 'unknown' } = {}) {
  const apiUrl = getMondayApiUrl();
  if (!apiUrl) {
    throw new Error('MONDAY_API_URL is not configured on the server');
  }
  const reqId = ++mondayApiCallCounter;
  const op = describeGraphqlOperation(query);
  let lastBody = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    console.log(attempt === 1 ? '[Monday][api] →' : '[Monday][api] ↻ retry', { reqId, operation, op, attempt, ...(attempt === 1 ? { variables: stringifyForLog(variables, 600) } : {}) });
    try {
      const res = await mondayApiClient.post(
        apiUrl,
        { query, variables },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          _operation: operation
        }
      );
      const ms = Date.now() - startedAt;
      const body = res.data;
      lastBody = body;
      // Monday returns GraphQL errors with HTTP 200, so they bypass the axios
      // interceptor — surface them explicitly here.
      if (body?.errors?.length) {
        console.error('[Monday][api] ✗ GraphQL error', { reqId, operation, op, ms, attempt, variables: stringifyForLog(variables, 600), errors: stringifyForLog(body.errors, 1000) });
        if (hasTransientMondayError(body.errors) && attempt < maxAttempts) {
          await sleep(400 * attempt);
          continue;
        }
      } else {
        console.log('[Monday][api] ←', { reqId, operation, op, ms, dataKeys: body?.data ? Object.keys(body.data) : [] });
      }
      return body;
    } catch (err) {
      const ms = Date.now() - startedAt;
      const status = err?.response?.status || null;
      console.error('[Monday][api] ✗ HTTP error', { reqId, operation, op, ms, attempt, status, message: err?.message || '', variables: stringifyForLog(variables, 600), responseBody: stringifyForLog(err?.response?.data, 1000) });
      // Retry transient transport failures (5xx, timeout, network) too.
      const transient = !status || status >= 500 || err?.code === 'ECONNABORTED';
      if (transient && attempt < maxAttempts) {
        await sleep(400 * attempt);
        continue;
      }
      throw err;
    }
  }
  return lastBody;
}

// Throw a descriptive error when a GraphQL response carried errors but the caller
// expects data — keeps failures from surfacing as "Cannot read property of undefined".
function assertNoGraphqlErrors(res, context) {
  if (res?.errors?.length) {
    const message = res.errors.map(e => e?.message).filter(Boolean).join('; ') || 'Unknown Monday GraphQL error';
    throw new Error(`Monday ${context} failed: ${message}`);
  }
}

const columnIdCache = new Map();

async function getColumnIdByName({ accessToken, boardId, columnName, operation = 'getColumnIdByName' }) {
  if (!columnName) {
    return null
  }
  if (typeof columnName === 'string' && columnName.trim()) {
    const trimmedName = columnName.trim()
    if (trimmedName !== columnName) {
      columnName = trimmedName
    }
  }
  const cacheKey = `${boardId}:${columnName}`
  if (columnIdCache.has(cacheKey)) {
    return columnIdCache.get(cacheKey)
  }

  const res = await mondayRequest(
    accessToken,
    `
    query ($boardId: [ID!]) {
      boards(ids: $boardId) {
        columns {
          id
          title
        }
      }
    }
    `,
    { boardId: Number(boardId) },
    { operation }
  )
  const boardData = res?.data?.boards?.[0]
  const columns = boardData?.columns || []
  if (!columns.length) {
    console.log('Monday board lookup returned no columns', {
      boardId,
      errors: res?.errors,
      boardData
    })
  }

  const normalizedName = columnName?.toLowerCase()
  const matched = columns.find(col => {
    const title = col.title?.trim()?.toLowerCase()
    return title === normalizedName || col.id === columnName
  })

  if (matched?.id) {
    columnIdCache.set(cacheKey, matched.id)
    return matched.id
  }
  console.log('Monday column not found', {
    boardId,
    columnName,
    availableColumns: columns.map(col => ({ id: col.id, title: col.title }))
  })
  return null
}

module.exports = {
  MONDAY_REQUEST_TIMEOUT_MS,
  mondayApiClient,
  getMondayApiUrl,
  stringifyForLog,
  isNumericMondayId,
  mondayRequest,
  assertNoGraphqlErrors,
  columnIdCache,
  getColumnIdByName
};

export {};
