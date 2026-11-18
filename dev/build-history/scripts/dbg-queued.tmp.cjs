const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => console.log('  console:', m.text().slice(0, 200)));
  page.on('pageerror', (e) => console.log('  PAGEERROR:', e.message.slice(0, 300)));
  await page.evaluateOnNewDocument(() => {
    const orig = window.fetch;
    window.__calls = [];
    window.fetch = function (input) {
      const u = String(input && input.url ? input.url : input);
      window.__calls.push(u);
      if (u.indexOf('/api/version?') !== -1) {
        const body = {
          build: document.documentElement.dataset.haksterBuild || '',
          server: { build: 'server-build', stale: true, pending: 3, files: [], idle: true, applying: false },
          checkedAt: new Date().toISOString(),
        };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (u.indexOf('/api/applet/status') !== -1) {
        return Promise.resolve(new Response(JSON.stringify({ job: { state: 'IDLE', label: 'Idle' }, stability: null }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      if (u.indexOf('/api/applet/stream') !== -1) return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } }));
      return orig.apply(this, arguments);
    };
  });
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 4000));
  const out = await page.evaluate(async () => {
    const d = () => document.getElementById('psa-detail');
    const before = d() ? d().textContent : 'NO EL';
    await window.__phantomApplet.check();
    return {
      before, after: d() ? d().textContent : 'NO EL',
      state: document.getElementById('phantom-server-applet').dataset.state,
      mode: document.getElementById('phantom-server-applet').dataset.mode,
      snap: window.__phantomApplet.snapshot(),
      pageBuild: document.documentElement.dataset.haksterBuild,
      calls: window.__calls,
    };
  }).catch((e) => ({ err: e.message }));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
