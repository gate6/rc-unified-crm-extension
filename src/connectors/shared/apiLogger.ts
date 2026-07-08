// Shared API logging for all Gate6 connectors — consistent, traceable logs for
// future debugging.
//
// Usage in a connector:
//   const apiLog = require('../shared/apiLogger');
//   const client = axios.create();
//   apiLog.installErrorInterceptor(client, 'ServiceTitan');   // once, after create
//
//   // inside an operation:
//   apiLog.logStart('ServiceTitan', 'createCallLog', { contactId, direction });
//   const res = await client.post(url, body, { headers, _operation: 'createCallLog' });
//   apiLog.logSuccess('ServiceTitan', 'createCallLog', { logId, apiEndpoint: url });
//
// Tag each axios call config with `_operation` so the error interceptor can attribute
// a failure to the right function. The error interceptor logs the REQUEST body too —
// the one thing needed to diagnose rejected writes (a 4xx tells you little without it).

function truncate(value, maxLength = 1200) {
  if (value === undefined || value === null) return value;
  try {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return str.length > maxLength ? `${str.slice(0, maxLength)}...` : str;
  } catch (e) {
    return String(value);
  }
}

// Install a response interceptor that logs only on error, with both the request and
// response bodies. Never logs Authorization/headers (avoids credential leakage).
function installErrorInterceptor(client, platformTag) {
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      const config = error?.config || {};
      console.error(`[${platformTag}][apiError]`, {
        operation: config._operation || 'unknown',
        method: (config.method || 'GET').toUpperCase(),
        url: config.url || '',
        status: error?.response?.status ?? null,
        requestBody: truncate(config.data),
        responseBody: truncate(error?.response?.data),
        message: error?.message || '',
        timestamp: new Date().toISOString()
      });
      return Promise.reject(error);
    }
  );
}

function logStart(platformTag, operation, context = {}) {
  console.log(`[${platformTag}][${operation}] started`, { ...context, timestamp: new Date().toISOString() });
}

function logSuccess(platformTag, operation, context = {}) {
  console.log(`[${platformTag}][${operation}] success`, { ...context, timestamp: new Date().toISOString() });
}

exports.truncate = truncate;
exports.installErrorInterceptor = installErrorInterceptor;
exports.logStart = logStart;
exports.logSuccess = logSuccess;

export {};
