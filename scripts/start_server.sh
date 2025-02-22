#!/bin/bash
cd /home/servicenow/rcservicenowapi.gate6.com
unzip -o api.zip
rm -rf api.zip
npm install
pm2 start src/server.js
