#!/usr/bin/env node
/**
 * Simple SMS sender using Twilio API
 * Sends a text message to a specified phone number
 */

const sendSMS = async () => {
  // Check if Twilio is installed
  let twilio;
  try {
    twilio = require('twilio');
  } catch (error) {
    console.error('Error: Twilio library not installed.');
    console.error('Install it with: npm install twilio');
    showAlternatives();
    return false;
  }

  // Get credentials from environment variables
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error('Error: Missing Twilio credentials.');
    console.error('Please set the following environment variables:');
    console.error('  - TWILIO_ACCOUNT_SID');
    console.error('  - TWILIO_AUTH_TOKEN');
    console.error('  - TWILIO_PHONE_NUMBER');
    showAlternatives();
    return false;
  }

  // Target phone number
  const toNumber = '+12099360846'; // Adding +1 for US country code

  // Message to send
  const messageBody = process.argv.slice(2).join(' ') || 'Hello! This is a test message.';

  try {
    // Create Twilio client
    const client = twilio(accountSid, authToken);

    // Send message
    const message = await client.messages.create({
      body: messageBody,
      from: fromNumber,
      to: toNumber
    });

    console.log('✓ Message sent successfully!');
    console.log(`  Message SID: ${message.sid}`);
    console.log(`  To: ${toNumber}`);
    console.log(`  Status: ${message.status}`);
    return true;

  } catch (error) {
    console.error(`Error sending message: ${error.message}`);
    return false;
  }
};

const showAlternatives = () => {
  console.log('\n' + '='.repeat(50));
  console.log('Setup Instructions:');
  console.log('='.repeat(50));
  console.log('\nAlternative SMS services you can use:');
  console.log('1. Twilio - https://www.twilio.com/');
  console.log('2. Vonage (Nexmo) - https://www.vonage.com/');
  console.log('3. AWS SNS - https://aws.amazon.com/sns/');
  console.log('4. MessageBird - https://www.messagebird.com/');
  console.log('5. Plivo - https://www.plivo.com/');
  console.log('\nTo use this script with Twilio:');
  console.log('1. Sign up at https://www.twilio.com/');
  console.log('2. Get your Account SID and Auth Token');
  console.log('3. Get a Twilio phone number');
  console.log('4. Set environment variables:');
  console.log("   export TWILIO_ACCOUNT_SID='your_account_sid'");
  console.log("   export TWILIO_AUTH_TOKEN='your_auth_token'");
  console.log("   export TWILIO_PHONE_NUMBER='+1234567890'");
  console.log('5. Install Twilio: npm install twilio');
  console.log("6. Run: node send_sms.js 'Your message here'");
};

// Main execution
(async () => {
  console.log('='.repeat(50));
  console.log('SMS Sender');
  console.log('='.repeat(50));
  console.log('Target: +1 (209) 936-0846');
  console.log();

  await sendSMS();
})();
