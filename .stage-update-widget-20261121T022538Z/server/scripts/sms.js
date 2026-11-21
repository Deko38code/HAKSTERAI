#!/usr/bin/env node
'use strict';
/**
 * haksterAI — command-line front door for our own SMS gateway.
 *
 * Read-only by default. `send` prints exactly what it WOULD do and only dials
 * when you also pass --send, because a stray argument should never text anyone.
 *
 *   node server/scripts/sms.js status
 *   node server/scripts/sms.js probe              # SSH + Termux check, sends nothing
 *   node server/scripts/sms.js send --text "hi"   # dry run — prints the plan
 *   node server/scripts/sms.js send --text "hi" --send
 *   node server/scripts/sms.js inbox --limit 5    # last SMS on the phone, masked
 *
 * Environment is read from server/.env. Numbers are shown as …last4 only; no
 * credential is ever printed.
 */

const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(SERVER_DIR, '.env'), quiet: true });

const gateway = require(path.join(SERVER_DIR, 'src', 'smsGateway'));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--send') { out.send = true; continue; }
    if (arg === '--to') { out.to = argv[++i]; continue; }
    if (arg === '--text') { out.text = argv[++i]; continue; }
    if (arg === '--limit') { out.limit = argv[++i]; continue; }
    if (arg === '-h' || arg === '--help') { out.help = true; continue; }
    out._.push(arg);
  }
  return out;
}

function printStatus() {
  const st = gateway.status();
  const line = (label, value) => console.log(`${label.padEnd(16)} ${value}`);
  line('Order', st.providerOrder.length ? st.providerOrder.join(' → ') : 'none configured');
  line('Forced', st.forcedProvider);
  line('Destination', st.destination);
  line('Phone', st.phone.configured
    ? `${st.phone.host} (auth: ${st.phone.auth})`
    : 'not configured');
  line('Carrier bridge', st.carrierEmail.configured
    ? `${st.carrierEmail.gateway} via ${st.carrierEmail.smtp}`
    : 'not configured');
  line('Ez Texting', st.eztexting.configured ? 'credentials present' : 'not configured');
  line('Master switch', String(process.env.SMS_ENABLED || 'false'));
  line('Mirror (/sms)', 'see the bot — this CLI does not change it');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = (args._[0] || 'status').toLowerCase();

  if (args.help || cmd === 'help') {
    console.log('usage: sms.js <status|probe|send|inbox> [--text ..] [--to ..] [--send] [--limit N]');
    return 0;
  }

  if (cmd === 'status') { printStatus(); return 0; }

  if (cmd === 'probe') {
    printStatus();
    console.log('');
    if (!gateway.phoneConfigured()) { console.log('Phone transport is not configured — nothing to probe.'); return 0; }
    console.log('Probing the phone (SSH + Termux:API, no message is sent)…');
    const r = await gateway.probePhone();
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }

  if (cmd === 'inbox') {
    if (!gateway.phoneConfigured()) { console.log('Phone transport is not configured — no inbox to read.'); return 1; }
    const r = await gateway.readPhoneInbox(args.limit || 5);
    if (!r.ok) { console.error('read failed:', r.error); return 1; }
    if (!r.messages.length) { console.log('No messages returned by the phone.'); return 0; }
    for (const m of r.messages) {
      console.log(`${m.at || '?'}  ${m.from}  ${m.type}`);
      console.log(`  ${m.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return 0;
  }

  if (cmd === 'send') {
    const to = gateway.validNumber(args.to) ? args.to : gateway.explicitDestination();
    const text = String(args.text || '').trim();
    if (!text) { console.error('nothing to send — pass --text "..."'); return 2; }
    if (!gateway.validNumber(to)) {
      console.error('no recipient — pass --to <digits> or set SMS_TO in server/.env');
      return 2;
    }
    const plan = {
      to: gateway.maskNumber(to),
      order: gateway.providerOrder(),
      chars: text.length,
      masterSwitch: String(process.env.SMS_ENABLED || 'false'),
    };
    console.log(JSON.stringify(plan, null, 2));
    if (!args.send) {
      console.log('\nDRY RUN — nothing was sent. Re-run with --send to deliver.');
      return 0;
    }
    if (String(process.env.SMS_ENABLED || 'false').toLowerCase() !== 'true') {
      console.error('\nRefusing: SMS_ENABLED is not "true" in server/.env. That master switch is the owner\'s.');
      return 3;
    }
    const result = await gateway.deliver({ to, text: text.slice(0, 640) });
    console.log('\n' + JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  console.error(`unknown command: ${cmd}`);
  return 2;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('sms.js failed:', err.message);
  process.exitCode = 1;
});
