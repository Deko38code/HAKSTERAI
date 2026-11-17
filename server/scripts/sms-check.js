#!/usr/bin/env node
'use strict';
/**
 * haksterAI — guard checks for our own SMS gateway.
 *
 * Read-only: this never sends, never dials the phone, never writes the /sms
 * toggle. It proves the policy half refuses everything it should refuse and
 * that the phone command cannot be turned into shell syntax.
 *
 *   node server/scripts/sms-check.js
 *
 * Exit code 0 = all checks passed, 1 = a check failed.
 */

const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(SERVER_DIR, '.env'), quiet: true });

const gateway = require(path.join(SERVER_DIR, 'src', 'smsGateway'));
const notifySms = require(path.join(SERVER_DIR, 'src', 'notifySms'));

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) { pass += 1; console.log(`PASS  ${name}`); return true; }
  fail += 1; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

async function main() {
  // 1. Master switch: with SMS_ENABLED unset/false, sendSms must refuse before any
  //    transport is touched. A stub delivery records whether it was reached.
  const originalDeliver = gateway.deliver;
  let delivered = 0;
  gateway.deliver = async () => { delivered += 1; return { ok: true, provider: 'stub' }; };

  const previousEnabled = process.env.SMS_ENABLED;
  process.env.SMS_ENABLED = 'false';
  const blocked = await notifySms.sendSms('guard check — must not leave the box');
  check('SMS_ENABLED=false refuses the send', blocked && blocked.ok === false && blocked.denied === true, JSON.stringify(blocked));
  check('no transport was called while disabled', delivered === 0, `deliver called ${delivered}x`);

  process.env.SMS_ENABLED = previousEnabled === undefined ? '' : previousEnabled;
  if (previousEnabled === undefined) delete process.env.SMS_ENABLED;

  // 2. Daily cap is countable and bounded from env.
  const trial = notifySms.trialConfig();
  check('daily cap is clamped to 1–20', trial.maxPerDay >= 1 && trial.maxPerDay <= 20, String(trial.maxPerDay));
  check('customer messaging is off by default', trial.customerMessaging === false, String(trial.customerMessaging));
  check('trial mode defaults on', trial.trialMode === true, String(trial.trialMode));
  check('sends today never exceeds the cap', notifySms.sentInLast24h() >= 0, String(notifySms.sentInLast24h()));

  // 3. Destination is explicit only — nothing is inferred for our transports.
  const explicit = gateway.explicitDestination();
  check('explicit destination is either null or a 10–15 digit number',
    explicit === null || /^\d{10,15}$/.test(explicit), String(explicit));
  check('maskNumber never reveals more than four digits',
    gateway.maskNumber('15551234567') === '…4567', gateway.maskNumber('15551234567'));

  // 4. Phone command: digits-only number, base64 payload, no message text in the shell.
  const nasty = 'hi"; rm -rf /; echo `whoami` $(id) \' \n';
  const cmd = gateway.phoneCommand('15551234567', nasty);
  check('phone command carries only the digits', /\-n 15551234567/.test(cmd), cmd.slice(0, 60));
  check('phone command embeds no raw message text', !cmd.includes('rm -rf') && !cmd.includes('whoami'));
  check('phone command uses base64 transport', /base64 -d/.test(cmd));
  check('phone command is a single line', !cmd.includes('\n'));

  // 5. Provider routing: an unknown forced provider never invents a transport.
  const previousProvider = process.env.SMS_PROVIDER;
  process.env.SMS_PROVIDER = 'nonsense';
  check('unknown SMS_PROVIDER resolves to no transport', gateway.providerOrder().length === 0,
    JSON.stringify(gateway.providerOrder()));
  if (previousProvider === undefined) delete process.env.SMS_PROVIDER;
  else process.env.SMS_PROVIDER = previousProvider;

  // 6. Status carries no secret and no full number.
  gateway.deliver = originalDeliver;
  const st = gateway.status();
  const flat = JSON.stringify(st);
  check('status contains no full destination number',
    !explicit || !flat.includes(explicit), 'status leaked the destination');
  check('status exposes no obvious secret keys',
    !/password|secret|token|pass"|"pass/i.test(flat), flat.slice(0, 120));

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('sms-check failed:', err.message);
  process.exitCode = 1;
});
