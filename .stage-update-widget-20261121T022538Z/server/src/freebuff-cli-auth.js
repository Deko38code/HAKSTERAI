'use strict';
/**
 * Freebuff auth for Email Monitor — CLI-DRIVEN + AUTO-START.
 *
 * BAN-SAFETY CONSTRAINT (owner):
 *   Never call codebuff/freebuff's API directly. A custom HTTP client carries
 *   our own fingerprint/UA and looks automated -> account ban. Instead we spawn
 *   the GENUINE `freebuff login` binary. Every request (login code, approval,
 *   polling, analytics) originates from the real CLI, so it is
 *   indistinguishable from a human running `freebuff login` in a terminal.
 *
 * AUTO-START:
 *   A stored email profile (.hakster/freebuff-profile.json) lets the app begin
 *   the login on boot and on page load with zero clicks.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const LOGIN_TIMEOUT_MS = 1000 * 60 * 5;
const PROFILE_PATH = path.join(__dirname, '../../.hakster/freebuff-profile.json');

/** sid -> flow */
const flows = new Map();
/** token -> session */
const sessions = new Map();
/** sid of the pre-warmed boot flow */
let autoFlowSid = null;

// ------------------------------------------------------------------ helpers

const newId = () => crypto.randomBytes(16).toString('hex');

function sweep() {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expiresAt <= now) sessions.delete(t);
  for (const [sid, f] of flows) {
    if (now - f.startedAt > LOGIN_TIMEOUT_MS && f.status === 'pending') {
      try { f.child.kill('SIGTERM'); } catch {}
      f.status = 'expired';
    }
  }
}

/** Locate the freebuff binary without trusting the service PATH. */
function resolveBin() {
  const explicit = process.env.FREEBUFF_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const cands = [
    path.join(os.homedir(), '.npm-global/bin/freebuff'),
    '/usr/local/bin/freebuff',
    '/usr/bin/freebuff',
    path.join(os.homedir(), '.local/bin/freebuff'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'freebuff';
}

/** Where the real CLI writes credentials. */
function credCandidates() {
  const h = os.homedir();
  return [
    process.env.CODEBUFF_CREDENTIALS_PATH,
    // 2026-11-17 (owner): "clicking dashboard stops on freebuff auth flow".
    // The Freebuff CLI (Bun) keeps its profile here — token in the OS keychain,
    // identity in this file — so a restart never found a session and forced a
    // fresh interactive login. Codebuff's older paths stay as fallbacks.
    path.join(h, '.config/manicode/credentials.json'),
    path.join(h, '.config/manicode/auth.json'),
    path.join(h, '.config/codebuff/credentials.json'),
    path.join(h, '.config/codebuff/auth.json'),
    path.join(h, '.codebuff/credentials.json'),
    path.join(h, '.codebuff/auth.json'),
    path.join(h, '.local/share/codebuff/credentials.json'),
  ].filter(Boolean);
}

function readCredentials() {
  for (const p of credCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      let u = j.user || j;
      // Freebuff wraps profiles as { default: {...} }; Codebuff keeps the user
      // object at the top level. Unwrap only when the top level has no identity.
      if (!u.email && !u.emailAddress && !u.id && !u.userId && !u.sub
          && u.default && typeof u.default === 'object') {
        u = u.default;
      }
      const email = u.email || u.emailAddress || null;
      const id = u.id || u.userId || u.sub || null;
      const token = j.token || j.apiKey || j.accessToken || u.authToken || null;
      if (email || id || token) {
        return { path: p, user: { email, id, name: u.name || null }, token };
      }
    } catch {}
  }
  return null;
}

// ------------------------------------------------------------------ profile

function readProfile() {
  try {
    if (!fs.existsSync(PROFILE_PATH)) return null;
    return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
  } catch { return null; }
}

function writeProfile(p) {
  try {
    fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2));
    return true;
  } catch { return false; }
}

// -------------------------------------------------------------- the real flow

/** Spawn the genuine `freebuff login` and scrape its approval URL. */
function startCliLogin(opts) {
  const sid = newId();
  const bin = resolveBin();
  const prof = readProfile() || {};
  const email = (opts && opts.email) || prof.email || null;

  const child = spawn(bin, ['login'], {
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const flow = {
    child, email, loginUrl: null, status: 'pending', user: null,
    error: null, startedAt: Date.now(), buffer: '',
  };
  flows.set(sid, flow);

  const scrape = (chunk) => {
    flow.buffer += chunk.toString();
    if (!flow.loginUrl) {
      const m = flow.buffer.match(/https?:\/\/[^\s"'<>]+/g);
      if (m) {
        const url = m.find((u) => /login|auth|verify|approve/i.test(u)) || m[0];
        if (url) flow.loginUrl = url.replace(/[),.]+$/, '');
      }
    }
    if (flow.buffer.length > 20000) flow.buffer = flow.buffer.slice(-8000);
  };

  child.stdout.on('data', scrape);
  child.stderr.on('data', scrape);

  child.on('error', (err) => {
    flow.status = 'error';
    flow.error = 'could not start freebuff: ' + err.message;
  });

  child.on('exit', (code) => {
    if (flow.status !== 'pending') return;
    if (code === 0) {
      const creds = readCredentials();
      if (!creds || (!creds.user.email && !creds.user.id)) {
        flow.status = 'error';
        flow.error = 'Freebuff login completed, but no authenticated account identity was found.';
        return;
      }
      flow.status = 'success';
      flow.user = creds.user;
      const p = readProfile() || {};
      if (flow.user.email) { p.email = flow.user.email; p.lastLoginAt = new Date().toISOString(); writeProfile(p); }
    } else {
      flow.status = 'error';
      flow.error = flow.buffer.trim().slice(-300) || ('freebuff login exited ' + code);
    }
  });

  setTimeout(() => {
    if (flow.status === 'pending') {
      try { child.kill('SIGTERM'); } catch {}
      flow.status = 'expired';
    }
  }, LOGIN_TIMEOUT_MS).unref();

  return { sid, bin, email };
}

/** Boot/page-load auto-start from the stored profile. */
function autoStart() {
  const prof = readProfile();
  if (!prof || !prof.email) return null;
  if (autoFlowSid) {
    const f = flows.get(autoFlowSid);
    if (f && f.status === 'pending') return autoFlowSid;
  }
  try {
    const { sid } = startCliLogin({ email: prof.email });
    autoFlowSid = sid;
    return sid;
  } catch { return null; }
}

/** If the CLI already logged in previously, adopt those creds as a session. */
function tryAutoSession() {
  const creds = readCredentials();
  if (!creds || (!creds.user.email && !creds.user.id)) return null;
  for (const [, s] of sessions) {
    if (s.user && ((creds.user.id && s.user.id === creds.user.id)
      || (creds.user.email && s.user.email === creds.user.email))) return s;
  }
  return null;
}

// -------------------------------------------------------------- cookie utils

function readCookie(req, name = 'fb_session') {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setCookie(res, token, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `fb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', 'fb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function createSession(user) {
  sweep();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  if (!token) return null;
  sweep();
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) { sessions.delete(token); return null; }
  return s;
}

function requireFreebuffSession(req, res, next) {
  const s = getSession(readCookie(req));
  if (!s) return res.status(401).json({ ok: false, error: 'freebuff login required' });
  req.freebuff = s;
  next();
}

function maybeEnforce() {
  const on = String(process.env.FREEBUFF_AUTH_ENFORCE || '').trim() === '1';
  return on ? requireFreebuffSession : (req, res, next) => next();
}

// -------------------------------------------------------------------- routes

function mountAuthRoutes(app, options) {
  // Adopting the CLI's stored identity must never mint a session for an
  // anonymous visitor: the host passes an owner-key verifier.
  const isOwnerRequest = (options && typeof options.isOwnerRequest === 'function')
    ? options.isOwnerRequest
    : () => false;

  app.get(['/auth/freebuff', '/auth/freebuff/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/auth/freebuff/index.html'));
  });

  // Profile: read
  app.get('/api/auth/freebuff/profile', (req, res) => {
    res.json({ ok: true, profile: readProfile(), autoStarted: !!autoFlowSid });
  });

  // Profile: set email -> immediately auto-start a CLI login
  app.post('/api/auth/freebuff/profile', (req, res) => {
    const email = req.body && req.body.email;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      return res.status(400).json({ ok: false, error: 'valid email required' });
    }
    const prof = readProfile() || {};
    prof.email = String(email).trim();
    prof.updatedAt = new Date().toISOString();
    writeProfile(prof);
    const sid = autoStart();
    const f = sid && flows.get(sid);
    res.json({ ok: true, profile: prof, sid, loginUrl: (f && f.loginUrl) || null });
  });

  // Auto-start (no click): returns a ready URL
  app.post('/api/auth/freebuff/cli/autostart', (req, res) => {
    const sid = autoStart();
    if (!sid) return res.status(400).json({ ok: false, error: 'no profile email set' });
    const t0 = Date.now();
    const wait = setInterval(() => {
      const f = flows.get(sid);
      if (!f || f.loginUrl || f.status !== 'pending' || Date.now() - t0 > 12000) {
        clearInterval(wait);
        res.json({
          ok: !!(f && !f.error), sid,
          loginUrl: f && f.loginUrl, email: f && f.email,
          status: f && f.status, via: 'freebuff-cli', auto: true,
        });
      }
    }, 250);
  });

  // Manual start
  app.post('/api/auth/freebuff/cli/start', (req, res) => {
    try {
      const prof = readProfile() || {};
      const email = (req.body && req.body.email) || prof.email || null;
      if (email && email !== prof.email) writeProfile({ ...prof, email });
      const { sid, bin } = startCliLogin({ email });
      const flow = flows.get(sid);
      const t0 = Date.now();
      const wait = setInterval(() => {
        if (flow.loginUrl || flow.status === 'error' || Date.now() - t0 > 12000) {
          clearInterval(wait);
          res.json({ ok: !flow.error, sid, loginUrl: flow.loginUrl,
                     error: flow.error, via: 'freebuff-cli', bin, email });
        }
      }, 250);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Poll
  app.get('/api/auth/freebuff/cli/status', (req, res) => {
    const sid = req.query.sid;
    if (!sid) return res.status(400).json({ ok: false, error: 'sid required' });
    const flow = flows.get(sid);
    if (!flow) return res.status(404).json({ ok: false, error: 'unknown sid' });
    if (flow.status === 'success') {
      const token = createSession(flow.user);
      setCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
      flows.delete(sid);
      if (autoFlowSid === sid) autoFlowSid = null;
      return res.json({ ok: true, status: 'success', user: flow.user });
    }
    if (flow.status === 'error') return res.json({ ok: false, status: 'error', error: flow.error });
    if (flow.status === 'expired') return res.json({ ok: true, status: 'expired' });
    res.json({ ok: true, status: 'pending', loginUrl: flow.loginUrl, email: flow.email });
  });

  app.post('/api/auth/freebuff/cli/cancel', (req, res) => {
    const sid = req.body && req.body.sid;
    const flow = sid && flows.get(sid);
    if (flow) { try { flow.child.kill('SIGTERM'); } catch {} flows.delete(sid); }
    if (autoFlowSid === sid) autoFlowSid = null;
    res.json({ ok: true });
  });

  app.get('/api/auth/freebuff/me', (req, res) => {
    const s = getSession(readCookie(req));
    if (s) return res.json({ ok: true, user: s.user });
    // Sessions are in-memory, so a server restart used to bounce every admin page
    // back through an interactive Freebuff login even though the CLI on this box
    // is still authenticated (identity in ~/.config/manicode/credentials.json,
    // token in the OS keychain). Adopt that identity as a session, but only on a
    // request that already proves the owner key — never for anonymous callers.
    if (isOwnerRequest(req)) {
      const creds = readCredentials();
      if (creds && (creds.user.email || creds.user.id)) {
        const token = createSession(creds.user);
        setCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
        return res.json({ ok: true, user: creds.user, adopted: true });
      }
    }
    res.status(401).json({ ok: false });
  });

  app.post('/api/auth/freebuff/logout', (req, res) => {
    const t = readCookie(req);
    if (t) sessions.delete(t);
    clearCookie(res);
    res.json({ ok: true });
  });

  // Warm up at boot so a URL is ready before anyone clicks.
  setTimeout(() => { try { autoStart(); } catch {} }, 1500).unref();
}

module.exports = {
  mountAuthRoutes, requireFreebuffSession, maybeEnforce,
  getSession, readCookie, setCookie, clearCookie,
  resolveBin, readCredentials, startCliLogin,
  readProfile, writeProfile, autoStart, tryAutoSession,
};
