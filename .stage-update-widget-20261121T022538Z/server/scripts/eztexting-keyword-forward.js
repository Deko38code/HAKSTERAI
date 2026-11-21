#!/usr/bin/env node
'use strict';

// Point an Ez Texting *keyword* at our inbound receiver.
//
// Two independent Ez Texting mechanisms can reach this box:
//   1. Webhook subscriptions  → POST /v1/webhooks/subscriptions   (eztexting-webhook.js)
//   2. A keyword's forwardUrl → PUT  /v1/keywords/{keyword}       (this script)
// The keyword forward URL is what catches a text-to-join (e.g. someone texting
// "STOP" or a join keyword to the number), and Ez Texting posts it as an
// ordinary form post — which the receiver now parses alongside JSON.
//
//   node server/scripts/eztexting-keyword-forward.js                 # show keywords + forwardUrl
//   node server/scripts/eztexting-keyword-forward.js --apply all     # point every keyword here
//   node server/scripts/eztexting-keyword-forward.js --apply JOIN    # point one keyword here
//   node server/scripts/eztexting-keyword-forward.js --clear all     # remove the forwardUrl again
//
// Facts this follows (developers.eztexting.com):
//   GET  /v1/keywords                 → { data: [ Keyword ] }
//   PUT  /v1/keywords/{keyword}       body = KeywordSettings
//        { doubleOptInEnabled, doubleOptInMessage, joinMessage,
//          forwardEmails[], forwardUrl, contactGroupIds[] }
//
// Safety:
//   * Dry-run unless --apply / --clear is passed.
//   * The current settings of every keyword are written to
//     server/data/eztexting-keyword-backup-<ts>.json (mode 0600) before any write,
//     so every change can be undone exactly with --restore if needed.
//   * Only forwardUrl is changed; opt-in messages and contact-group wiring are
//     sent back unchanged with the PUT.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch {}

const BASE = 'https://a.eztexting.com/v1';
const DATA_DIR = path.join(ROOT, '..', 'data');
const DEFAULT_CALLBACK = 'https://haksterai.com/api/eztexting/inbound';

function config() {
  return {
    user: String(process.env.EZ_TEXTING_USER || '').trim(),
    password: String(process.env.EZ_TEXTING_PASSWORD || ''),
    secret: String(process.env.EZ_TEXTING_WEBHOOK_SECRET || '').trim(),
    callback: String(process.env.EZ_TEXTING_WEBHOOK_URL || DEFAULT_CALLBACK).trim(),
  };
}

async function call(method, resource, auth, body) {
  const res = await fetch(BASE + resource, {
    method,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      authorization: auth,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

function listOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.keywords)) return data.keywords;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function settingsFrom(kw, forwardUrl) {
  // Send every existing setting back unchanged; only forwardUrl differs.
  const out = { ...kw, forwardUrl };
  delete out.id;
  delete out.keyword;
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

(async () => {
  const c = config();
  if (!c.user || !c.password) {
    console.log('Add EZ_TEXTING_USER and EZ_TEXTING_PASSWORD to server/.env first (agents never write that file).');
    process.exit(2);
  }
  const auth = 'Basic ' + Buffer.from(`${c.user}:${c.password}`).toString('base64');
  const argv = process.argv.slice(2);
  const applyIdx = argv.indexOf('--apply');
  const clearIdx = argv.indexOf('--clear');
  const target = applyIdx >= 0 ? (argv[applyIdx + 1] || '')
    : clearIdx >= 0 ? (argv[clearIdx + 1] || '')
    : '';
  const mode = applyIdx >= 0 ? 'apply' : clearIdx >= 0 ? 'clear' : 'list';

  const listed = await call('GET', '/keywords', auth);
  if (listed.status === 401) {
    console.log('❌ 401 from Ez Texting — the login in server/.env is not accepted.');
    process.exit(1);
  }
  if (listed.status < 200 || listed.status >= 300) {
    console.log(`❌ GET /v1/keywords → HTTP ${listed.status} ${JSON.stringify(listed.data || {}).slice(0, 300)}`);
    process.exit(1);
  }
  const keywords = listOf(listed.data);
  if (!keywords.length) {
    console.log('No keywords on this account yet (GET /v1/keywords returned an empty list).');
    return;
  }

  console.log(`Keywords on the account: ${keywords.length}`);
  for (const kw of keywords) {
    const name = kw.keyword || kw.name || `(id ${kw.id})`;
    console.log(`  • ${name} → forwardUrl ${kw.forwardUrl ? kw.forwardUrl : '(none)'}`);
  }
  console.log(`\nReceiver: ${c.callback}`);
  if (!c.secret) {
    console.log('⚠️  EZ_TEXTING_WEBHOOK_SECRET is not in server/.env — the receiver records deliveries but will not forward them to Telegram until it is set.');
  }
  if (mode === 'list') {
    console.log('\nNothing changed. Use --apply all (or --apply <keyword>) to point them here.');
    return;
  }
  if (!target) {
    console.log(`\nUsage: --${mode} <keyword|all>`);
    process.exit(2);
  }

  const wanted = target.toLowerCase() === 'all'
    ? keywords
    : keywords.filter(kw => String(kw.keyword || kw.name || '').toLowerCase() === target.toLowerCase());
  if (!wanted.length) {
    console.log(`\n❌ No keyword named "${target}". Names are listed above.`);
    process.exit(1);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const backupFile = path.join(DATA_DIR, `eztexting-keyword-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ at: new Date().toISOString(), keywords }, null, 2) + '\n', { mode: 0o600 });
  console.log(`\nBackup written: ${path.relative(ROOT, backupFile)} (mode 0600)`);

  for (const kw of wanted) {
    const name = String(kw.keyword || kw.name || '');
    const forwardUrl = mode === 'clear' ? '' : c.callback;
    const res = await call('PUT', `/keywords/${encodeURIComponent(name)}`, auth, settingsFrom(kw, forwardUrl));
    if (res.status >= 200 && res.status < 300) {
      console.log(`✅ ${name} → forwardUrl ${forwardUrl || '(cleared)'}`);
    } else {
      console.log(`❌ ${name} → HTTP ${res.status} ${JSON.stringify(res.data || {}).slice(0, 300)}`);
    }
  }
  console.log('\nDone. Text the number (or the keyword) and check: data/inbound-sms-log.jsonl and the owner Telegram DM.');
})();
