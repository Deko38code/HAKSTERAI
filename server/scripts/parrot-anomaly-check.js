#!/usr/bin/env node
/**
 * Live check: the anomaly detector card and the owner button audit.
 *
 * The Parrot sensor tiles were removed from this admin on 2026-11-16 (Deke:
 * "you put parrot server info in my haksterai admin") — this check asserts they
 * stay gone and only exercises this Dell box's own card.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(ROOT, 'node_modules/puppeteer'));
const Database = require(path.join(ROOT, 'server/node_modules/better-sqlite3'));

(async () => {
  const db = new Database(path.join(ROOT, 'data/hakster.db'));
  const owner = db.prepare("SELECT api_key, id, plan FROM users WHERE lower(email) = 'dekekenneth840@gmail.com' LIMIT 1").get();
  if (!owner) { console.log('FAIL: no owner row'); process.exit(1); }
  const clicksBefore = db.prepare("SELECT COUNT(*) c FROM user_activity WHERE action = 'admin_click'").get().c;

  const browser = await puppeteer.launch({ headless: 'new', executablePath: require('../src/browser-path').resolveBrowserPath() || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1400 });
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
  await new Promise((r) => setTimeout(r, 9000));

  const read = () => page.evaluate(() => {
    const t = (id) => document.getElementById(id)?.textContent?.trim() || '';
    return {
      anomState: t('anom-state'), anomMeta: t('anom-meta'), anomFindings: t('anom-findings'), anomPatterns: t('anom-patterns'),
      parrotCard: Boolean(document.getElementById('parrot-section') || document.getElementById('pcpu-pct')),
      parrotText: /Parrot Server/.test(document.body.innerText),
      updlogMeta: (document.getElementById('updlog-meta')?.textContent || '').trim(),
    };
  });
  const first = await read();

  await page.click('#anom-run');
  let after = first;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    after = await read();
    if (/last scan 20/.test(after.anomMeta) && !/never/.test(after.anomMeta)) break;
  }

  await page.screenshot({ path: '/tmp/hakster-anomaly.png', fullPage: false });
  await browser.close();

  const clicksAfter = db.prepare("SELECT COUNT(*) c FROM user_activity WHERE action = 'admin_click'").get().c;
  const lastClicks = db.prepare("SELECT endpoint, status_code, metadata FROM user_activity WHERE action = 'admin_click' ORDER BY id DESC LIMIT 3").all();
  db.close();

  const pass = {
    parrotCardRemoved: first.parrotCard === false && first.parrotText === false,
    anomalyCard: first.anomMeta.length > 0,
    anomalyScanned: /last scan 20/.test(after.anomMeta) && !/never/.test(after.anomMeta),
    anomalyFindingsRendered: after.anomFindings.length > 0,
    patternsRendered: after.anomPatterns.length > 0,
    updateLogCardLive: /entries|entry/.test(first.updlogMeta),
    clickAudited: clicksAfter > clicksBefore && lastClicks.some((c) => /anomaly/.test(c.endpoint || '')),
  };
  console.log('parrot card present:', first.parrotCard, '| "Parrot Server" text:', first.parrotText);
  console.log('anomaly before:', first.anomState, '·', first.anomMeta);
  console.log('anomaly after :', after.anomState, '·', after.anomMeta);
  console.log('update log:', first.updlogMeta);
  console.log('audit rows:', clicksBefore, '->', clicksAfter, JSON.stringify(lastClicks.slice(0, 2)));
  console.log('\nchecks:', JSON.stringify(pass));
  const ok = Object.values(pass).every(Boolean);
  console.log(ok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
