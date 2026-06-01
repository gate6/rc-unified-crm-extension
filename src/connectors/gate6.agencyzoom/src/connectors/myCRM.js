// Overview:
// 1. Try to play with it first. Login, make a call, log a call, edit its call logs etc. Most functionalities are working under mock data
// 2. Here it defaults to use 3 JSON files as mock data for CRM API responses, so data will be there for easy view
// 3. Modify and implement the interfaces to meet actual CRM APIs' requirements

// Note: Some interfaces are optional (marked below)

exports.getAuthType = require('./interfaces/getAuthType');
exports.getLogFormatType = require('./interfaces/getLogFormatType');

// Choose 1 of the following 2 functions, delete the rest. getBasicAuth is used for default testing
exports.getBasicAuth = require('./interfaces/getBasicAuth');
// exports.getOauthInfo = require('./interfaces/getOauthInfo');

exports.getUserInfo = require('./interfaces/getUserInfo');
exports.unAuthorize = require('./interfaces/unAuthorize');
exports.findContact = require('./interfaces/findContact');
exports.createCallLog = require('./interfaces/createCallLog');
exports.getCallLog = require('./interfaces/getCallLog');
exports.updateCallLog = require('./interfaces/updateCallLog');
exports.createMessageLog = require('./interfaces/createMessageLog');
exports.updateMessageLog = require('./interfaces/updateMessageLog');
exports.createContact = require('./interfaces/createContact');

exports.upsertCallDisposition = require('./interfaces/upsertCallDisposition');
exports.getUserList = require('./interfaces/getUserList');
exports.findContactWithName = require('./interfaces/findContactWithName');

exports.getLicenseStatus = require('./interfaces/getLicenseStatus');
exports.getRefreshedAuthToken = require('./interfaces/getRefreshedAuthToken');
