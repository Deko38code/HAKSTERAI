// Signed-out "Create a bot" behaviour: every button on the page must open the
// sign-up / sign-in prompt and must NOT open the builder (owner, 2026-11-21:
// "create a bot when click dosent make me login should make any user clicking
// any create a bot buttons on page", "should always redirect if not sighned
// in", "make prompt for not logged in users to sign up or sign in").
const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');
const URL = process.argv[2] || 'http://127.0.0.1:5555/';
const HARD = setTimeout(() => { console.log('HARD TIMEOUT'); process.exit(2); }, 120000);
HARD.unref && HARD.unref();

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  const rows = [];
  const ok = (name, cond, detail) => { rows.push(!!cond); console.log((cond ? 'PASS ' : 'FAIL ') + name + ' — ' + detail); };
  try {
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 1500));

    const count = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('[onclick]')).filter((n) => /showCreate\s*\(/.test(n.getAttribute('onclick') || ''));
      return all.length;
    });
    // At least the nav link and the hero button are in the first paint; any
    // extra "+ Create a bot" rendered later by My Apps calls the same function.
    ok('the page has create-a-bot buttons', count >= 2, count + ' buttons call showCreate()');

    for (let i = 0; i < count; i++) {
      await page.evaluate(() => {
        const auth = document.getElementById('auth-modal'); if (auth) { auth.style.display = 'none'; auth.innerHTML = ''; }
        const create = document.getElementById('create-modal'); if (create) { create.style.display = 'none'; create.innerHTML = ''; }
      });
      const res = await page.evaluate((idx) => {
        const all = Array.from(document.querySelectorAll('[onclick]')).filter((n) => /showCreate\s*\(/.test(n.getAttribute('onclick') || ''));
        const btn = all[idx];
        if (!btn) return { missing: true };
        btn.click();
        const auth = document.getElementById('auth-modal');
        const create = document.getElementById('create-modal');
        const card = auth && auth.querySelector('.modal');
        const tabs = card ? Array.from(card.querySelectorAll('.auth-tab')).map((t) => t.textContent.trim()) : [];
        return {
          label: (btn.textContent || '').trim().slice(0, 30),
          authOpen: !!auth && getComputedStyle(auth).display !== 'none',
          prompt: !!(card && card.querySelector('.create-auth-prompt')),
          promptText: card && card.querySelector('.create-auth-prompt') ? card.querySelector('.create-auth-prompt').textContent.trim().slice(0, 90) : '',
          tabs,
          google: !!(card && /Continue with Google/.test(card.textContent || '')),
          createOpen: !!create && getComputedStyle(create).display !== 'none' && !!create.querySelector('.create-workspace'),
        };
      }, i);
      ok('button ' + (i + 1) + ' ("' + (res.label || '?') + '") opens the sign-in prompt', res.authOpen && res.prompt, res.promptText || 'no prompt shown');
      ok('button ' + (i + 1) + ' offers sign up AND sign in', res.tabs.includes('Sign In') && res.tabs.includes('Sign Up'), 'tabs ' + JSON.stringify(res.tabs) + (res.google ? ' + Google' : ''));
      ok('button ' + (i + 1) + ' does not open the builder while signed out', !res.createOpen, res.createOpen ? 'builder opened' : 'builder stayed closed');
    }
  } finally {
    await browser.close();
  }
  const bad = rows.filter((r) => !r).length;
  console.log(bad ? `\n${bad} check(s) FAILED` : '\nALL PASS');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('HARNESS FAIL', e.message); process.exit(1); });
