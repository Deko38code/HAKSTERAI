'use strict';
/**
 * Freebuff (Codebuff) device-code auth for Email Monitor.
 *
 * Flow mirrors the freebuff CLI (cli/src/login/login-flow.ts):
 *   1. POST /api/auth/cli/code   { fingerprintId }  -> { loginUrl | code, status }
 *   2. user opens loginUrl and approves in browser
 *   3. GET  /api/auth/cli/status?fingerprintId=... -> { status: 'success', user }
 *   4. we mint a local session cookie for Email Monitor
 *
 * Additive module: nothing existing is modified by requiring it.
 */

const crypto = require('crypto');

const FREEBUFF_BASE = process.env.FREEBUFF_API_BASE || 'https://www.codebuff.com';
const REQUEST_TIMEOUT = 15000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/** In-memory session store: token -> { user, fingerprintId, expiresAt } */
const sessions = new Map();

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sweep() {
  const now = Date.now();
  for (const [token, sess] of sessions) {
    if (sess.expiresAt <= now) sessions.delete(token);
  }
}

async function fbFetch(path, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(`${FREEBUFF_BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'haksterai-email-monitor/1.0',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Step 1 — start a device-code login. Returns the URL the user must open. */
async function startLogin(fingerprintId) {
  const fp = fingerprintId || crypto.randomBytes(16).toString('hex');
  const { ok, status, json, text } = await fbFetch('/api/auth/cli/code', {
    method: 'POST',
    body: JSON.stringify({ fingerprintId: fp }),
  });

  if (!ok || !json) {
    const err = new Error(`freebuff loginCode failed (HTTP ${status})`);
    err.detail = (text || '').slice(0, 300);
    throw err;
  }

  // Tolerate both shapes seen across freebuff versions.
  const loginUrl =
    json.loginUrl || json.url || json.verificationUrl || json.login_url || null;
  const userCode = json.code || json.userCode || json.user_code || null;

  return {
    fingerprintId: fp,
    fingerprintHash: json.fingerprintHash || null,
    expiresAt: json.expiresAt || null,
    loginUrl,
    userCode,
    raw: json,
  };
}

/** Step 3 — poll for approval. Returns { status, user? }. */
async function pollStatus(fingerprintId, fingerprintHash, expiresAt) {
  const qs = new URLSearchParams({ fingerprintId }).toString()
    + (fingerprintHash ? `&fingerprintHash=${encodeURIComponent(fingerprintHash)}` : '')
    + (expiresAt ? `&expiresAt=${encodeURIComponent(expiresAt)}` : '');
  const { ok, status, json, text } = await fbFetch(`/api/auth/cli/status?${qs}`, {
    method: 'GET',
  });

  if (status === 401) {
    // Not approved yet (or expired). This is the normal pending state.
    return { status: 'pending', httpStatus: 401 };
  }
  if (!ok || !json) {
    return { status: 'error', httpStatus: status, detail: (text || '').slice(0, 300) };
  }

  const st = json.status || json.state || 'pending';
  if (st === 'success' && json.user) {
    return { status: 'success', user: json.user };
  }
  return { status: st === 'success' ? 'pending' : st, raw: json };
}

/** Mint a local Email Monitor session from a verified freebuff user. */
function createSession(user, fingerprintId) {
  sweep();
  const token = newToken();
  sessions.set(token, {
    user,
    fingerprintId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return { token, expiresAt: Date.now() + SESSION_TTL_MS };
}

function getSession(token) {
  if (!token) return null;
  sweep();
  const sess = sessions.get(token);
  if (!sess) return null;
  if (sess.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return sess;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

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
  res.setHeader(
    'Set-Cookie',
    `fb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`
  );
}

function clearCookie(res) {
  res.setHeader(
    'Set-Cookie',
    'fb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  );
}

/** Express middleware — 401s unless a valid freebuff session cookie is present. */
function requireFreebuffSession(req, res, next) {
  const sess = getSession(readCookie(req));
  if (!sess) {
    return res.status(401).json({ ok: false, error: 'freebuff login required' });
  }
  req.freebuff = sess;
  next();
}

/**
 * Opt-in enforcement gate.
 * Off by default so existing owner/Google-OAuth behaviour is untouched.
 * Set FREEBUFF_AUTH_ENFORCE=1 to require a Freebuff session on the mail API.
 */
function maybeEnforce() {
  const on = String(process.env.FREEBUFF_AUTH_ENFORCE || '').trim() === '1';
  if (!on) return (req, res, next) => next();
  return requireFreebuffSession;
}

/** Mount the auth routes. */
function mountAuthRoutes(app) {
  // Serve the login page itself
  app.get(['/auth/freebuff', '/auth/freebuff/'], (req, res) => {
    res.sendFile(require('path').join(__dirname, '../../public/auth/freebuff/index.html'));
  });

  // Start login -> returns the URL to open
  app.post('/api/auth/freebuff/start', async (req, res) => {
    try {
      const out = await startLogin(req.body && req.body.fingerprintId);
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message, detail: err.detail || null });
    }
  });

  // Poll for approval; on success set the session cookie
  app.get('/api/auth/freebuff/status', async (req, res) => {
    const { fingerprintId, fingerprintHash, expiresAt } = req.query;
    if (!fingerprintId) {
      return res.status(400).json({ ok: false, error: 'fingerprintId required' });
    }
    try {
      const out = await pollStatus(fingerprintId, fingerprintHash, expiresAt);
      if (out.status === 'success') {
        const { token } = createSession(out.user, fingerprintId);
        setCookie(res, token, Math.floor(SESSION_TTL_MS / 1000));
        return res.json({ ok: true, status: 'success', user: out.user });
      }
      res.json({ ok: true, status: out.status, detail: out.detail || null });
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  // Who am I
  app.get('/api/auth/freebuff/me', (req, res) => {
    const sess = getSession(readCookie(req));
    if (!sess) return res.status(401).json({ ok: false });
    res.json({ ok: true, user: sess.user });
  });

  // Logout
  app.post('/api/auth/freebuff/logout', (req, res) => {
    destroySession(readCookie(req));
    clearCookie(res);
    res.json({ ok: true });
  });
}

module.exports = {
  startLogin,
  pollStatus,
  createSession,
  getSession,
  destroySession,
  readCookie,
  setCookie,
  clearCookie,
  requireFreebuffSession,
  maybeEnforce,
  mountAuthRoutes,
  FREEBUFF_BASE,
};
