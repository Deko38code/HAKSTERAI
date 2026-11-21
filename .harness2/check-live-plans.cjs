const puppeteer = require('/home/ghost/haksterAi/node_modules/puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('https://haksterai.com/plans/', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1500));
  const out = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#plan-grid > div')].map(c => ({
      title: (c.querySelector('h2') || {}).textContent || '',
      text: c.innerText.replace(/\s+/g, ' ').slice(0, 220),
    }));
    return { count: cards.length, cards };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
