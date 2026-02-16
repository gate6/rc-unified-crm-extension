async function upsertCallDisposition({ existingCallLog }) {
  return { logId: existingCallLog.thirdPartyLogId }
}

module.exports = upsertCallDisposition;