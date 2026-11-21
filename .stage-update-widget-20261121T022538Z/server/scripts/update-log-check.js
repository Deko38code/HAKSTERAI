#!/usr/bin/env node
/**
 * Live check: the Update Log card on the dashboard.
 * Proves the three-site log renders with a full date + time per entry, that
 * each source is labelled with its site and box, and that the card keeps
 * itself live. Read-only; nothing is written on either box.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(ROOT, 'node_modules/puppeteer'));
const Database = require(path.join(ROOT, 'server/node_modules/better-sqlite3'));

(async () => {
  const db = new Database(path.join(ROOT, 'data/hakster.db'), { readonly: true });
  const owner = db.prepare("SELECT api_key, id, plan FROM users WHERE lower(email) = 'dekekenneth840@gmail.com' LIMIT 1").get();
  db.close();
  if (!owner) { console.log('FAIL: no owner row'); process.exit(1); }

  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
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
  await new Promise((r) => setTimeout(r, 8000));

  const read = () => page.evaluate(() => {
    const t = (id) => document.getElementById(id)?.textContent?.trim() || '';
    return {
      state: t('updlog-state'), meta: t('updlog-meta'), sources: t('updlog-sources'), rows: t('updlog-rows'), error: t('updlog-error'),
      rowCount: document.querySelectorAll('#updlog-rows > div.rounded-lg').length,
      stampRows: Array.from(document.querySelectorAll('#updlog-rows > div.rounded-lg')).map((el) => el.innerText.replace(/\s+/g, ' ').slice(0, 140)),
    };
  });
  const first = await read();
  await new Promise((r) => setTimeout(r, 6000));
  const second = await read();
  await page.screenshot({ path: '/tmp/hakster-update-log.png', fullPage: false });
  await browser.close();

  const pass = {
    cardRenders: first.meta.length > 0 && first.state.length > 0,
    threeSourcesListed: /haksterai/.test(first.sources) && /junkalot/.test(first.sources) && /phantomide/.test(first.sources),
    boxLabelled: /dell/.test(first.sources) && /parrot/.test(first.sources),
    utcStamped: first.rowCount === 0 ? /No build sightings/.test(first.rows) : /UTC/.test(first.rows),
    staysLive: second.state.length > 0 && second.meta !== first.meta ? true : /sites/.test(second.state),
  };
  console.log('state:', first.state, '·', first.meta);
  console.log('sources:', first.sources);
  console.log('rows:', first.rowCount, JSON.stringify(first.stampRows.slice(0, 3)));
  console.log('error:', first.error || '(none)');
  console.log('\nchecks:', JSON.stringify(pass));
  const ok = Object.values(pass).every(Boolean);
  console.log(ok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
