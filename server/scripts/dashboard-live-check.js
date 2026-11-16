#!/usr/bin/env node
/**
 * Live dashboard check against https://haksterai.com/dashboard/
 * - Stripe webhook log card renders (fixture rows inserted for this check only)
 * - Update card shows a "since last update" timestamp and it advances
 * - Cards poll on a 1s beat (counts /api requests over a 3s window)
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(ROOT, 'node_modules/puppeteer'));
const Database = require(path.join(ROOT, 'server/node_modules/better-sqlite3'));
const fs = require('fs');

const env = {};
for (const line of fs.readFileSync(path.join(ROOT, 'server/.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

(async () => {
  const db = new Database(path.join(ROOT, 'data/hakster.db'));
  const owner = db.prepare("SELECT api_key, id, plan, role FROM users WHERE lower(email) = 'dekekenneth840@gmail.com' LIMIT 1").get();
  if (!owner) { console.log('FAIL: no owner row'); process.exit(1); }

  // fixture rows for the card (removed at the end)
  const fx = ['evt_FIXTURE_checkout', 'evt_FIXTURE_failure'];
  db.prepare(`INSERT OR REPLACE INTO stripe_webhook_events (id, event_id, event_type, outcome, user_id, plan, amount_cents, message, created_at)
              VALUES (?, ?, 'checkout.session.completed', 'plan-activated', ?, 'pro', 999, 'fixture: new guest account → pro (monthly)', unixepoch() - 42)`)
    .run('evt_FIXTURE_checkout:plan-activated', fx[0], 'fixture_user_1');
  db.prepare(`INSERT OR REPLACE INTO stripe_webhook_events (id, event_id, event_type, outcome, user_id, plan, amount_cents, message, created_at)
              VALUES (?, ?, 'customer.subscription.updated', 'acknowledged-failure', NULL, NULL, NULL, 'fixture: unknown price, acknowledged', unixepoch() - 600)`)
    .run('evt_FIXTURE_failure:acknowledged-failure', fx[1]);

  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });
  let apiHits = 0;
  const hitPaths = new Map();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.hostname !== 'haksterai.com') return req.continue();
    if (req.resourceType() === 'script' || req.resourceType() === 'stylesheet' || req.resourceType() === 'image' || req.resourceType() === 'font') return req.continue();
    if (url.pathname.startsWith('/api/')) {
      apiHits++;
      hitPaths.set(url.pathname, (hitPaths.get(url.pathname) || 0) + 1);
      if (url.pathname === '/api/auth/me') {
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: owner.id, username: 'owner', email: 'dekekenneth840@gmail.com', role: 'admin', is_owner: true, plan: owner.plan, status: 'active' } }) });
      }
      if (url.pathname === '/api/auth/authorize-page') {
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
    }
    req.continue();
  });

  await page.goto('https://haksterai.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((key) => { localStorage.setItem('hakster_google_token', key); }, owner.api_key);
  apiHits = 0; hitPaths.clear();
  await page.goto('https://haksterai.com/dashboard/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 6000));

  const first = await page.evaluate(() => ({
    title: document.title,
    rows: [...document.querySelectorAll('#stripehook-rows tr')].map(tr => tr.innerText.replace(/\s+/g, ' ').trim()),
    summary: document.getElementById('stripehook-summary')?.textContent || '',
    pill: document.getElementById('stripehook-cache')?.textContent || '',
    update: document.getElementById('crush-update-stamp')?.textContent || '',
    updateTitle: document.getElementById('crush-update-title')?.textContent || '',
    visible: document.getElementById('stripehook-section')?.getBoundingClientRect().height > 0,
  }));

  // 1s beat: sample the request count over 3 seconds
  const before = apiHits;
  await new Promise(r => setTimeout(r, 3000));
  const perSec = (apiHits - before) / 3;

  // "since last update" must advance on the update card
  const stampA = await page.evaluate(() => document.getElementById('crush-update-stamp')?.textContent || '');
  const agoA = (stampA.match(/(\d+[smh])/g) || []).join(',');
  await new Promise(r => setTimeout(r, 2500));
  const stampB = await page.evaluate(() => document.getElementById('crush-update-stamp')?.textContent || '');

  const top = [...hitPaths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log('page:', first.title, '| card visible:', first.visible);
  console.log('webhook card summary:', first.summary);
  console.log('webhook card pill:', first.pill);
  console.log('webhook rows:', first.rows.length, first.rows.slice(0, 2));
  console.log('update card title:', JSON.stringify(first.updateTitle));
  console.log('update card stamp:', JSON.stringify(first.update));
  console.log('stamp after 2.5s:', JSON.stringify(stampB), '| changed:', stampA !== stampB);
  console.log('requests/sec over 3s:', perSec.toFixed(1));
  console.log('top endpoints:', top.map(([p, n]) => p + '×' + n).join(', '));

  const pass = {
    cardRenders: first.visible && first.rows.length >= 2,
    rowsHaveAgo: first.rows.every(r => /ago/.test(r)),
    summaryHasFacts: /events/.test(first.summary) && /activated/.test(first.summary),
    updateHasSinceLastUpdate: /since last update|source checked/.test(first.update) && /ago/.test(first.update),
    updateStampAdvances: stampA !== stampB,
    oneSecondBeat: perSec >= 5,
  };
  console.log('\nchecks:', JSON.stringify(pass, null, 0));
  await page.screenshot({ path: '/tmp/hakster-dashboard-webhook-card.png', fullPage: false });
  await browser.close();

  // remove only the fixture rows
  db.prepare("DELETE FROM stripe_webhook_events WHERE event_id IN (?, ?)").run(fx[0], fx[1]);
  db.close();
  const ok = Object.values(pass).every(Boolean);
  console.log(ok ? '✅ dashboard checks passed' : '❌ dashboard checks failed');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e && e.message); process.exit(1); });
