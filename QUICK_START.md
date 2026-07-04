# Quick Start - Send SMS to (209) 936-0846

## 🚀 Fastest Way to Send a Text

### Step 1: Install Twilio
```bash
pip3 install twilio
# OR
npm install twilio
```

### Step 2: Set Your Credentials
```bash
export TWILIO_ACCOUNT_SID='ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
export TWILIO_AUTH_TOKEN='your_auth_token_here'
export TWILIO_PHONE_NUMBER='+15551234567'
```

### Step 3: Send Your Message
```bash
# Python
python3 send_sms.py "Your message here"

# OR Node.js
node send_sms.js "Your message here"
```

## 📱 Target Number
**+1 (209) 936-0846**

## 🔑 Get Twilio Credentials (Free Trial)
1. Visit: https://www.twilio.com/try-twilio
2. Sign up (free trial includes credits)
3. Copy your Account SID and Auth Token from dashboard
4. Get a free phone number
5. Verify +1 (209) 936-0846 as a recipient (required for trial)

## 📄 Files Created
- `send_sms.py` - Python SMS sender
- `send_sms.js` - Node.js SMS sender  
- `SMS_INSTRUCTIONS.md` - Detailed instructions
- `QUICK_START.md` - This file

## ⚡ Example
```bash
python3 send_sms.py "Hi! I'll be home in 20 minutes"
```

Output:
```
✓ Message sent successfully!
  Message SID: SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  To: +12099360846
  Status: queued
```

---
**Need help?** Check `SMS_INSTRUCTIONS.md` for detailed setup and troubleshooting.
