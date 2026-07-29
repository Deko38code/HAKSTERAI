#!/usr/bin/env python3
"""
Telethon script to message @BotFather directly from the user's Telegram account.
Uses Telegram Desktop's public API credentials.
Usage: python3 botfather_chat.py
"""
import asyncio
import sys
from telethon import TelegramClient

# Telegram Desktop public API credentials
API_ID = 2040
API_HASH = 'b18441a1ff607e10a989891a5462e627'
SESSION_FILE = '/home/ghost/.hakster/telethon_session'

async def main():
    phone = sys.argv[1] if len(sys.argv) > 1 else input('Enter your phone number (e.g. +1234567890): ')
    
    client = TelegramClient(SESSION_FILE, API_ID, API_HASH)
    await client.connect()
    
    if not await client.is_user_authorized():
        await client.send_code_request(phone)
        code = input('Enter the login code sent to your Telegram: ')
        try:
            await client.sign_in(phone, code)
        except Exception as e:
            if '2FA' in str(e) or 'SessionPasswordNeeded' in type(e).__name__:
                password = input('Enter your 2FA password: ')
                await client.sign_in(password=password)
            else:
                raise
    
    print('✅ Logged in to Telegram as user account')
    
    # Send /newbot to BotFather
    botfather = await client.get_entity('@BotFather')
    
    if len(sys.argv) > 2 and sys.argv[2] == 'newbot':
        bot_name = sys.argv[3] if len(sys.argv) > 3 else 'Pandemonium Visual AI'
        bot_username = sys.argv[4] if len(sys.argv) > 4 else 'PandemoniumVisualBot'
        
        await client.send_message(botfather, '/newbot')
        await asyncio.sleep(2)
        
        msgs = await client.get_messages(botfather, limit=1)
        print('BotFather:', msgs[0].text if msgs else 'no response')
        
        await client.send_message(botfather, bot_name)
        await asyncio.sleep(2)
        
        msgs = await client.get_messages(botfather, limit=1)
        print('BotFather:', msgs[0].text if msgs else 'no response')
        
        await client.send_message(botfather, bot_username)
        await asyncio.sleep(3)
        
        msgs = await client.get_messages(botfather, limit=1)
        print('BotFather:', msgs[0].text if msgs else 'no response')
        
        # Extract token from response
        if msgs and 'token' in msgs[0].text.lower():
            for line in msgs[0].text.split('\n'):
                if ':' in line and len(line.split(':')) == 2 and len(line.split(':')[0]) > 5:
                    token = line.strip()
                    print(f'\n🔑 BOT TOKEN: {token}')
                    # Save token
                    with open('/home/ghost/.hakster/new_bot_token.txt', 'w') as f:
                        f.write(token)
                    print('Token saved to /home/ghost/.hakster/new_bot_token.txt')
    else:
        # Interactive chat mode
        print('\n=== Connected to @BotFather ===')
        print('Type messages to send to BotFather. Type "quit" to exit.\n')
        
        # Get recent messages
        msgs = await client.get_messages(botfather, limit=5)
        for m in reversed(msgs):
            sender = 'You' if m.out else 'BotFather'
            print(f'[{sender}] {m.text}')
        
        while True:
            msg = input('\nYou> ')
            if msg.lower() in ('quit', 'exit', 'q'):
                break
            await client.send_message(botfather, msg)
            await asyncio.sleep(3)
            msgs = await client.get_messages(botfather, limit=1)
            if msgs:
                print(f'BotFather> {msgs[0].text}')
    
    await client.disconnect()

if __name__ == '__main__':
    asyncio.run(main())