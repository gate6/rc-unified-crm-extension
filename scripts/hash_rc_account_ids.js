require('dotenv').config();
const { getHashValue } = require('../packages/core/lib/util');

const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

rl.question('Enter your rcAccountId: ', (input) => {
    const inputRcAccountId = input.trim();

    if (!inputRcAccountId) {
        console.error('Please provide a valid rcAccountId to hash.');
        rl.close();
        process.exit(1);
    }

    const hashedRcAccountId = getHashValue(inputRcAccountId, process.env.HASH_KEY);

    console.log('\n----------------------------------------------------');
    console.log(`Original rcAccountId:       ${inputRcAccountId}`);
    console.log(`Hashed rcAccountId (Salted): ${hashedRcAccountId}`);
    console.log('----------------------------------------------------');
    console.log('Please copy the Hashed rcAccountId above and enter it into the rcAccountId column in your database.\n');
    
    rl.close();
});
