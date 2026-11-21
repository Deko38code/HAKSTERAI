'use strict';

// Read-only web vulnerability scanner for the owner's own sites.
//
// SCOPE IS FIXED: only the two hostnames below can be scanned through this module.
// Both are Deke's properties, so this is authorized owner-vs-own-site testing, the same
// category as the recon bot. Nothing here exploits, injects, brute-forces, or posts data:
// every check is a plain GET / HEAD / OPTIONS / TLS handshake against a public HTTPS
// endpoint, sequentially, with a small delay. Findings are reported, never acted on.
//
// Checks: TLS (validity, expiry, protocol, weak-version acceptance), redirect / HSTS
// enforcement, security headers, cookie flags, information disclosure, CORS reflection,
// HTTP method surface, sensitive-file exposure (fingerprinted, so an SPA fallback page
// cannot produce a false positive), auth-boundary sanity on admin-looking JSON endpoints,
// and served-site identity.
//
// CLI: node server/src/webVulnScanner.js [--target phantom|hakster|all] [--json]

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'web-vuln-scans.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'web-vuln-state.json');

const UA = 'HaksterAI-SecurityBot/1.0 (owner-authorized read-only scan)';
const TIMEOUT_MS = 12000;
const BODY_LIMIT = 256 * 1024;
const PROBE_GAP_MS = 120;

const TARGETS = {
  phantom: {
    key: 'phantom',
    name: 'PhantomIDE',
    host: 'phantomide.com',
    origin: 'https://phantomide.com',
    titleMustMatch: /phantom/i,
  },
  hakster: {
    key: 'hakster',
    name: 'HaksterAI',
    host: 'haksterai.com',
    origin: 'https://haksterai.com',
    titleMustMatch: /hakster/i,
  },
};

// ── helpers ────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shortErr(e) {
  const m = String((e && (e.cause && e.cause.code)) || (e && e.code) || (e && e.message) || e);
  return m.split('\n')[0].slice(0, 140);
}

// Fetch with a hard timeout and a body cap. Redirects are NOT followed by default here:
// the redirect chain itself is one of the checks.
async function hit(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      redirect: opts.redirect || 'manual',
      signal: ctrl.signal,
      headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, opts.headers || {}),
    });
    let body = '';
    if (opts.readBody !== false && res.body) {
      const reader = res.body.getReader();
      let got = 0;
      const chunks = [];
      while (got < (opts.bodyLimit || BODY_LIMIT)) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        chunks.push(value);
      }
      try { await reader.cancel(); } catch {}
      body = Buffer.concat(chunks).subarray(0, opts.bodyLimit || BODY_LIMIT).toString('utf8');
    }
    const headers = {};
    for (const [k, v] of res.headers.entries()) headers[k.toLowerCase()] = v;
    return { ok: true, status: res.status, headers, body, ms: Date.now() - started, url };
  } catch (e) {
    return { ok: false, error: shortErr(e), ms: Date.now() - started, url };
  } finally {
    clearTimeout(timer);
  }
}

// TLS handshake inspection. rejectUnauthorized:false on purpose — we want to SEE a bad
// certificate, not fail before we can describe it.
function tlsInfo(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    const sock = tls.connect({ host, servername: host, port: 443, rejectUnauthorized: false, timeout: 9000 }, () => {
      const cert = sock.getPeerCertificate(true) || {};
      finish({
        ok: true,
        authorized: sock.authorized,
        authorizationError: sock.authorizationError ? String(sock.authorizationError).slice(0, 120) : null,
        protocol: sock.getProtocol(),
        cipher: (sock.getCipher() || {}).name || null,
        subject: cert.subject ? cert.subject.CN : null,
        issuer: cert.issuer ? cert.issuer.O || cert.issuer.CN : null,
        validTo: cert.valid_to || null,
        daysLeft: cert.valid_to ? Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 86400000) : null,
      });
    });
    sock.on('error', (e) => finish({ ok: false, error: shortErr(e) }));
    sock.on('timeout', () => finish({ ok: false, error: 'handshake timeout' }));
  });
}

// Ask for the oldest TLS on purpose. If the server answers a 1.0/1.1 handshake that is a
// real finding; if the local OpenSSL refuses to even offer it, report "untested" and do
// not pretend the server passed.
function legacyTlsAccepted(host) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    const sock = tls.connect({ host, servername: host, port: 443, minVersion: 'TLSv1', maxVersion: 'TLSv1.1', rejectUnauthorized: false, timeout: 7000 }, () => {
      finish({ accepted: true, protocol: sock.getProtocol() });
    });
    sock.on('error', (e) => {
      const m = shortErr(e).toLowerCase();
      const untestable = /unsupported protocol|no protocols available|wrong version number|unknown protocol|protocol version|version too low/i.test(m);
      finish({ accepted: false, untestable });
    });
    sock.on('timeout', () => finish({ accepted: false, untestable: true }));
  });
}

function findTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

function cookiesFrom(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return [];
  return String(raw).split(/,(?=\s*[A-Za-z0-9_.-]+=)/).map((c) => c.trim()).filter(Boolean);
}

// ── checks ────────────────────────────────────────────────────────────────────────────

const SENSITIVE_PATHS = [
  { p: '/.env', re: /^[A-Za-z_][A-Za-z0-9_]*=.+/m, what: 'dotenv secrets file' },
  { p: '/.env.local', re: /^[A-Za-z_][A-Za-z0-9_]*=.+/m, what: 'dotenv secrets file' },
  { p: '/.env.production', re: /^[A-Za-z_][A-Za-z0-9_]*=.+/m, what: 'dotenv secrets file' },
  { p: '/.git/HEAD', re: /^ref:\s+refs\//, what: 'exposed git repository' },
  { p: '/.git/config', re: /\[core\]/, what: 'exposed git config' },
  { p: '/.svn/entries', re: /^\d+\s*$/m, what: 'exposed svn metadata' },
  { p: '/.DS_Store', re: /Bud1/, what: 'macOS .DS_Store' },
  { p: '/package.json', re: /"name"\s*:/, what: 'package manifest', infoOnly: true },
  { p: '/composer.json', re: /"require"\s*:/, what: 'composer manifest', infoOnly: true },
  { p: '/server.js', re: /require\(|module\.exports/, what: 'server source code' },
  { p: '/backup.sql', re: /CREATE TABLE|INSERT INTO/i, what: 'database dump' },
  { p: '/dump.sql', re: /CREATE TABLE|INSERT INTO/i, what: 'database dump' },
  { p: '/db.sql', re: /CREATE TABLE|INSERT INTO/i, what: 'database dump' },
  { p: '/wp-config.php.bak', re: /DB_PASSWORD|DB_NAME/, what: 'WordPress config backup' },
  { p: '/config.php.bak', re: /DB_PASSWORD|mysqli|PDO/, what: 'PHP config backup' },
  { p: '/phpinfo.php', re: /phpinfo\(\)/, what: 'phpinfo disclosure' },
  { p: '/server-status', re: /Apache Server Status/, what: 'Apache status page' },
  { p: '/.htaccess', re: /RewriteEngine|Options\s/, what: '.htaccess ruleset' },
  { p: '/web.config', re: /<configuration>/, what: 'IIS web.config' },
  { p: '/id_rsa', re: /BEGIN (RSA |OPENSSH )?PRIVATE KEY/, what: 'private key' },
  { p: '/.aws/credentials', re: /aws_access_key_id/, what: 'AWS credentials' },
];

const AUTH_PROBES = {
  phantom: ['/api/admin/monitor', '/api/admin/keys', '/api/phantom/keys', '/api/builders/ledger'],
  hakster: ['/api/admin/security/incidents', '/api/admin/users', '/api/admin/stats'],
};

function add(list, severity, id, title, detail, url) {
  list.push({ id, severity, title, detail: detail || '', url: url || '' });
}

async function scanTarget(key) {
  const cfg = TARGETS[key];
  if (!cfg) throw new Error(`target "${key}" is not in the authorized scope`);

  const findings = [];
  const facts = { host: cfg.host, origin: cfg.origin };
  const t0 = Date.now();

  // 1. TLS
  const cert = tlsInfo(cfg.host);
  const legacy = legacyTlsAccepted(cfg.host);
  const [tlsRes, legacyRes] = await Promise.all([cert, legacy]);
  facts.tls = tlsRes;
  if (!tlsRes.ok) {
    add(findings, 'high', `${key}:tls-handshake`, 'TLS handshake failed', `Could not complete a handshake with ${cfg.host}: ${tlsRes.error}`, cfg.origin);
  } else {
    if (!tlsRes.authorized) {
      add(findings, 'high', `${key}:tls-invalid`, 'Certificate not trusted', `Chain validation failed: ${tlsRes.authorizationError || 'unknown reason'}`, cfg.origin);
    }
    if (typeof tlsRes.daysLeft === 'number') {
      if (tlsRes.daysLeft < 0) add(findings, 'high', `${key}:cert-expired`, 'Certificate expired', `Expired ${Math.abs(tlsRes.daysLeft)} day(s) ago`, cfg.origin);
      else if (tlsRes.daysLeft < 21) add(findings, 'high', `${key}:cert-expiry`, 'Certificate expires soon', `${tlsRes.daysLeft} day(s) left`, cfg.origin);
      else if (tlsRes.daysLeft < 45) add(findings, 'medium', `${key}:cert-expiry`, 'Certificate expiring', `${tlsRes.daysLeft} day(s) left`, cfg.origin);
    }
    if (tlsRes.protocol === 'TLSv1' || tlsRes.protocol === 'TLSv1.1') {
      add(findings, 'high', `${key}:tls-old`, 'Legacy TLS negotiated', `Negotiated ${tlsRes.protocol} with ${tlsRes.cipher}`, cfg.origin);
    }
    if (legacyRes.accepted) {
      add(findings, 'high', `${key}:tls-legacy-accepted`, 'TLS 1.0/1.1 accepted', `Server answered a ${legacyRes.protocol} handshake`, cfg.origin);
    }
  }
  facts.legacyTls = legacyRes.accepted ? 'accepted' : (legacyRes.untestable ? 'untestable locally' : 'refused');

  // 2. HTTP → HTTPS enforcement + main page
  const httpRes = await hit(`http://${cfg.host}/`, { readBody: false, redirect: 'manual' });
  const main = await hit(cfg.origin + '/');
  if (!main.ok) {
    add(findings, 'high', `${key}:unreachable`, 'Site unreachable over HTTPS', `${main.error} after ${main.ms} ms`, cfg.origin);
    return finish(key, cfg, findings, facts, t0);
  }
  facts.status = main.status;
  facts.ms = main.ms;
  facts.server = main.headers.server || null;
  facts.poweredBy = main.headers['x-powered-by'] || null;
  facts.title = findTitle(main.body);

  if (httpRes.ok && httpRes.status < 300 && httpRes.status >= 200) {
    add(findings, 'high', `${key}:no-https-redirect`, 'Plain HTTP served without redirect', `GET http://${cfg.host}/ returned ${httpRes.status} instead of redirecting to HTTPS`, `http://${cfg.host}/`);
  } else if (httpRes.ok && httpRes.status >= 300 && httpRes.status < 400) {
    const loc = httpRes.headers.location || '';
    if (!/^https:\/\//i.test(loc)) {
      add(findings, 'medium', `${key}:http-redirect-not-https`, 'HTTP redirect not pointed at HTTPS', `Location: ${loc || '(none)'}`, `http://${cfg.host}/`);
    }
  }

  if (cfg.titleMustMatch && facts.title && !cfg.titleMustMatch.test(facts.title)) {
    add(findings, 'medium', `${key}:identity`, 'Served page identity unexpected', `Title is "${facts.title}" — did not match /${cfg.titleMustMatch.source}/`, cfg.origin);
  }

  // 3. Security headers
  const h = main.headers;
  const csp = h['content-security-policy'] || '';
  if (!h['strict-transport-security']) {
    add(findings, 'medium', `${key}:hsts-missing`, 'No HSTS header', 'strict-transport-security absent, so a first request can be downgraded', cfg.origin);
  } else {
    const m = String(h['strict-transport-security']).match(/max-age=(\d+)/i);
    if (!m) add(findings, 'low', `${key}:hsts-no-maxage`, 'HSTS without max-age', h['strict-transport-security'], cfg.origin);
    else if (Number(m[1]) < 15552000) add(findings, 'low', `${key}:hsts-short`, 'HSTS max-age under 180 days', `max-age=${m[1]}`, cfg.origin);
  }
  if (!csp) {
    add(findings, 'medium', `${key}:csp-missing`, 'No Content-Security-Policy', 'No CSP means no browser-side mitigation for injected script', cfg.origin);
  } else if (!/frame-ancestors/i.test(csp)) {
    add(findings, 'low', `${key}:csp-no-frame-ancestors`, 'CSP without frame-ancestors', 'Clickjacking protection depends on X-Frame-Options only', cfg.origin);
  }
  const xfo = h['x-frame-options'];
  if (!xfo && !/frame-ancestors/i.test(csp)) {
    add(findings, 'medium', `${key}:clickjacking`, 'No clickjacking protection', 'Neither X-Frame-Options nor CSP frame-ancestors is set', cfg.origin);
  }
  if (String(h['x-content-type-options'] || '').toLowerCase() !== 'nosniff') {
    add(findings, 'low', `${key}:nosniff-missing`, 'Missing X-Content-Type-Options: nosniff', h['x-content-type-options'] || '(absent)', cfg.origin);
  }
  if (!h['referrer-policy']) {
    add(findings, 'low', `${key}:referrer-policy`, 'No Referrer-Policy', 'Referrer URLs may leak to third parties', cfg.origin);
  }
  if (!h['permissions-policy']) {
    add(findings, 'info', `${key}:permissions-policy`, 'No Permissions-Policy', 'Camera/microphone/geolocation are not explicitly restricted', cfg.origin);
  }

  // 4. Cookies
  const cookies = cookiesFrom(h);
  facts.cookies = cookies.length;
  for (const c of cookies) {
    const name = (c.split('=')[0] || '').trim();
    const looksSession = /session|sid|token|jwt|auth|key/i.test(name);
    if (!/;\s*secure/i.test(c)) {
      add(findings, looksSession ? 'high' : 'medium', `${key}:cookie-secure`, `Cookie "${name}" without Secure flag`, 'A non-Secure cookie can be sent over plain HTTP', cfg.origin);
    }
    if (!/;\s*httponly/i.test(c) && looksSession) {
      add(findings, 'high', `${key}:cookie-httponly`, `Session cookie "${name}" readable by JavaScript`, 'HttpOnly is missing on a session-like cookie', cfg.origin);
    }
    if (!/;\s*samesite/i.test(c)) {
      add(findings, 'low', `${key}:cookie-samesite`, `Cookie "${name}" without SameSite`, 'Cross-site requests may carry it', cfg.origin);
    }
  }

  // 5. Information disclosure
  if (/\/\d|[\d.]+$/i.test(String(h.server || '')) && /\d/.test(String(h.server || ''))) {
    add(findings, 'low', `${key}:server-version`, 'Server version disclosed', h.server, cfg.origin);
  }
  if (h['x-powered-by']) {
    add(findings, 'low', `${key}:powered-by`, 'X-Powered-By disclosed', h['x-powered-by'], cfg.origin);
  }
  if (/at\s+\/[A-Za-z0-9_.-]+\/.*:\d+:\d+/.test(main.body) || /node_modules\//.test(main.body)) {
    add(findings, 'high', `${key}:stack-trace`, 'Stack trace or filesystem path in page body', 'The public page contains code paths/line numbers', cfg.origin);
  }

  // 6. CORS reflection
  const cors = await hit(cfg.origin + '/', { headers: { Origin: 'https://evil.invalid' }, readBody: false });
  if (cors.ok) {
    const acao = cors.headers['access-control-allow-origin'] || '';
    const acac = String(cors.headers['access-control-allow-credentials'] || '').toLowerCase();
    if (acao === 'https://evil.invalid') {
      add(findings, acac === 'true' ? 'high' : 'medium', `${key}:cors-reflect`, 'CORS reflects an arbitrary origin', `Access-Control-Allow-Origin: ${acao}${acac === 'true' ? ' + credentials' : ''}`, cfg.origin);
    } else if (acao === '*' && acac === 'true') {
      add(findings, 'high', `${key}:cors-wildcard`, 'CORS wildcard with credentials', 'Access-Control-Allow-Origin: * plus credentials', cfg.origin);
    }
  }

  // 7. HTTP method surface
  const opt = await hit(cfg.origin + '/', { method: 'OPTIONS', readBody: false });
  if (opt.ok) {
    facts.allow = opt.headers.allow || null;
    const allow = String(opt.headers.allow || '').toUpperCase();
    if (/\b(PUT|DELETE|PATCH)\b/.test(allow)) {
      add(findings, 'info', `${key}:methods`, 'Writable HTTP methods advertised', `Allow: ${opt.headers.allow}`, cfg.origin);
    }
  }
  const trace = await hit(cfg.origin + '/', { method: 'TRACE', readBody: false });
  if (trace.ok && trace.status >= 200 && trace.status < 300) {
    add(findings, 'medium', `${key}:trace`, 'TRACE method accepted', `TRACE returned ${trace.status}`, cfg.origin);
  }

  // 8. Sensitive paths (fingerprinted — an SPA fallback page cannot match these shapes)
  await sleep(PROBE_GAP_MS);
  const exposed = [];
  for (const probe of SENSITIVE_PATHS) {
    const r = await hit(cfg.origin + probe.p, { bodyLimit: 64 * 1024 });
    if (r.ok && r.status === 200 && !/text\/html/i.test(r.headers['content-type'] || '') && probe.re.test(r.body)) {
      exposed.push({ path: probe.p, what: probe.what, infoOnly: !!probe.infoOnly });
    }
    await sleep(PROBE_GAP_MS);
  }
  facts.exposedPaths = exposed.map((e) => e.path);
  for (const e of exposed) {
    add(findings, e.infoOnly ? 'info' : 'high', `${key}:exposed${e.path}`, `Exposed ${e.what}`, `${cfg.origin}${e.path} returned 200 with matching content`, cfg.origin + e.path);
  }
  // Positive signal: a security.txt is good practice.
  const sct = await hit(cfg.origin + '/.well-known/security.txt', { bodyLimit: 8192 });
  facts.securityTxt = !!(sct.ok && sct.status === 200 && /Contact:/i.test(sct.body));

  // 9. Auth boundary sanity on admin-looking JSON endpoints (GET only, never POST)
  for (const p of AUTH_PROBES[key] || []) {
    const r = await hit(cfg.origin + p, { bodyLimit: 16 * 1024 });
    if (r.ok && r.status === 200 && /application\/json/i.test(r.headers['content-type'] || '')) {
      const body = r.body.trim();
      if (body.length > 2 && !/unauthorized|forbidden|login required|not authenticated/i.test(body)) {
        add(findings, 'medium', `${key}:auth-boundary${p}`, 'Admin endpoint answered without auth', `${cfg.origin}${p} returned 200 JSON. Confirm this is intended to be public.`, cfg.origin + p);
      }
    }
    await sleep(PROBE_GAP_MS);
  }

  return finish(key, cfg, findings, facts, t0);
}

function finish(key, cfg, findings, facts, t0) {
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  const counts = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const grade = counts.high ? 'F' : counts.medium > 3 ? 'C' : counts.medium ? 'B' : counts.low ? 'A' : 'A+';
  const signature = crypto
    .createHash('sha256')
    .update(findings.map((f) => `${f.id}:${f.severity}`).sort().join('|'))
    .digest('hex')
    .slice(0, 12);
  return {
    target: { key: cfg.key, name: cfg.name, host: cfg.host },
    ok: !findings.some((f) => f.id.endsWith(':unreachable')),
    grade,
    counts,
    findings,
    facts,
    signature,
    durationMs: Date.now() - t0,
    generatedAt: new Date().toISOString(),
  };
}

// ── multi-target + persistence ────────────────────────────────────────────────────────

async function scanAll(keys) {
  const list = keys && keys.length ? keys : Object.keys(TARGETS);
  const results = [];
  for (const k of list) results.push(await scanTarget(k));
  const summary = { high: 0, medium: 0, low: 0, info: 0 };
  for (const r of results) for (const s of Object.keys(summary)) summary[s] += r.counts[s] || 0;
  const combined = {
    generatedAt: new Date().toISOString(),
    targets: results,
    summary,
    signature: crypto.createHash('sha256').update(results.map((r) => `${r.target.key}=${r.signature}`).join('|')).digest('hex').slice(0, 12),
  };
  return combined;
}

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function persistScan(combined) {
  try {
    ensureDataDir();
    fs.appendFileSync(
      HISTORY_FILE,
      JSON.stringify({ at: combined.generatedAt, signature: combined.signature, summary: combined.summary, targets: combined.targets.map((t) => ({ key: t.target.key, grade: t.grade, counts: t.counts, signature: t.signature, findings: t.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title })) })) }) + '\n'
    );
    // State file: previous version kept beside it, never replaced outright. Carry the
    // last DELIVERED signature forward — a scan must not erase the delivery bookkeeping.
    let previous = null;
    try { previous = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
    if (previous) {
      try { fs.writeFileSync(STATE_FILE + '.prev', JSON.stringify(previous)); } catch {}
    }
    const nextState = { at: combined.generatedAt, signature: combined.signature, summary: combined.summary, grades: combined.targets.map((t) => ({ key: t.target.key, grade: t.grade, counts: t.counts })) };
    if (previous && previous.reportedSignature) {
      nextState.reportedSignature = previous.reportedSignature;
      if (previous.reportedAt) nextState.reportedAt = previous.reportedAt;
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
    return true;
  } catch (e) {
    console.error('[webscan] persist failed:', e.message);
    return false;
  }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

// Last recorded scan, for "what changed since the previous run" comparisons.
function lastHistory() {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
    const last = lines[lines.length - 1];
    return last ? JSON.parse(last) : null;
  } catch { return null; }
}

// Record that this finding set actually reached Telegram. The scheduled reporter compares
// against reportedSignature (not merely the last scan), so a failed send is retried on the
// next cycle instead of being silently swallowed.
function markReported(signature) {
  try {
    ensureDataDir();
    const st = loadState() || {};
    st.reportedSignature = signature;
    st.reportedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
    return true;
  } catch (e) {
    console.error('[webscan] markReported failed:', e.message);
    return false;
  }
}

// ── report formatting ────────────────────────────────────────────────────────────────

const DOT = { high: '🔴', medium: '🟠', low: '🟡', info: '⚪' };

function formatReport(combined, opts = {}) {
  const lines = [];
  const when = combined.generatedAt.replace('T', ' ').replace(/\..*$/, ' UTC');
  lines.push(`🔒 Web vulnerability scan — ${when}`);
  const s = combined.summary;
  lines.push(`Total: ${s.high} high · ${s.medium} medium · ${s.low} low · ${s.info} info`);
  lines.push('');
  for (const t of combined.targets) {
    const c = t.counts;
    lines.push(`${t.grade === 'F' ? '❌' : t.counts.high ? '❌' : t.counts.medium ? '⚠️' : '✅'} ${t.target.name} — ${t.target.host}`);
    lines.push(`   grade ${t.grade} · ${c.high} high · ${c.medium} medium · ${c.low} low`);
    const shown = opts.maxFindings ? t.findings.filter((f) => f.severity !== 'info').slice(0, opts.maxFindings) : t.findings.filter((f) => f.severity !== 'info');
    for (const f of shown) {
      const isNew = opts.newIds && opts.newIds.has(f.id) ? ' 🆕' : '';
      lines.push(`   ${DOT[f.severity]} ${f.title}${isNew}${f.detail ? ' — ' + f.detail : ''}`);
    }
    if (!shown.length) lines.push('   no actionable findings');
    lines.push(`   TLS ${t.facts.tls && t.facts.tls.protocol ? t.facts.tls.protocol : '?'} · cert ${t.facts.tls && t.facts.tls.daysLeft != null ? t.facts.tls.daysLeft + 'd' : '?'} · ${t.facts.ms || '?'} ms`);
    lines.push('');
  }
  lines.push('Read-only scan of owner-authorized hosts. Nothing was changed or exploited.');
  const text = lines.join('\n');
  return text.length > 3800 ? text.slice(0, 3790) + '\n…(truncated)' : text;
}

function describeNewFindings(current, previous) {
  if (!previous || !previous.targets) return [];
  const prevIds = new Set();
  for (const t of previous.targets) for (const f of t.findings || []) prevIds.add(f.id);
  const out = [];
  for (const t of current.targets) {
    for (const f of t.findings) if (f.severity !== 'info' && !prevIds.has(f.id)) out.push({ target: t.target.name, ...f });
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────

module.exports = {
  TARGETS,
  scanTarget,
  scanAll,
  persistScan,
  loadState,
  loadHistoryLast: lastHistory,
  markReported,
  formatReport,
  describeNewFindings,
  HISTORY_FILE,
  STATE_FILE,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--target');
  const want = ti >= 0 ? String(argv[ti + 1] || 'all') : 'all';
  const keys = want === 'all' ? Object.keys(TARGETS) : [want];
  if (!keys.every((k) => TARGETS[k])) {
    console.error(`unknown target "${want}" — allowed: ${Object.keys(TARGETS).join(', ')}, all`);
    process.exit(2);
  }
  scanAll(keys)
    .then((r) => {
      persistScan(r);
      if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
      else console.log(formatReport(r));
      process.exit(r.summary.high ? 1 : 0);
    })
    .catch((e) => {
      console.error('scan failed:', e.message);
      process.exit(3);
    });
}
