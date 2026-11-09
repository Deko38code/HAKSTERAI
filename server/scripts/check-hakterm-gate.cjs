#!/usr/bin/env node
/**
 * HakTerm / admin gate regression check.
 *
 * haksterai.com sits behind Cloudflare Rocket Loader, which rewrites every script in
 * an HTML response to a hashed non-JS type and injects a deferred loader. Pages that
 * are injected with document.write are never processed by that loader, so they paint
 * with all of their JavaScript dead (this is exactly how /hakterm/ "loaded but did
 * nothing" on 2026-11-08). The gates in server/src/index.js undo that rewrite before
 * writing the page in.
 *
 * This check proves it end to end, without touching production:
 *   1. takes the gate HTML the live server really serves (/hakterm/),
 *   2. takes the page /hakterm/ injects (the local HakTerm server on :8100),
 *   3. re-applies Cloudflare's rewrite to that page, simulating the edge,
 *   4. serves both on a throwaway port and drives a headless browser.
 *
 * Pass = the injected page boots, the composer sends (POST /api/run) and no
 * "scripts did not finish starting" banner is shown.
 *
 * Usage: node server/scripts/check-hakterm-gate.cjs [--live]
 *   --live  also assert the public gate carries no Rocket Loader rewrite
 */
const express = require('../node_modules/express');
const compression = require('../node_modules/compression');
const { Readable } = require('stream');

const CF_HASH = '1c8b9942b8404267b1879840';
const GATE_URL = process.env.HAKTERM_GATE_URL || 'http://127.0.0.1:3579/hakterm/';
const PAGE_URL = process.env.HAKTERM_PAGE_URL || 'http://127.0.0.1:8100/';
const PORT = Number(process.env.CHECK_PORT || 8313);

function rocketRewrite(html) {
  // Same shape the edge produces: hashed type, and a deferred loader tag appended.
  return html.replace(/<script([^>]*)>/g, (tag, attrs) => {
    const isModule = /\btype="module"/.test(attrs);
    const rest = attrs.replace(/\btype="[^"]*"/g, '');
    return `<script${rest} type="${CF_HASH}-${isModule ? 'module' : 'text/javascript'}">`;
  }) + `<script src="/cdn-cgi/scripts/7d0fa10a/cloudflare-static/rocket-loader.min.js" data-cf-settings="${CF_HASH}-|49" defer></script>`;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return await res.text();
}

(async () => {
  const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };

  if (process.argv.includes('--live')) {
    const live = await fetchText('https://haksterai.com/hakterm/').catch((e) => fail('live gate unreachable: ' + e.message));
    // Match the injected loader by its edge URL, not by the "rocket-loader" text our
    // own unRocket regex contains.
    if (/\/cdn-cgi\/scripts\/[^"]*rocket-loader\.min\.js/.test(live)) fail('live gate still has the Rocket Loader tag injected');
    const gateScript = /<script([^>]*)>/.exec(live);
    if (!gateScript || !/data-cfasync="false"/.test(gateScript[1])) fail('live gate script lost its data-cfasync="false" opt-out');
    console.log('ok  live gate is not rewritten by the edge');
  }

  const gateHtml = await fetchText(GATE_URL).catch((e) => fail('gate unreachable: ' + e.message));
  if (!/unRocket/.test(gateHtml)) fail('gate HTML has no unRocket transform — the document.write fix is gone');
  const pageHtml = await fetchText(PAGE_URL).catch((e) => fail('page unreachable: ' + e.message));

  const app = express();
  app.use(compression());
  app.use(express.json({ limit: '50mb' }));
  app.get('/api/auth/me', (req, res) => res.json({ user: { is_owner: true } }));
  app.get('/api/hakterm/page', async (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.send(rocketRewrite(pageHtml));
  });
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  app.use('/hakterm', async (req, res) => {
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      return res.send(gateHtml);
    }
    const upstreamPath = req.originalUrl.replace(/^\/hakterm/, '') || '/';
    const up = await fetch('http://127.0.0.1:8100' + upstreamPath, {
      method: req.method,
      headers: { 'content-type': req.get('content-type') || 'application/json', connection: 'close' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
    });
    res.status(up.status);
    up.headers.forEach((v, k) => { if (!['transfer-encoding', 'connection'].includes(k.toLowerCase())) res.setHeader(k, v); });
    if (/text\/event-stream/i.test(up.headers.get('content-type') || '')) {
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('x-accel-buffering', 'no');
      res.removeHeader('Content-Length');
      res.flushHeaders();
    }
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).pipe(res);
  });

  const { createRequire } = require('module');
  const requireRoot = createRequire(require.resolve('../../package.json'));
  const puppeteer = requireRoot('puppeteer');
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    let posted = false;
    page.on('request', (r) => { if (r.url().includes('/api/run')) posted = true; });
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('hakster_google_token', 'check');
        sessionStorage.setItem('hakster_hakterm_pass', '1');
      } catch {}
    });
    await page.goto(`http://127.0.0.1:${PORT}/hakterm/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 7000)); // past the gate's 6s canary
    const state = await page.evaluate(() => ({
      booted: !!window.__haktermBooted,
      hasInput: !!document.getElementById('in'),
      banner: [...document.querySelectorAll('div')].map((d) => d.textContent || '').find((t) => t.includes('did not finish starting')) || null,
    }));
    if (!state.hasInput) fail('injected page did not render its composer');
    if (state.banner) fail('canary banner shown: ' + state.banner);
    if (!state.booted) fail('page did not set __haktermBooted — injected scripts did not run');
    await page.click('#in');
    await page.type('#in', 'gate check');
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 3000));
    const composer = await page.$eval('#in', (el) => el.value);
    if (!posted) fail('Enter did not reach POST /api/run');
    if (composer.trim()) fail('composer did not clear after send');
    console.log('ok  injected page boots, no canary banner, Enter reached POST /api/run');
    console.log('PASS');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
