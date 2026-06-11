async function unAuthorize() {
  return {
    returnMessage: {
      messageType: 'success',
      message: 'Disconnected from Monday',
      ttl: 3000
    }
  }
}

module.exports = unAuthorize;