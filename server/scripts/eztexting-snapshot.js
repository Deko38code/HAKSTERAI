#!/usr/bin/env node
'use strict';

// Read-only EzTexting account snapshot — feeds the owner's SMS/notification
// infrastructure with the account's real data (sending numbers, keywords, contact
// groups, credits) instead of anything guessed.
//
//   EZ_TEXTING_USER=... EZ_TEXTING_PASSWORD=... in server/.env, then:
//   node server/scripts/eztexting-snapshot.js
//
// Safety:
//   * GET requests only. This script never sends a message, edits a contact or
//     changes account settings.
//   * Candidate collection paths are probed and the script reports which ones the
//     account actually answers — no path is assumed to exist.
//   * The snapshot is written with mode 0600 to server/data/; the terminal output
//     shows counts and masked numbers only.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch {}

const BASE = 'https://a.eztexting.com/v1';
const DATA_DIR = path.join(ROOT, '..', 'data');

// Documented v1 collections (developers.eztexting.com/llms.txt). Unlisted
// guesses stay out: a 404 tells us nothing and a wrong path is not a finding.
const CANDIDATES = [
  '/credits',
  '/contacts',
  '/contact-groups',
  '/contact-fields',
  '/keywords',
  '/messages',
  '/messages/campaigns',
  '/conversations',
  '/message-templates',
  '/media-files',
  '/webhooks/subscriptions',
  '/phone-numbers',
];

function mask(value) {
  if (value === null || value === undefined) return value;
  const s = String(value);
  return s.length >= 4 ? `…${s.slice(-4)}` : '••••';
}

async function get(resource, authHeader) {
  const res = await fetch(BASE + resource, {
    headers: { accept: 'application/json', authorization: authHeader },
    signal: AbortSignal.timeout(20000),
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

(async () => {
  const user = String(process.env.EZ_TEXTING_USER || '').trim();
  const password = String(process.env.EZ_TEXTING_PASSWORD || '');
  if (!user || !password) {
    console.log('EzTexting credentials are not in server/.env yet. Add these lines yourself:');
    console.log('  EZ_TEXTING_USER=<your Ez Texting login>');
    console.log('  EZ_TEXTING_PASSWORD=<your Ez Texting password>');
    console.log('  EZ_TEXTING_TO=<your mobile, digits only>');
    console.log('Then re-run: node server/scripts/eztexting-snapshot.js');
    process.exit(2);
  }
  const authHeader = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
  const snapshot = { at: new Date().toISOString(), account: user.split('@')[0] ? mask(user) : '(set)', resources: {} };
  const summary = [];

  for (const resource of CANDIDATES) {
    try {
      const { status, body } = await get(resource, authHeader);
      const ok = status >= 200 && status < 300;
      snapshot.resources[resource] = { status, ok, body: ok ? body : undefined, error: ok ? undefined : body };
      let count = '';
      if (ok) {
        const data = body?.data || body?.items || body;
        const arr = Array.isArray(data) ? data : null;
        if (arr) count = `${arr.length} item(s)`;
        else count = 'object';
      }
      summary.push(`${ok ? '✅' : '·'} ${resource} → ${status}${count ? ' · ' + count : ''}`);
    } catch (e) {
      snapshot.resources[resource] = { status: 0, ok: false, error: e.message };
      summary.push(`· ${resource} → ${e.message}`);
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `eztexting-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });

  console.log('EzTexting read-only snapshot');
  for (const line of summary) console.log(' ', line);

  // Which number the account sends from, and where its message history went —
  // this is what the SMS mirror resolves when EZ_TEXTING_TO is not in .env.
  const msgs = snapshot.resources['/messages'];
  const rows = msgs && msgs.ok ? (msgs.body?.data || msgs.body?.items || msgs.body) : null;
  if (Array.isArray(rows) && rows.length) {
    const sending = [...new Set(rows.map(r => String(r.userNumber || '').replace(/[^\d]/g, '')).filter(Boolean))];
    const outboundTargets = [...new Set(rows
      .filter(r => r.inbound !== true)
      .map(r => String(r.contactNumber || '').replace(/[^\d]/g, ''))
      .filter(n => /^\d{10,15}$/.test(n) && !sending.includes(n)))];
    if (sending.length) console.log(`\nSending number: ${sending.map(mask).join(', ')}`);
    console.log(`Saved destination(s): ${outboundTargets.length ? outboundTargets.map(mask).join(', ') : '(none found)'}`);
    if (outboundTargets.length === 1) console.log('  → EZ_TEXTING_TO can stay empty: the mirror reads this one saved number from your history.');
    if (outboundTargets.length > 1) console.log('  → more than one destination on the account; set EZ_TEXTING_TO explicitly so nothing goes to the wrong phone.');
  }
  console.log(`\nSaved: ${path.relative(ROOT, file)} (mode 0600)`);
  const auth401 = Object.values(snapshot.resources).some(r => r.status === 401);
  if (auth401) console.log('⚠️  At least one call returned 401 — check the login in server/.env (API uses your account username and password).');
})();
