#!/usr/bin/env node
'use strict';

// anomaly-monitor.js — site-integrity, auth-bypass, listener and CLI/tmux anomaly watch.
//
//   node server/scripts/anomaly-monitor.js                     # loop, 5-minute passes
//   node server/scripts/anomaly-monitor.js --once              # one pass, send real alerts
//   node server/scripts/anomaly-monitor.js --once --dry-run    # one pass, print only
//   node server/scripts/anomaly-monitor.js --status            # current picture, no alerts
//   node server/scripts/anomaly-monitor.js --approve           # adopt current ports/apps as baseline
//   node server/scripts/anomaly-monitor.js --test              # prove Telegram delivery
//
// What it looks for:
//   sites      every hostname we serve: reachability, DNS, TLS expiry, identity marker,
//              unexpected redirect, missing/defaced page.
//   gates      admin/auth endpoints that must never answer 200 without a credential.
//   ports      new listening sockets on this box (a stub gate or a stray server shows up here).
//   services   pm2 apps that should be online but are not.
//   cli        our CLIs (claude, hakster, codex, kiro, phantom, omp...) running inside tmux,
//              plus where the session connects from. Anything outside the allowed origins,
//              or launched by a script that is not on the allowlist, is reported.
//   authlog    successful SSH logins from origins outside the allowlist, and failed-login bursts.
//
// Deliberately quiet: a finding alerts once when it appears, re-alerts only after
// `repeatHours` while it persists, and sends one recovery line when it clears. This is a
// change detector, not a chatterbox.

const fs = require('fs');
const path = require('path');
const https = require('https');
const dns = require('dns');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
try { require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') }); } catch {}

const DATA_DIR = path.join(ROOT, 'data');
const WATCHLIST_PATH = path.join(DATA_DIR, 'anomaly-watchlist.json');
const STATE_PATH = path.join(DATA_DIR, 'anomaly-state.json');
const UA = 'HaksterAI-AnomalyMonitor/1.0 (owner-authorized site integrity watch)';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const MODE_ONCE = flag('once') || flag('status');
const DRY = flag('dry-run') || flag('status');
const TEST = flag('test');
const APPROVE = flag('approve');
const INTERVAL_MIN = Math.max(1, Number(opt('interval', '5')) || 5);
const BOT_SLOT = opt('bot', 'TELEGRAM_BOT_TOKEN_5');

// ---------------------------------------------------------------- watchlist

function defaultWatchlist() {
  return {
    note: 'Owner-editable. Sites are the hostnames our tunnels actually serve. "must" strings are ' +
      'lower-case substrings that have to appear in the page for us to call it ours.',
    bot: BOT_SLOT,
    repeatHours: 6,
    timeoutMs: 15000,
    allowedOrigins: ['127.0.0.1/32', '::1', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
    allowedLaunchers: ['/bin/bash', '/bin/sh', '/usr/bin/zsh', 'tmux'],
    sites: [
      { host: 'haksterai.com', must: ['haksterai'] },
      { host: 'www.haksterai.com', must: ['haksterai'] },
      { host: 'rmt.haksterai.com', must: ['rent my trailer'] },
      { host: 'flixchill.link', must: ['cinevault'] },
      { host: 'www.flixchill.link', must: ['cinevault'] },
      { host: 'junkalot.co', must: ['junk-a-lot'] },
      { host: 'www.junkalot.co', must: ['junk-a-lot'] },
      { host: 'email-monitor-3230f40cc3.haksterai.com', must: ['email monitor'] },
      // Known-dark at install time (2026-11-08): kept on the watch list so they alert the
      // moment they start answering, and are reported as already-down in the baseline pass.
      { host: 'phantomide.com', must: [], note: 'no DNS records as of 2026-11-08' },
      { host: 'dash.phantomide.com', must: [], note: 'no DNS records as of 2026-11-08' },
      { host: 'junkalotjunkremoval.com', must: ['junk'], note: 'resolves to Wix, not our tunnel' },
      { host: 'rentmytrailer.haksterai.com', expectStatus: 200, must: [], note: 'app answers 404 for this host' }
    ],
    // A gate that answers 200 is only a bypass if it is not handing back a login screen.
    // "blocked" lists the codes we accept as "still gated".
    gates: [
      { name: 'haksterai admin', url: 'https://haksterai.com/admin/', blocked: [200, 301, 302, 307, 401, 403], loginMarkers: ['password', 'sign in', 'login'] },
      { name: 'rmt admin', url: 'https://rmt.haksterai.com/admin', blocked: [200, 301, 302, 307, 401, 403], loginMarkers: ['password', 'sign in', 'login', 'owner'] },
      { name: 'junkalot admin', url: 'https://junkalot.co/admin/security', blocked: [200, 301, 302, 307, 401, 403], loginMarkers: ['pin', 'passcode', 'password', 'unauthor', 'forbidden', 'owner'] },
      { name: 'cinevault admin', url: 'https://flixchill.link/admin', blocked: [200, 301, 302, 307, 401, 403], loginMarkers: ['pin', 'password', 'login', 'owner'] },
      { name: 'hakster api admin', url: 'https://haksterai.com/api/admin', blocked: [401, 403, 404], loginMarkers: [] }
    ],
    services: ['hakster', 'rmt', 'cinevault', 'miniforge', 'topreels-test', 'hakterm'],
    cliPatterns: ['hakster', 'claude', 'codex', 'kiro', 'phantom', 'freebuff', 'aider', 'gemini', 'omp'],
    authLog: '/var/log/auth.log',
    authLogLookbackMin: 30,
    failedLoginBurst: 20
  };
}

function loadWatchlist() {
  try {
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
    const base = defaultWatchlist();
    // Merge so a config written before a new section existed still gets the new defaults.
    return Object.assign({}, base, raw, {
      sites: Array.isArray(raw.sites) && raw.sites.length ? raw.sites : base.sites,
      gates: Array.isArray(raw.gates) && raw.gates.length ? raw.gates : base.gates
    });
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const base = defaultWatchlist();
    try { fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(base, null, 2) + '\n'); } catch {}
    return base;
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { version: 1, findings: {}, baseline: {} }; }
}
function saveState(s) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH + '.tmp', JSON.stringify(s, null, 2) + '\n');
    fs.renameSync(STATE_PATH + '.tmp', STATE_PATH);
  } catch (e) { console.error('state write failed: ' + e.message); }
}

// ---------------------------------------------------------------- helpers

function run(cmd, args, timeout = 12000) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function ipInCidr(ip, cidr) {
  if (cidr === ip) return true;
  if (!cidr.includes('/')) return false;
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const toLong = (a) => a.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toLong(ip) & mask) === (toLong(base) & mask);
}

// A tmux pane with no SSH_CONNECTION at all was started at the machine itself (console or
// an already-authenticated local login), so it counts as local. A pane that carries an
// SSH_CONNECTION is judged on where it came from.
function originAllowed(ip, allowed, { localIsAllowed = true } = {}) {
  if (!ip) return localIsAllowed;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  return allowed.some((c) => ipInCidr(ip, c));
}

function sha256(buf) { return require('crypto').createHash('sha256').update(buf).digest('hex'); }

// ---------------------------------------------------------------- probes

function httpsProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: 'bad-url' }); }
    const started = Date.now();
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      servername: u.hostname,
      rejectUnauthorized: true,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*', 'cache-control': 'no-cache' }
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (d) => {
        bytes += d.length;
        if (bytes <= 4 * 1024 * 1024) chunks.push(d);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let tlsDays = null;
        try {
          const cert = res.socket.getPeerCertificate();
          if (cert && cert.valid_to) tlsDays = Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000);
        } catch {}
        const text = body.toString('utf8');
        const title = (text.match(/<title[^>]*>([^<]*)/i) || [, ''])[1].trim();
        resolve({
          ok: true,
          status: res.statusCode,
          location: res.headers.location || '',
          title,
          bytes,
          sha: sha256(body),
          tlsDays,
          ms: Date.now() - started,
          text
        });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message, ms: Date.now() - started }));
    req.end();
  });
}

async function dnsCheck(host) {
  try { const a = await dns.promises.resolve4(host); return { ok: a.length > 0, addrs: a }; }
  catch (e) { return { ok: false, error: e.code || e.message, addrs: [] }; }
}

function listeners() {
  const out = run('ss', ['-ltnH']);
  const set = new Set();
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    const local = cols[3] || '';
    const m = local.match(/(.+):(\d+)$/);
    if (m) set.add(m[2] + ' ' + (m[1] === '*' || m[1] === '0.0.0.0' || m[1] === '[::]' ? 'all' : m[1]));
  }
  return [...set].sort();
}

function pm2Apps() {
  const raw = run('pm2', ['jlist']);
  if (!raw) return {};
  try {
    const list = JSON.parse(raw);
    const map = {};
    for (const a of list) map[a.name] = a.pm2_env && a.pm2_env.status;
    return map;
  } catch { return {}; }
}

function processTable() {
  const procs = {};
  let names;
  try { names = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return procs; }
  for (const pid of names) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rp = stat.lastIndexOf(')');
      const fields = stat.slice(rp + 2).split(' ');
      const ppid = Number(fields[1]);
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); } catch {}
      procs[pid] = { pid: Number(pid), ppid, cmd };
    } catch {}
  }
  return procs;
}

function sshConnectionOf(pid, procs) {
  // Walk up to the nearest process that carries an SSH_CONNECTION in its environment.
  let cur = pid;
  for (let depth = 0; cur && depth < 12; depth++) {
    try {
      const env = fs.readFileSync(`/proc/${cur}/environ`, 'utf8');
      const m = env.match(/SSH_CONNECTION=(\S+)\s+(\d+)\s+(\S+)\s+(\d+)/);
      if (m) return m[1];
    } catch {}
    cur = procs[cur] ? procs[cur].ppid : 0;
  }
  return null;
}

// ---------------------------------------------------------------- checks

function checkSites(wl, prevBaseline, findings) {
  const out = [];
  out.push((async () => {
    for (const site of wl.sites) {
      const url = `https://${site.host}/`;
      const dnsRes = await dnsCheck(site.host);
      if (!dnsRes.ok) {
        add(findings, `site:dns:${site.host}`, 'critical', `${site.host} does not resolve`,
          `DNS: ${dnsRes.error || 'no A records'}${site.note ? ' (' + site.note + ')' : ''}`);
        continue;
      }
      const r = await httpsProbe(url, wl.timeoutMs);
      if (!r.ok) {
        add(findings, `site:up:${site.host}`, 'critical', `${site.host} is not answering`,
          `probe failed after ${r.ms}ms: ${r.error}`);
        continue;
      }
      const want = Array.isArray(site.must) ? site.must : [];
      if (want.length) {
        const body = (r.text || '').toLowerCase();
        const missing = want.filter((s) => !body.includes(String(s).toLowerCase()));
        if (missing.length) {
          add(findings, `site:identity:${site.host}`, 'critical', `${site.host} lost its identity marker`,
            `status ${r.status}, ${r.bytes} bytes, missing: ${missing.join(', ')}. Possible defacement or a swapped origin.`);
        }
      }
      if (r.status >= 500) {
        add(findings, `site:status:${site.host}`, 'critical', `${site.host} returned ${r.status}`, `after ${r.ms}ms`);
      } else if (site.expectStatus && r.status !== site.expectStatus) {
        add(findings, `site:status:${site.host}`, 'warn', `${site.host} returned ${r.status}, expected ${site.expectStatus}`,
          site.note || '');
      } else if (r.status >= 400) {
        add(findings, `site:status:${site.host}`, 'warn', `${site.host} returned ${r.status}`, site.note || '');
      }
      if (r.tlsDays !== null && r.tlsDays < 14) {
        add(findings, `site:tls:${site.host}`, r.tlsDays < 5 ? 'critical' : 'warn',
          `${site.host} certificate expires in ${r.tlsDays} days`, 'renew before it lapses');
      }
      // A redirect off to a host we do not own is a hijack signal; a redirect within our own
      // namespaces (www, apex, trailing slash) is normal.
      if (r.location) {
        try {
          const to = new URL(r.location, url).hostname;
          const ours = wl.sites.some((s) => s.host === to) || to.endsWith('haksterai.com');
          if (!ours) {
            add(findings, `site:redirect:${site.host}`, 'critical', `${site.host} redirects off our infrastructure`,
              `to ${to}`);
          }
        } catch {}
      }
    }
  })());
  return out;
}

function checkGates(wl, findings) {
  return (async () => {
    for (const g of wl.gates) {
      const r = await httpsProbe(g.url, wl.timeoutMs);
      if (!r.ok) {
        add(findings, `gate:up:${g.name}`, 'warn', `${g.name} gate unreachable`, g.url + ' — ' + r.error);
        continue;
      }
      const accepted = Array.isArray(g.blocked) ? g.blocked : [401, 403];
      if (!accepted.includes(r.status)) {
        add(findings, `gate:status:${g.name}`, 'critical', `${g.name} answered ${r.status}`,
          `${g.url} returned a code we do not expect for an unauthenticated request.`);
        continue;
      }
      // 200 is only safe when it is a login/PIN screen. No marker means content came back
      // to an anonymous caller — that is the shape of an auth bypass.
      if (r.status === 200) {
        const body = (r.text || '').toLowerCase();
        const markers = Array.isArray(g.loginMarkers) ? g.loginMarkers : [];
        if (markers.length && !markers.some((m) => body.includes(String(m).toLowerCase()))) {
          add(findings, `gate:bypass:${g.name}`, 'critical',
            `${g.name} returned 200 with no login screen`,
            `${g.url} served ${r.bytes} bytes to an unauthenticated request and contains none of: ${markers.join(', ')}`);
        }
      }
    }
  })();
}

function checkPorts(wl, state, findings) {
  const now = listeners();
  const base = state.baseline.listeners;
  if (!Array.isArray(base)) return now; // first run becomes the baseline
  const known = new Set(base);
  for (const entry of now) {
    if (!known.has(entry)) {
      const [port, addr] = entry.split(' ');
      const exposed = addr === 'all';
      add(findings, `port:new:${entry}`, exposed ? 'critical' : 'warn',
        `new listening port ${port}${exposed ? ' on all interfaces' : ' on ' + addr}`,
        'If you did not open this deliberately it may be a stray service or a stub gate.');
    }
  }
  return now;
}

function checkServices(wl, findings) {
  const apps = pm2Apps();
  for (const name of wl.services || []) {
    if (!(name in apps)) continue; // app not on this box; nothing to assert
    if (apps[name] !== 'online') {
      add(findings, `service:${name}`, 'critical', `${name} is ${apps[name] || 'missing'}`, 'pm2 reports it down');
    }
  }
  return apps;
}

function checkTmuxCli(wl, findings) {
  // tmux escapes control bytes in its format output (a literal \u0001 comes back as "\001"),
  // so the field separator has to be plain printable text.
  const panes = run('tmux', ['list-panes', '-a', '-F',
    '#{session_name}|@@|#{window_index}.#{pane_index}|@@|#{pane_pid}|@@|#{pane_current_command}|@@|#{pane_start_command}']);
  if (!panes) return [];
  const procs = processTable();
  const childrenOf = {};
  for (const p of Object.values(procs)) (childrenOf[p.ppid] = childrenOf[p.ppid] || []).push(p);

  const seen = [];
  for (const line of panes.split('\n')) {
    const [session, winpane, pidRaw, current, startCmd] = line.split('\u0001').length > 1
      ? line.split('\u0001')
      : line.split('|@@|');
    const panePid = Number(pidRaw);
    if (!panePid) continue;
    // Everything running in this pane: the pane process itself (tmux runs the start command
    // directly when it is not an interactive shell) plus all of its descendants.
    const self = procs[panePid];
    const stack = [...(self ? [self] : []), ...(childrenOf[panePid] || [])];
    const inPane = [];
    while (stack.length) {
      const p = stack.pop();
      inPane.push(p);
      for (const c of childrenOf[p.pid] || []) stack.push(c);
    }
    const clis = inPane.filter((p) => {
      const name = (p.cmd.split(' ')[0] || '').split('/').pop().toLowerCase();
      return wl.cliPatterns.some((c) => name === c || name.startsWith(c));
    });
    if (!clis.length) continue;

    const origin = sshConnectionOf(panePid, procs);
    const allowed = originAllowed(origin, wl.allowedOrigins);
    const launchedByScript = /\.(sh|js|mjs|cjs|py)\b/.test(startCmd || '');
    for (const cli of clis) {
      const name = (cli.cmd.split(' ')[0] || '').split('/').pop();
      seen.push({ session, winpane, cli: name, origin, allowed });
      if (!allowed) {
        add(findings, `cli:origin:${session}:${name}`, 'critical',
          `${name} running in tmux from an unauthorised origin`,
          `session "${session}" pane ${winpane}, origin ${origin || 'unknown'}. Allowed origins: ${wl.allowedOrigins.join(', ')}`);
      }
      if (launchedByScript && !allowed) {
        add(findings, `cli:script:${session}:${name}`, 'critical',
          `tmux started a script with our CLI from an unauthorised origin`,
          `start command: ${startCmd}`);
      }
    }
  }
  return seen;
}

function checkAuthLog(wl, findings) {
  let text = '';
  try { text = fs.readFileSync(wl.authLog, 'utf8'); } catch { return { readable: false }; }
  const cutoff = Date.now() - (wl.authLogLookbackMin || 30) * 60000;
  let failed = 0;
  const accepted = [];
  for (const line of text.split('\n')) {
    const ts = Date.parse(line.slice(0, 23));
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const ok = line.match(/Accepted \S+ for (\S+) from (\S+)/);
    if (ok) { accepted.push({ user: ok[1], ip: ok[2] }); continue; }
    if (/Failed (password|publickey)|Invalid user/.test(line)) failed++;
  }
  for (const a of accepted) {
    if (!originAllowed(a.ip, wl.allowedOrigins)) {
      add(findings, `auth:login:${a.ip}`, 'critical', `SSH login from outside the allowlist`,
        `${a.user} from ${a.ip} in the last ${wl.authLogLookbackMin} minutes`);
    }
  }
  if (failed >= (wl.failedLoginBurst || 20)) {
    add(findings, `auth:burst`, 'warn', `${failed} failed SSH attempts in ${wl.authLogLookbackMin} minutes`,
      'brute-force pressure, not necessarily a breach');
  }
  return { readable: true, accepted: accepted.length, failed };
}

// ---------------------------------------------------------------- findings ledger

function add(findings, key, severity, title, detail) {
  const prev = findings[key];
  if (prev) {
    prev.lastSeen = new Date().toISOString();
    prev.severityValue = sev(severity);
    prev.title = title;
    prev.detail = detail;
    delete prev.clearedAt;
    return;
  }
  findings[key] = {
    severity,
    severityValue: sev(severity),
    title,
    detail,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    lastAlerted: null
  };
}
function sev(s) { return s === 'critical' ? 3 : s === 'warn' ? 2 : 1; }

function dueAlerts(state, wl) {
  const now = Date.now();
  const repeatMs = (wl.repeatHours || 6) * 3600000;
  const out = [];
  for (const [key, f] of Object.entries(state.findings)) {
    if (!f.lastAlerted) { out.push([key, f]); continue; }
    if (now - Date.parse(f.lastAlerted) >= repeatMs) out.push([key, f]);
  }
  return out.sort((a, b) => b[1].severityValue - a[1].severityValue);
}

// ---------------------------------------------------------------- telegram

function telegram(token, chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 15000
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try { const j = JSON.parse(raw); resolve(j.ok ? { ok: true, id: j.result.message_id } : { ok: false, error: String(j.description || 'error').slice(0, 100) }); }
        catch { resolve({ ok: false, error: 'unparsable' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message.slice(0, 80) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function chatIds() {
  const ids = new Set();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'telegram_chat_ids.json'), 'utf8'));
    for (const list of Object.values(data)) if (Array.isArray(list)) list.forEach((id) => ids.add(id));
  } catch {}
  if (process.env.TELEGRAM_OWNER_CHAT) ids.add(process.env.TELEGRAM_OWNER_CHAT);
  return [...ids];
}

async function deliver(wl, text) {
  const slot = wl.bot || BOT_SLOT;
  const token = process.env[slot];
  if (!token) return { ok: false, error: slot + ' has no token' };
  const ids = chatIds();
  if (!ids.length) return { ok: false, error: 'no known chat id' };
  const results = [];
  for (const id of ids) results.push(await telegram(token, id, text));
  return results[0];
}

// ---------------------------------------------------------------- pass

async function pass(wl, state) {
  const findings = {};

  await checkGates(wl, findings);
  await Promise.all(checkSites(wl, state.baseline, findings));
  const nowPorts = checkPorts(wl, state, findings);
  checkServices(wl, findings);
  const cliSeen = checkTmuxCli(wl, findings);
  const authlog = checkAuthLog(wl, findings);

  // Baseline is only ever written on the first pass or on --approve, so a new port or app
  // is reported even if it appears between passes.
  if (!Array.isArray(state.baseline.listeners)) state.baseline.listeners = nowPorts;
  if (APPROVE) state.baseline.listeners = nowPorts;
  if (!state.baseline.approvedAt) state.baseline.approvedAt = new Date().toISOString();

  // Reconcile with the previous ledger: keep first-seen, drop anything that healed.
  const previous = state.findings || {};
  const merged = {};
  for (const [key, f] of Object.entries(findings)) {
    const prev = previous[key];
    merged[key] = Object.assign({}, f, prev ? { firstSeen: prev.firstSeen, lastAlerted: prev.lastAlerted } : {});
  }
  const recovered = Object.keys(previous).filter((k) => !merged[k]);
  state.findings = merged;

  return { findings: merged, recovered, ports: nowPorts, cliSeen, authlog };
}

function formatFindings(list, recovered, extra) {
  const lines = [];
  const t = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  if (list.length) {
    lines.push('ANOMALY WATCH ' + t);
    const crit = list.filter(([, f]) => f.severity === 'critical');
    if (crit.length) lines.push('CRITICAL: ' + crit.length + '   WARN: ' + (list.length - crit.length));
    for (const [, f] of list.slice(0, 12)) {
      lines.push('');
      lines.push((f.severity === 'critical' ? '!! ' : '!  ') + f.title);
      if (f.detail) lines.push('   ' + f.detail);
    }
    if (list.length > 12) lines.push('', '...and ' + (list.length - 12) + ' more. Run --status for the full list.');
  }
  if (recovered.length) {
    lines.push('');
    lines.push('Recovered: ' + recovered.length + ' finding(s) cleared since last pass.');
  }
  if (extra) lines.push('', extra);
  return lines.join('\n');
}

function statusReport(state, pass_) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const lines = ['anomaly watch — ' + t];
  const f = Object.entries(state.findings || {});
  lines.push('');
  lines.push('findings: ' + f.length + ' (' + f.filter(([, v]) => v.severity === 'critical').length + ' critical)');
  for (const [key, v] of f) lines.push('  [' + v.severity + '] ' + v.title + '  (' + key + ')');
  lines.push('');
  lines.push('listening ports: ' + pass_.ports.length);
  lines.push('tmux CLI panes: ' + pass_.cliSeen.length);
  if (pass_.cliSeen.length) for (const c of pass_.cliSeen) lines.push('  ' + c.cli + ' in "' + c.session + '" from ' + (c.origin || 'local') + (c.allowed ? ' (allowed)' : ' (NOT ALLOWED)'));
  lines.push('auth log: ' + (pass_.authlog.readable ? pass_.authlog.accepted + ' accepted / ' + pass_.authlog.failed + ' failed in window' : 'not readable'));
  return lines.join('\n');
}

async function main() {
  const wl = loadWatchlist();
  const state = loadState();

  if (TEST) {
    const res = await deliver(wl, 'ANOMALY WATCH test — ' + new Date().toISOString().slice(0, 16) + ' UTC. Delivery path proven; no findings.');
    console.log(res.ok ? 'sent id=' + res.id : 'FAIL ' + res.error);
    process.exit(res.ok ? 0 : 1);
  }

  const runOnce = async () => {
    const result = await pass(wl, state);
    const pending = dueAlerts(state, wl);
    if (DRY) {
      console.log(statusReport(state, result));
      if (pending.length) { console.log('\n--- would send ---'); console.log(formatFindings(pending, result.recovered)); }
    } else if (pending.length || result.recovered.length) {
      const text = formatFindings(pending, result.recovered);
      const res = await deliver(wl, text);
      const stamp = new Date().toISOString();
      for (const [key] of pending) if (state.findings[key]) state.findings[key].lastAlerted = stamp;
      console.log((res.ok ? 'alerted id=' + res.id : 'ALERT DELIVERY FAILED: ' + res.error));
      if (!res.ok) console.log(text);
    } else {
      console.log('clean pass — ' + Object.keys(state.findings).length + ' open finding(s) still within the re-alert window');
    }
    for (const key of result.recovered) delete state.findings[key];
    saveState(state);
    return result;
  };

  if (MODE_ONCE) { await runOnce(); return; }

  console.log('anomaly-monitor: every ' + INTERVAL_MIN + ' min, bot ' + (wl.bot || BOT_SLOT));
  await runOnce();
  setInterval(() => { runOnce().catch((e) => console.error('pass failed: ' + e.message)); }, INTERVAL_MIN * 60000);
}

if (require.main === module) main().catch((e) => { console.error('fatal: ' + e.message); process.exit(1); });
module.exports = { httpsProbe, ipInCidr, originAllowed, listeners, defaultWatchlist };
