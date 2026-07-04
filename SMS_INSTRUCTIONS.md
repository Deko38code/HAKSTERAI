# SMS Sender - Instructions

## Overview
Two scripts have been created to send text messages to **+1 (209) 936-0846**:
- `send_sms.py` - Python version
- `send_sms.js` - Node.js version

## Quick Start

### Option 1: Using Python

1. **Install Twilio SDK:**
   ```bash
   pip3 install twilio
   ```

2. **Set up environment variables:**
   ```bash
   export TWILIO_ACCOUNT_SID='your_account_sid_here'
   export TWILIO_AUTH_TOKEN='your_auth_token_here'
   export TWILIO_PHONE_NUMBER='+1234567890'  # Your Twilio number
   ```

3. **Send a message:**
   ```bash
   python3 send_sms.py "Hello! This is my message"
   ```

### Option 2: Using Node.js

1. **Install Twilio SDK:**
   ```bash
   npm install twilio
   ```

2. **Set up environment variables:**
   ```bash
   export TWILIO_ACCOUNT_SID='your_account_sid_here'
   export TWILIO_AUTH_TOKEN='your_auth_token_here'
   export TWILIO_PHONE_NUMBER='+1234567890'  # Your Twilio number
   ```

3. **Send a message:**
   ```bash
   node send_sms.js "Hello! This is my message"
   ```

## Getting Twilio Credentials

1. **Sign up for Twilio:**
   - Go to https://www.twilio.com/try-twilio
   - Create a free account (includes trial credits)

2. **Get your credentials:**
   - After signing up, you'll see your **Account SID** and **Auth Token** on the dashboard
   - Copy these values

3. **Get a phone number:**
   - In the Twilio console, go to "Phone Numbers" → "Manage" → "Buy a number"
   - Select a number (free with trial account)
   - This will be your `TWILIO_PHONE_NUMBER`

4. **Verify the recipient number (for trial accounts):**
   - Trial accounts can only send to verified numbers
   - Go to "Phone Numbers" → "Manage" → "Verified Caller IDs"
   - Add and verify +1 (209) 936-0846

## Alternative SMS Services

If you prefer not to use Twilio, here are other options:

1. **Vonage (Nexmo)** - https://www.vonage.com/
2. **AWS SNS** - https://aws.amazon.com/sns/
3. **MessageBird** - https://www.messagebird.com/
4. **Plivo** - https://www.plivo.com/
5. **Sinch** - https://www.sinch.com/

## Example Usage

```bash
# Simple message
python3 send_sms.py "Hi honey, I'll be home soon!"

# Or with Node.js
node send_sms.js "Hi honey, I'll be home soon!"
```

## Troubleshooting

### Error: "Missing Twilio credentials"
- Make sure you've exported the environment variables in your current terminal session
- Check that the variable names are correct (case-sensitive)

### Error: "Twilio library not installed"
- Run `pip3 install twilio` (Python) or `npm install twilio` (Node.js)

### Error: "Unable to create record"
- For trial accounts, verify the recipient number in Twilio console
- Check that the phone number format is correct (+1 for US numbers)

### Error: "Authentication failed"
- Double-check your Account SID and Auth Token
- Make sure there are no extra spaces or quotes

## Security Note

⚠️ **Never commit your Twilio credentials to version control!**
- Use environment variables
- Add `.env` files to `.gitignore`
- Consider using a secrets manager for production use

## Cost

- Twilio trial accounts include free credits
- After trial: ~$0.0075 per SMS in the US
- Check current pricing at https://www.twilio.com/sms/pricing
