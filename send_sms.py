#!/usr/bin/env python3
"""
Simple SMS sender using Twilio API
Sends a text message to a specified phone number
"""

import os
import sys

def send_sms_with_twilio():
    """Send SMS using Twilio API"""
    try:
        from twilio.rest import Client
    except ImportError:
        print("Error: Twilio library not installed.")
        print("Install it with: pip3 install twilio")
        return False
    
    # Get credentials from environment variables
    account_sid = os.environ.get('TWILIO_ACCOUNT_SID')
    auth_token = os.environ.get('TWILIO_AUTH_TOKEN')
    from_number = os.environ.get('TWILIO_PHONE_NUMBER')
    
    if not all([account_sid, auth_token, from_number]):
        print("Error: Missing Twilio credentials.")
        print("Please set the following environment variables:")
        print("  - TWILIO_ACCOUNT_SID")
        print("  - TWILIO_AUTH_TOKEN")
        print("  - TWILIO_PHONE_NUMBER")
        return False
    
    # Target phone number
    to_number = "+12099360846"  # Adding +1 for US country code
    
    # Message to send
    message_body = input("Enter your message: ") if len(sys.argv) < 2 else ' '.join(sys.argv[1:])
    
    if not message_body:
        message_body = "Hello! This is a test message."
    
    try:
        # Create Twilio client
        client = Client(account_sid, auth_token)
        
        # Send message
        message = client.messages.create(
            body=message_body,
            from_=from_number,
            to=to_number
        )
        
        print(f"✓ Message sent successfully!")
        print(f"  Message SID: {message.sid}")
        print(f"  To: {to_number}")
        print(f"  Status: {message.status}")
        return True
        
    except Exception as e:
        print(f"Error sending message: {str(e)}")
        return False

def send_sms_alternative():
    """Alternative method using requests library (for other SMS APIs)"""
    print("\nAlternative SMS services you can use:")
    print("1. Twilio - https://www.twilio.com/")
    print("2. Vonage (Nexmo) - https://www.vonage.com/")
    print("3. AWS SNS - https://aws.amazon.com/sns/")
    print("4. MessageBird - https://www.messagebird.com/")
    print("5. Plivo - https://www.plivo.com/")

if __name__ == "__main__":
    print("=" * 50)
    print("SMS Sender")
    print("=" * 50)
    print(f"Target: +1 (209) 936-0846")
    print()
    
    success = send_sms_with_twilio()
    
    if not success:
        print("\n" + "=" * 50)
        print("Setup Instructions:")
        print("=" * 50)
        send_sms_alternative()
        print("\nTo use this script with Twilio:")
        print("1. Sign up at https://www.twilio.com/")
        print("2. Get your Account SID and Auth Token")
        print("3. Get a Twilio phone number")
        print("4. Set environment variables:")
        print("   export TWILIO_ACCOUNT_SID='your_account_sid'")
        print("   export TWILIO_AUTH_TOKEN='your_auth_token'")
        print("   export TWILIO_PHONE_NUMBER='+1234567890'")
        print("5. Install Twilio: pip3 install twilio")
        print("6. Run: python3 send_sms.py 'Your message here'")
