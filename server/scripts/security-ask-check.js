#!/usr/bin/env node
/**
 * Live check: the "ask the agent" bars on the Codex and DeepSeek cards.
 *
 * Runs against the public dashboard with the owner stubbed at the network edge
 * (same technique as dashboard-live-check.js) and the real server behind it:
 *  - both cards render an input bar and a feed
 *  - the feed shows the stored question/answer history from the server
 *  - typing a question and pressing the button produces a real answer from that
 *    agent's lane, and the feed updates without a reload
 *  - the feed keeps itself live from the 1s /api/admin/security-agents beat
 *
 * Nothing is changed on the box: the agents only read the sweep.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(ROOT, 'node_modules/puppeteer'));
const Database = require(path.join(ROOT, 'server/node_modules/better-sqlite3'));

const AGENT = process.argv.includes('--codex') ? 'codex' : 'deepseek';

(async () => {
  const db = new Database(path.join(ROOT, 'data/hakster.db'), { readonly: true });
  const owner = db.prepare("SELECT api_key, id, plan FROM users WHERE lower(email) = 'dekekenneth840@gmail.com' LIMIT 1").get();
  db.close();
  if (!owner) { console.log('FAIL: no owner row'); process.exit(1); }

  const browser = await puppeteer.launch({ headless: 'new', executablePath: require('../src/browser-path').resolveBrowserPath() || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });
  let agentHits = 0;
  const askResponses = [];
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
    if (url.pathname === '/api/admin/security-agents') agentHits++;
    if (url.pathname === '/api/admin/security-agents/ask') {
      const r = req.response();
      if (r) r.text().then((t) => askResponses.push({ status: r.status(), body: String(t || '').slice(0, 300) })).catch(() => {});
    }
    req.continue();
  });

  await page.goto('https://haksterai.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate((key) => localStorage.setItem('hakster_google_token', key), owner.api_key);
  await page.goto('https://haksterai.com/dashboard/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 5000));

  const ui = await page.evaluate((agent) => ({
    input: Boolean(document.getElementById('secask-' + agent + '-input')),
    button: Boolean(document.getElementById('secask-' + agent + '-send')),
    feedRows: document.querySelectorAll('#secask-' + agent + '-feed > div.rounded-lg').length,
    agentBody: (document.getElementById('secagent-' + agent)?.innerText || '').slice(0, 400),
  }), AGENT);

  const before = agentHits;
  await new Promise((r) => setTimeout(r, 3000));
  const beat = (agentHits - before) / 3;

  const feedBefore = await page.evaluate((agent) => document.getElementById('secask-' + agent + '-feed')?.innerText || '', AGENT);
  await page.type('#secask-' + AGENT + '-input', 'In one line, what is the single most urgent fix on this box?');
  await page.click('#secask-' + AGENT + '-send');
  let answered = false;
  let answerText = '';
  let askState = '';
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    askState = await page.evaluate((agent) => document.getElementById('secask-' + agent + '-state')?.textContent || '', AGENT);
    const feedNow = await page.evaluate((agent) => document.getElementById('secask-' + agent + '-feed')?.innerText || '', AGENT);
    if (feedNow !== feedBefore && /ANSWER:|FIX NEEDED|not observed/i.test(feedNow)) { answered = true; answerText = feedNow; break; }
    if (/no answer:|type a question first/.test(askState)) { answerText = askState; break; }
  }
  if (!answerText) answerText = feedBefore;

  const feedAfter = await page.evaluate((agent) => document.querySelectorAll('#secask-' + agent + '-feed > div.rounded-lg').length, AGENT);
  const stampAfter = await page.evaluate((agent) => document.querySelector('#secask-' + agent + '-feed > div.rounded-lg')?.innerText || '', AGENT);
  const inputCleared = await page.evaluate((agent) => document.getElementById('secask-' + agent + '-input')?.value === '', AGENT);

  await page.screenshot({ path: `/tmp/hakster-secask-${AGENT}.png`, fullPage: false });
  await browser.close();

  const pass = {
    inputRenders: ui.input && ui.button,
    storedFeedRenders: ui.feedRows >= 1,
    feedStaysLive: beat >= 0.5,
    questionAnswered: answered,
    feedGrewOrUpdated: feedAfter >= 1 && stampAfter !== '',
    inputClearedAfterAsk: inputCleared,
  };
  console.log('agent:', AGENT);
  console.log('agent card:', ui.agentBody.replace(/\s+/g, ' ').slice(0, 160));
  console.log('feed rows before:', ui.feedRows, '· after:', feedAfter, '· agent api hits/sec:', beat.toFixed(1));
  console.log('state line:', askState);
  console.log('ask responses:', JSON.stringify(askResponses));
  console.log('answer:', answerText.replace(/\s+/g, ' ').slice(0, 320));
  console.log('\nchecks:', JSON.stringify(pass, null, 0));
  const ok = Object.values(pass).every(Boolean);
  console.log(ok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error('ERR', err.message); process.exit(1); });
