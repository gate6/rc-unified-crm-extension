// main file for local server
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '..', '.env') });

const { app } = require('./app');

const {
  PORT: port,
  APP_HOST: host,
} = process.env;

app.listen(port, host, () => {
  console.log(`-> server running at: http://${host}:${port}`);
});
