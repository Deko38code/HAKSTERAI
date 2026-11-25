#!/usr/bin/env node
/**
 * Live check: an owner button click is recorded even when the tab goes away
 * before the action finishes (the anomaly scan takes ~12s, so closing early is
 * the realistic case). Proves the admin_click audit row carries endpoint,
 * status, duration, actor and the early-close flag.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(ROOT, 'node_modules/puppeteer'));
const Database = require(path.join(ROOT, 'server/node_modules/better-sqlite3'));

(async () => {
  const db = new Database(path.join(ROOT, 'data/hakster.db'), { readonly: true });
  const owner = db.prepare("SELECT api_key, id, plan FROM users WHERE lower(email) = 'dekekenneth840@gmail.com' LIMIT 1").get();
  if (!owner) { console.log('FAIL: no owner row'); process.exit(1); }
  const before = db.prepare("SELECT COALESCE(MAX(id), 0) m FROM user_activity").get().m;

  const browser = await puppeteer.launch({ headless: 'new', executablePath: require('../src/browser-path').resolveBrowserPath() || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.hostname !== 'haksterai.com') return req.continue();
    if (['script', 'stylesheet', 'image', 'font'].includes(req.resourceType())) return req.continue();
    if (url.pathname === '/api/auth/me') {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: owner.id, username: 'owner', email: 'dekekenneth840@gmail.com', role: 'admin', is_owner: true, plan: owner.plan, status: 'active' } }) });
    }
    if (url.pathname === '/api/auth/authorize-page') {
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    req.continue();
  });
  await page.goto('https://haksterai.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((key) => localStorage.setItem('hakster_google_token', key), owner.api_key);
  await page.goto('https://haksterai.com/dashboard/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 4000));

  await page.click('#anom-run');
  // Deliberately leave before the scan can answer.
  await new Promise((r) => setTimeout(r, 2500));
  await browser.close();
  console.log('tab closed early, waiting for the server-side scan to finish…');
  await new Promise((r) => setTimeout(r, 25000));

  const rows = db.prepare("SELECT id, action, endpoint, status_code, metadata, datetime(created_at,'unixepoch','localtime') lt FROM user_activity WHERE id > ? ORDER BY id DESC").all(before);
  db.close();
  console.log('new rows:', JSON.stringify(rows, null, 1));
  const hit = rows.find((r) => r.action === 'admin_click' && /anomaly\/run/.test(r.endpoint || ''));
  let meta = {};
  try { meta = hit ? JSON.parse(hit.metadata || '{}') : {}; } catch {}
  const pass = {
    rowWritten: Boolean(hit),
    endpoint: Boolean(hit && /\/api\/admin\/anomaly\/run$/.test(hit.endpoint)),
    status200: Boolean(hit && hit.status_code === 200),
    actorOwner: meta.actor === 'dekekenneth840@gmail.com',
    durationMs: Number.isFinite(meta.ms) && meta.ms > 0,
    abortFlagged: meta.aborted === true,
  };
  console.log('checks:', JSON.stringify(pass));
  const ok = Object.values(pass).every(Boolean);
  console.log(ok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
