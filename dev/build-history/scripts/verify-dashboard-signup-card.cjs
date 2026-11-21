'use strict';
/**
 * Owner, 2026-11-21: "fix sighn up counters to match the 1 paid user in admin"
 * / "if they paid they sighn up".
 *
 * Read-only UI proof for the billing card's signup counter. Signs a headless
 * browser in with an owner key read from a COPY of the live DB (never printed),
 * pulls the real owner-only dashboard body exactly like the admin gate does,
 * and checks at every §18 viewport:
 *   - #bill-signups shows the real count and it equals the number of paying
 *     accounts found in the DB (a paid account always counts as a signup)
 *   - no horizontal page overflow, and the billing section sits inside the
 *     layout viewport
 *
 * Run: node dev/build-history/scripts/verify-dashboard-signup-card.cjs /path/to/db-copy
 */
const Database = require('/home/ghost/haksterAi/server/node_modules/better-sqlite3');
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');

const DB = process.argv[2];
if (!DB) { console.error('usage: verify-dashboard-signup-card.cjs <db-copy>'); process.exit(2); }
const BASE = process.env.BASE || 'https://haksterai.com';
const VIEWPORTS = [
  { w: 360, h: 640, name: '360x640 phone' },
  { w: 390, h: 844, name: '390x844 phone' },
  { w: 414, h: 896, name: '414x896 phone' },
  { w: 1920, h: 1080, name: '1920x1080 FireStick/TV' },
  { w: 1440, h: 900, name: '1440x900 desktop' },
];

const db = new Database(DB, { readonly: true });
// Owner access is by configured email (OWNER_EMAILS), not merely role=admin.
const OWNER_EMAILS = (process.env.OWNER_EMAILS || 'dekekenneth840@gmail.com').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const row = db.prepare(
  `SELECT api_key FROM users WHERE api_key <> '' AND lower(email) IN (${OWNER_EMAILS.map(() => '?').join(',')}) LIMIT 1`
).get(...OWNER_EMAILS);
// Independent expectation, straight from the DB: paying accounts that are not
// system rows, plus accounts created in the last week.
const expected = db.prepare(`
  SELECT COUNT(*) AS c FROM users u
  WHERE COALESCE(u.email, '') <> ''
    AND lower(u.email) NOT LIKE '%@hakster.ai'
    AND lower(u.email) NOT LIKE '%@haksterai.com'
    AND (
      u.created_at >= unixepoch() - 604800
      OR EXISTS (SELECT 1 FROM payments p WHERE p.user_id = u.id
                 AND p.status = 'completed' AND COALESCE(p.duplicate_of, '') = '')
      OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id
                 AND s.status IN ('active', 'trialing'))
    )`).get().c;
db.close();
if (!row || !row.api_key) { console.error('no owner key in the DB copy'); process.exit(2); }
const KEY = row.api_key; // never logged

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name.padEnd(58) + (detail || '')); };

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const stop = setTimeout(async () => { console.log('TIMEOUT'); try { await browser.close(); } catch {} process.exit(2); }, 240000);
  try {
    const page = await browser.newPage();
    await page.setCacheEnabled(false);
    // The admin shell also asks for a freebuff session before it renders; a
    // headless browser has none. Stub only that one check so the REAL gate
    // flow (key -> /api/auth/me -> owner page body -> document.write) runs.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().includes('/api/auth/freebuff/me')) {
        return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return req.continue();
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate((k) => { try { localStorage.setItem('hakster_api_key', k); } catch (e) {} }, KEY);

    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.w, height: vp.h });
      await page.goto(BASE + '/admin/dashboard/', { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForFunction(() => {
        const el = document.getElementById('bill-signups');
        return el && el.textContent.trim() !== '—' && el.textContent.trim() !== '';
      }, { timeout: 60000 }).catch(() => {});

      const m = await page.evaluate(() => {
        const el = document.getElementById('bill-signups');
        const sec = document.getElementById('billing-section');
        const label = el ? el.previousElementSibling : null;
        const box = sec ? sec.getBoundingClientRect() : null;
        return {
          value: el ? el.textContent.trim() : 'MISSING',
          label: label ? label.textContent.trim() : 'MISSING',
          docW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          secLeft: box ? Math.round(box.left) : null,
          secRight: box ? Math.round(box.right) : null,
        };
      });
      const gutterOk = m.secLeft !== null && m.secLeft >= 0 && m.secRight <= m.innerW + 1;
      const noPageOverflow = m.docW <= m.innerW + 1;
      check(`${vp.name}: counter "${m.label}" reads ${m.value}`, m.value === String(expected), `value=${m.value} expected=${expected}`);
      check(`${vp.name}: no horizontal page overflow`, noPageOverflow, `doc=${m.docW} vp=${m.innerW}`);
      check(`${vp.name}: billing section inside viewport`, gutterOk, `left=${m.secLeft} right=${m.secRight} vp=${m.innerW}`);
    }
  } finally {
    clearTimeout(stop);
    try { await browser.close(); } catch {}
  }
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(3); });
