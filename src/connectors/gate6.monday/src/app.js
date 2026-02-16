const { createCoreApp, connectorRegistry } = require('@app-connect/core');

// Import your custom CRM connector
const myCRMConnector = require('./connectors/myCRM');
const releaseNotes = require('./releaseNotes.json');

// Register your CRM connector
// Note: use the plain 'monday' platform id so the OAuth callback (state=platform=monday)
// resolves to this connector instance.
connectorRegistry.registerConnector('monday', myCRMConnector);
connectorRegistry.setReleaseNotes(releaseNotes);

// Create Express app with all core functionality
const app = createCoreApp();

app.get('/', (req, res) => {
  res.send('App Connect Connector Server - OK');
});

exports.app = app;
