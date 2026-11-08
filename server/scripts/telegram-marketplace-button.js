#!/usr/bin/env node
'use strict';

// Points a bot's menu button (and command list) at the HaksterAI Marketplace mini app.
//
//   node server/scripts/telegram-marketplace-button.js              # show current state
//   node server/scripts/telegram-marketplace-button.js --apply      # set menu button + commands
//   node server/scripts/telegram-marketplace-button.js --apply --role 6
//
// Roles map to TELEGRAM_BOT_TOKEN_1..6 (1=command, 2=coder, 3=recon, 4=debugger,
// 5=uptime, 6=health). Default role is 2 (coder, @Haksteraibot).
//
// The mini app URL must be public HTTPS. Telegram only accepts https:// for web apps.
// Reads the token from server/.env; never prints it.

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch {}

const APP_URL = process.env.MARKETPLACE_APP_URL || 'https://haksterai.com/marketplace/';
const ROLES = {
  1: 'command', 2: 'coder', 3: 'recon', 4: 'debugger', 5: 'uptime', 6: 'health',
};

function call(method, token, payload) {
  return new Promise((resolve) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
      timeout: 15000,
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          resolve(json.ok ? { ok: true, result: json.result } : { ok: false, error: String(json.description || 'error').slice(0, 120) });
        } catch { resolve({ ok: false, error: 'unparsable response' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: 'network: ' + e.message.slice(0, 60) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

function describeMenu(menu) {
  if (!menu) return 'none';
  if (menu.type === 'web_app') return `web_app ${menu.web_app && menu.web_app.url}`;
  if (menu.type === 'default') return 'default';
  return menu.type || 'unknown';
}

(async () => {
  const apply = process.argv.includes('--apply');
  const roleArg = process.argv.indexOf('--role');
  const role = roleArg > -1 ? Number(process.argv[roleArg + 1]) : 2;
  if (!ROLES[role]) {
    console.error(`role must be 1..6 (got ${role})`);
    process.exit(2);
  }
  if (!/^https:\/\//i.test(APP_URL)) {
    console.error('MARKETPLACE_APP_URL must be an https URL');
    process.exit(2);
  }

  const token = process.env[`TELEGRAM_BOT_TOKEN_${role}`];
  if (!token) {
    console.error(`TELEGRAM_BOT_TOKEN_${role} is not set`);
    process.exit(2);
  }

  const me = await call('getMe', token);
  if (!me.ok) {
    console.error(`${ROLES[role]} bot: getMe failed — ${me.error}`);
    process.exit(1);
  }
  console.log(`${ROLES[role]} bot: @${me.result.username} · app ${APP_URL}`);

  if (!apply) {
    const menu = await call('getChatMenuButton', token, {});
    const cmds = await call('getMyCommands', token, {});
    console.log('current menu button:', menu.ok ? describeMenu(menu.result) : `FAIL ${menu.error}`);
    console.log('current commands:', cmds.ok ? JSON.stringify(cmds.result) : `FAIL ${cmds.error}`);
    return;
  }

  const setMenu = process.argv.includes('--menu')
    ? await call('setChatMenuButton', token, {
      menu_button: {
        type: 'web_app',
        text: 'Marketplace',
        web_app: { url: APP_URL },
      },
    })
    : { ok: true, result: 'skipped (pass --menu to replace the existing menu button)' };
  console.log('setChatMenuButton:', setMenu.ok ? (setMenu.result || 'OK') : `FAIL ${setMenu.error}`);

  const setCmds = await call('setMyCommands', token, {
    commands: [
      { command: 'market', description: 'Open the HaksterAI marketplace' },
      { command: 'plans', description: 'See membership and site prices' },
      { command: 'start', description: 'Start the bot' },
    ],
  });
  console.log('setMyCommands:', setCmds.ok ? 'OK' : `FAIL ${setCmds.error}`);

  if (process.argv.includes('--send-test')) {
    const owner = String(process.env.TELEGRAM_OWNER_CHAT || '').trim();
    if (!owner) {
      console.log('send-test: TELEGRAM_OWNER_CHAT is not set');
    } else {
      const sent = await call('sendMessage', token, {
        chat_id: owner,
        text: '🛍 HaksterAI Marketplace\n\nPlans, $999 fully built catalog sites, and the site market.',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Open Marketplace', web_app: { url: APP_URL } }],
            [{ text: 'All plans', url: 'https://haksterai.com/plans' }],
          ],
        },
      });
      console.log('send-test:', sent.ok ? `OK message ${sent.result.message_id}` : `FAIL ${sent.error}`);
    }
  }

  const menu = await call('getChatMenuButton', token, {});
  const cmds = await call('getMyCommands', token, {});
  console.log('verified menu button:', menu.ok ? describeMenu(menu.result) : `FAIL ${menu.error}`);
  console.log('verified commands:', cmds.ok ? JSON.stringify(cmds.result) : `FAIL ${cmds.error}`);

  if (!setMenu.ok || !setCmds.ok) process.exit(1);
})().catch((e) => { console.error('marketplace button error:', e.message); process.exit(1); });
