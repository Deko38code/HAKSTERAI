/* login.js — the CLI's sign-in: a magic link, verified in the browser.
 *
 * Owner 2026-11-23: "we need the auth flow for the login link magic link url
 * browser verfication to hakster cli" and "those plans and the auth gate when
 * needing to sighn in out usage etc wired to plans for users who pay".
 *
 * The terminal asks the server for a device code, prints a URL and a short
 * code, and waits. The operator opens the URL in a browser where they are
 * already signed in to haksterai.com, checks the code matches, and presses
 * Allow. Only then does the CLI receive the account's own API key, and only
 * once per approval. The key is written straight into ~/.hakster/config.json
 * (mode 600) and is never printed, logged or put in argv (§9, §23).
 *
 * Signing in proves who you are; it does not grant the CLI. The server's
 * `cli.included` flag is what says whether the account's plan includes the CLI,
 * so `hakster login` reports an upgrade path instead of pretending it worked.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.hakster');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort */ }
  const tmp = `${CONFIG_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, CONFIG_FILE);
}

function serverUrl(explicit) {
  const cfg = loadConfig();
  return String(explicit || cfg.server || process.env.HAKSTER_SERVER || 'https://haksterai.com').replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a URL in the desktop browser. The URL carries the short code only —
 *  never a key — so printing it or handing it to xdg-open is safe. */
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser: the printed URL is enough */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function getMe(origin, apiKey) {
  try {
    const res = await fetch(`${origin}/api/auth/me`, { headers: { 'x-api-key': apiKey } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.user) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Start the flow and wait for the browser's answer.
 * Resolves { ok, reason?, user?, cli?, server?, alreadySignedIn? }.
 * `opts.onPrompt` receives the URL/code so a TUI can render it instead of
 * printing; the CLI prints when the caller does not supply one.
 */
async function login(opts = {}) {
  const origin = serverUrl(opts.server);
  const say = typeof opts.onPrompt === 'function'
    ? opts.onPrompt
    : (line) => process.stdout.write(`${line}\n`);

  let start;
  try {
    const res = await fetch(`${origin}/api/cli/device/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hakster-client': 'cli' },
      body: JSON.stringify({ client: 'cli' }),
    });
    start = await res.json().catch(() => null);
    if (!res.ok || !start || !start.deviceCode) {
      return { ok: false, reason: `the server did not start a sign-in (http ${res.status})` };
    }
  } catch (e) {
    return { ok: false, reason: `cannot reach ${origin} (${(e && e.message) || e})` };
  }

  say('');
  say(`  Open this link in your browser and press Allow:`);
  say(`    ${start.verificationUrl}`);
  say(`  The page must show code  ${start.userCode}  — if it does not, stop.`);
  say('');
  if (opts.open !== false) openBrowser(start.verificationUrl);
  say(`  Waiting for approval… (Ctrl+C stops this; nothing is changed)`);

  const deadline = Date.now() + Math.max(30, Number(start.expiresInSeconds) || 900) * 1000;
  const intervalMs = Math.max(1, Number(start.intervalSeconds) || 2) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let poll = null;
    try {
      const res = await fetch(`${origin}/api/cli/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hakster-client': 'cli' },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      });
      poll = await res.json().catch(() => null);
      if (res.status === 403) return { ok: false, reason: 'the sign-in was denied in the browser' };
      if (res.status === 404) return { ok: false, reason: 'the code expired — run login again' };
    } catch {
      continue; // a dropped poll is not a failed sign-in; keep waiting
    }
    if (!poll || poll.status === 'pending') continue;
    if (poll.status !== 'approved' || !poll.apiKey) {
      return { ok: false, reason: (poll && poll.error) || `unexpected answer: ${poll && poll.status}` };
    }
    const cfg = loadConfig();
    cfg.server = String(poll.server || origin).replace(/\/+$/, '');
    cfg.apiKey = poll.apiKey;
    saveConfig(cfg);
    const me = await getMe(cfg.server, cfg.apiKey);
    return {
      ok: true,
      server: cfg.server,
      user: me && me.user,
      cli: (me && me.cli) || { included: !!poll.cliIncluded, minPriceCents: 2000, upgrade: '/plans/' },
    };
  }
  return { ok: false, reason: 'timed out waiting for the browser' };
}

/** Sign out: stop being signed in. Nothing else is touched. */
function logout() {
  const cfg = loadConfig();
  const had = !!cfg.apiKey;
  delete cfg.apiKey;
  saveConfig(cfg);
  delete process.env.HAKSTER_API_KEY;
  return had;
}

/** Who this session is, and whether the plan includes the CLI. */
async function whoami(opts = {}) {
  const cfg = loadConfig();
  const origin = serverUrl(opts.server || cfg.server);
  if (!cfg.apiKey) return { signedIn: false, server: origin };
  const me = await getMe(origin, cfg.apiKey);
  if (!me) return { signedIn: false, server: origin, reason: 'stored key was refused' };
  return { signedIn: true, server: origin, user: me.user, cli: me.cli };
}

module.exports = { login, logout, whoami, loadConfig, saveConfig, serverUrl };
