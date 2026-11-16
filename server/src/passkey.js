'use strict';

// WebAuthn / passkey sign-in for haksterai.com.
//
// Covers both kinds of authenticator through the same two endpoints:
//   * a phone/laptop passkey synced through Google Password Manager, iCloud
//     Keychain, 1Password, etc. — "Sign in with a passkey"
//   * a this-device authenticator such as Windows Hello (face/PIN) or Touch ID,
//     which is a platform authenticator and needs no separate protocol
//
// Design notes
//   * RP IDs / origins are derived from the request, then checked against an
//     allowlist. No owner config file is involved.
//   * Challenges live in memory for five minutes and are single-use; they are
//     only a CSRF/nonce guard, nothing about them needs to survive a restart.
//   * Credential public keys are stored per user in sqlite. The private key
//     never leaves the authenticator.
//   * Login returns the same JSON payload the Google callback hands the
//     frontend (apiKey + user), so the existing client session code is reused.

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = 'HaksterAI';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ALLOWED_RP_IDS = new Set(['haksterai.com', 'www.haksterai.com', 'localhost', '127.0.0.1']);
const MAX_CHALLENGE_ENTRIES = 2000;

function createPasskeyStore() {
  const challenges = new Map(); // challenge -> { kind, userId, rpID, origin, expiresAt, platform }

  function sweep() {
    const now = Date.now();
    for (const [key, val] of challenges) if (val.expiresAt <= now) challenges.delete(key);
    // Hard cap: never let this grow without bound if something floods it.
    while (challenges.size > MAX_CHALLENGE_ENTRIES) {
      const oldest = challenges.keys().next().value;
      challenges.delete(oldest);
    }
  }

  function put(challenge, record) {
    sweep();
    challenges.set(challenge, { ...record, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  }

  function take(challenge) {
    const rec = challenges.get(challenge);
    if (!rec) return null;
    challenges.delete(challenge); // single use, even on failure
    if (rec.expiresAt <= Date.now()) return null;
    return rec;
  }

  return { put, take, sweep, size: () => challenges.size };
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS passkey_credentials (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key    BLOB NOT NULL,
      counter       INTEGER NOT NULL DEFAULT 0,
      transports    TEXT,
      device_type   TEXT,
      backed_up     INTEGER NOT NULL DEFAULT 0,
      label         TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      last_used_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey_credentials(user_id);
  `);
}

// Resolve the RP ID + origin from the request and refuse anything off-list.
// The RP ID is always the registrable domain (www stripped), but the origin is
// built from the host the browser is ACTUALLY on, and every accepted spelling
// is returned so verification does not fail just because someone opened
// https://www.haksterai.com instead of the apex.
function rpFromRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  let rawHost = String(req.headers['x-forwarded-host'] || req.hostname || 'localhost').split(',')[0].trim().toLowerCase();
  rawHost = rawHost.replace(/:\d+$/, '');
  let host = rawHost.startsWith('www.') ? rawHost.slice(4) : rawHost;
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const port = isLocal ? `:${req.socket.localPort}` : '';
  if (!ALLOWED_RP_IDS.has(host)) return null;
  const origin = `${proto}://${rawHost}${port}`;
  const origins = new Set([origin]);
  if (!isLocal) {
    origins.add(`${proto}://${host}`);
    origins.add(`${proto}://www.${host}`);
  }
  return { rpID: host, origin, origins: [...origins] };
}

function clientContext(req) {
  const ua = req.get('User-Agent') || '';
  return {
    ip: req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for'] || '',
    userAgent: ua,
    deviceType: /mobile|android|iphone/i.test(ua) ? 'mobile' : /tablet|ipad/i.test(ua) ? 'tablet' : 'desktop',
    browser: /firefox/i.test(ua) ? 'Firefox' : /edg/i.test(ua) ? 'Edge' : /chrome/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'Other',
    osName: /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'macOS' : /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iOS' : /linux/i.test(ua) ? 'Linux' : 'Other',
  };
}

function installPasskeyRoutes(app, deps) {
  const { getDb, getUserByApiKey, isOwnerUser, notifPush, sendTelegram } = deps;
  const store = createPasskeyStore();
  let tablesReady = false;

  // ── Admin/owner device approval ──────────────────────────────────────────
  // Adding a passkey to an admin or owner account is a device-enrollment event,
  // so it needs a second factor the signed-in browser does not have: a 6-digit
  // code sent to the owner's Telegram (read on his phone). Fail closed — with
  // no code, no new admin credential is stored. Codes are memory-only, 10 min,
  // three tries, and never returned in an API response.
  const approvals = new Map();
  const APPROVAL_TTL_MS = 10 * 60 * 1000;
  const APPROVAL_TRIES = 3;
  const isAdminAccount = (user) => Boolean(user && (isOwnerUser(user) || user.role === 'admin' || user.plan === 'enterprise'));
  const newCode = () => String(Math.floor(100000 + Math.random() * 900000));
  const issueApproval = (user) => {
    const code = newCode();
    approvals.set(String(user.id), { code, expiresAt: Date.now() + APPROVAL_TTL_MS, tries: 0, device: '' });
    return code;
  };
  const checkApproval = (user, code) => {
    const rec = approvals.get(String(user.id));
    if (!rec) return 'no pending approval — request a new code';
    if (Date.now() > rec.expiresAt) { approvals.delete(String(user.id)); return 'that code expired — request a new one'; }
    if (++rec.tries > APPROVAL_TRIES) { approvals.delete(String(user.id)); return 'too many wrong codes — request a new one'; }
    if (String(code || '').trim() !== rec.code) return 'wrong code';
    approvals.delete(String(user.id));
    return '';
  };

  const db = () => {
    const d = getDb();
    if (!tablesReady) { ensureTables(d); tablesReady = true; }
    return d;
  };

  const credsFor = (userId) => db()
    .prepare('SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at ASC')
    .all(userId);

  const findUser = (usernameOrEmail) => {
    const q = String(usernameOrEmail || '').trim();
    if (!q) return null;
    return db().prepare('SELECT * FROM users WHERE lower(email) = lower(?) OR lower(username) = lower(?) LIMIT 1').get(q, q) || null;
  };

  const logActivity = (dbh, userId, action, ctx, endpoint, metadata) => {
    try {
      dbh.prepare(
        `INSERT INTO user_activity (user_id, action, ip_address, user_agent, endpoint, method, status_code, device_type, os_name, browser, metadata)
         VALUES (?, ?, ?, ?, ?, 'POST', 200, ?, ?, ?, ?)`
      ).run(userId, action, ctx.ip, ctx.userAgent, endpoint, ctx.deviceType, ctx.osName, ctx.browser, JSON.stringify(metadata || {}));
    } catch { /* activity logging must never break sign-in */ }
  };

  // ── status: what the browser needs before it can offer anything ──────────
  app.get('/api/auth/passkey/status', (req, res) => {
    const rp = rpFromRequest(req);
    if (!rp) return res.status(400).json({ error: 'passkeys are not available on this host' });
    const user = getUserByApiKey(req);
    const payload = {
      available: true,
      rpID: rp.rpID,
      // Whatever the device has: face, fingerprint, iris, screen-lock PIN, or a
      // roaming security key. Fingerprint is never required and never assumed.
      platformHint: 'face, fingerprint, PIN or a security key',
    };
    if (user) payload.credentials = credsFor(user.id).map(c => ({ id: c.id, label: c.label, created_at: c.created_at, last_used_at: c.last_used_at, device_type: c.device_type }));
    res.json(payload);
  });

  // ── registration: an already signed-in user adds a passkey ───────────────
  app.post('/api/auth/passkey/register/options', async (req, res) => {
    const rp = rpFromRequest(req);
    if (!rp) return res.status(400).json({ error: 'passkeys are not available on this host' });
    const user = getUserByApiKey(req);
    if (!user) return res.status(401).json({ error: 'sign in first, then add a passkey' });

    const existing = credsFor(user.id);
    // Which authenticator the owner is adding:
    //   this-device  → platform (Windows Hello face/PIN, Touch ID/Face ID)
    //   phone        → hybrid / cross-device QR (phone or tablet as the key)
    //   security-key → a roaming USB/NFC key
    //   any (default)→ no preference: the browser offers everything it can,
    //                  including "use a phone" on desktop. Never fingerprint-only.
    const requested = String(req.body?.mode || '').toLowerCase();
    const platform = req.body?.platform === true || requested === 'this-device' || requested === 'platform';
    const preferredAuthenticatorType =
      requested === 'this-device' || requested === 'platform' ? 'localDevice'
      : requested === 'phone' || requested === 'remote' ? 'remoteDevice'
      : requested === 'security-key' || requested === 'securitykey' ? 'securityKey'
      : undefined; // 'any' → undefined

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.rpID,
      userID: Buffer.from(user.id, 'utf8'),
      userName: user.email || user.username,
      userDisplayName: user.username,
      attestationType: 'none',
      timeout: 120000, // phones and QR hand-offs need longer than 60s
      excludeCredentials: existing.map(c => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      ...(preferredAuthenticatorType ? { preferredAuthenticatorType } : {}),
      authenticatorSelection: {
        residentKey: 'preferred',      // synced passkeys still become discoverable
        userVerification: 'preferred', // face / fingerprint / PIN — whatever the device has
        ...(platform ? { authenticatorAttachment: 'platform' } : {}),
      },
    });
    store.put(options.challenge, { kind: 'register', userId: user.id, rpID: rp.rpID, origin: rp.origin, origins: rp.origins, platform });

    // Admins and owners must confirm the enrollment from their phone.
    if (isAdminAccount(user)) {
      const code = issueApproval(user);
      let sent = false;
      try {
        if (typeof sendTelegram === 'function') {
          sendTelegram(`🔐 Passkey enrollment for ${user.username || user.email} (${clientContext(req).deviceType}) — code ${code}, valid 10 min. If this wasn't you, ignore it and change your Google password.`);
          sent = true;
        }
      } catch { /* delivery failure still leaves the approval pending */ }
      return res.json({
        ...options,
        requiresApproval: true,
        approvalSent: sent,
        approvalHint: sent
          ? 'Enter the 6-digit code sent to your Telegram.'
          : 'Telegram is not reachable — ask the owner for the code before continuing.',
      });
    }
    res.json(options);
  });

  // A fresh code for a retry (rate-limited by the 10-minute record it replaces).
  app.post('/api/auth/passkey/register/approval', (req, res) => {
    const user = getUserByApiKey(req);
    if (!user) return res.status(401).json({ error: 'sign in first, then add a passkey' });
    if (!isAdminAccount(user)) return res.json({ ok: true, requiresApproval: false });
    const code = issueApproval(user);
    try {
      if (typeof sendTelegram === 'function') sendTelegram(`🔐 New passkey enrollment code for ${user.username || user.email}: ${code}, valid 10 min.`);
    } catch { return res.status(503).json({ error: 'could not send the code — no Telegram delivery' }); }
    res.json({ ok: true, requiresApproval: true });
  });

  app.post('/api/auth/passkey/register/verify', async (req, res) => {
    const rp = rpFromRequest(req);
    if (!rp) return res.status(400).json({ error: 'passkeys are not available on this host' });
    const user = getUserByApiKey(req);
    if (!user) return res.status(401).json({ error: 'sign in first, then add a passkey' });

    // Admin/owner devices need the Telegram code before anything is stored.
    // Checked before the challenge is consumed so a typo does not burn the prompt.
    if (isAdminAccount(user)) {
      const problem = checkApproval(user, req.body?.approvalCode);
      if (problem) return res.status(403).json({ error: problem, requiresApproval: true });
    }

    const response = req.body?.response;
    const challenge = response?.response?.clientDataJSON && JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge;
    if (!challenge) return res.status(400).json({ error: 'missing challenge in response' });
    const pending = store.take(challenge);
    if (!pending || pending.kind !== 'register' || pending.userId !== user.id) {
      return res.status(400).json({ error: 'this passkey prompt expired — try again' });
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: pending.origins || pending.origin,
        expectedRPID: pending.rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      return res.status(400).json({ error: `passkey could not be verified: ${err.message}` });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'passkey could not be verified' });
    }

    const info = verification.registrationInfo;
    const credentialId = info.credential.id;
    const d = db();
    const label = String(req.body?.label || '').slice(0, 60) || `${pending.platform ? 'This device' : 'Passkey'} · ${clientContext(req).osName}`;
    try {
      d.prepare(
        `INSERT INTO passkey_credentials (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        crypto.randomUUID(),
        user.id,
        credentialId,
        Buffer.from(info.credential.publicKey),
        info.credential.counter || 0,
        JSON.stringify(req.body?.response?.response?.transports || info.credential.transports || []),
        info.credentialDeviceType || null,
        info.backed_up ?? info.credentialBackedUp ? 1 : 0,
        label
      );
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'that passkey is already registered on this account' });
      throw err;
    }
    const ctx = clientContext(req);
    logActivity(d, user.id, 'passkey_register', ctx, '/auth/passkey/register', { label, deviceType: info.credentialDeviceType });
    res.json({ verified: true, label, credential_id: credentialId });
  });

  // ── authentication: sign in without Google ───────────────────────────────
  app.post('/api/auth/passkey/login/options', async (req, res) => {
    const rp = rpFromRequest(req);
    if (!rp) return res.status(400).json({ error: 'passkeys are not available on this host' });
    // No username → empty allowCredentials: the OS offers every discoverable
    // passkey (synced phone passkeys, Hello, Touch ID, security keys) and, on
    // desktop, the "use a phone" hybrid QR. A username narrows it to that
    // account's credentials for older non-discoverable security keys.
    const user = findUser(req.body?.username);
    const creds = user ? credsFor(user.id) : [];
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      allowCredentials: creds.map(c => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      userVerification: 'preferred', // device decides: face, fingerprint, PIN
      timeout: 120000,
    });
    store.put(options.challenge, { kind: 'login', userId: user ? user.id : null, rpID: rp.rpID, origin: rp.origin, origins: rp.origins });
    res.json(options);
  });

  app.post('/api/auth/passkey/login/verify', async (req, res) => {
    const rp = rpFromRequest(req);
    if (!rp) return res.status(400).json({ error: 'passkeys are not available on this host' });
    const response = req.body?.response;
    let challenge;
    try {
      challenge = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge;
    } catch { return res.status(400).json({ error: 'malformed passkey response' }); }
    const pending = store.take(challenge);
    if (!pending || pending.kind !== 'login') return res.status(400).json({ error: 'this passkey prompt expired — try again' });

    const d = db();
    const row = d.prepare('SELECT * FROM passkey_credentials WHERE credential_id = ?').get(response.id);
    if (!row) return res.status(401).json({ error: 'this passkey is not registered on any account here' });
    // No mixups: when the prompt named an account, the passkey that answers must
    // belong to that same account. Otherwise a credential from account B could
    // sign in while the UI said account A.
    if (pending.userId && String(pending.userId) !== String(row.user_id)) {
      return res.status(401).json({ error: 'this passkey belongs to a different account' });
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: pending.origins || pending.origin,
        expectedRPID: pending.rpID,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(row.public_key),
          counter: row.counter,
          transports: row.transports ? JSON.parse(row.transports) : undefined,
        },
        requireUserVerification: false,
      });
    } catch (err) {
      return res.status(401).json({ error: `passkey could not be verified: ${err.message}` });
    }
    if (!verification.verified) return res.status(401).json({ error: 'passkey could not be verified' });

    const user = d.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) return res.status(401).json({ error: 'account not found' });
    if (user.status && user.status !== 'active') return res.status(403).json({ error: 'this account is not active' });

    const ctx = clientContext(req);
    d.prepare('UPDATE passkey_credentials SET counter = ?, last_used_at = unixepoch() WHERE id = ?')
      .run(verification.authenticationInfo?.newCounter ?? row.counter, row.id);
    d.prepare('UPDATE users SET last_login_at = unixepoch(), last_login_ip = ?, updated_at = unixepoch() WHERE id = ?')
      .run(ctx.ip, user.id);

    try {
      d.prepare('INSERT INTO access_logs (user_id, ip_address, user_agent, endpoint, method, status_code) VALUES (?, ?, ?, ?, ?, ?)')
        .run(user.id, ctx.ip, ctx.userAgent, '/auth/passkey/login', 'POST', 200);
    } catch { /* access logging must never break sign-in */ }
    logActivity(d, user.id, 'login', ctx, '/auth/passkey/login', { method: 'passkey' });

    try {
      if (typeof notifPush === 'function') {
        notifPush(`🔑 Passkey login: ${user.username} from ${ctx.ip}`, { type: 'user_login', priority: 'normal', source: 'auth' });
      }
    } catch { /* notifications are best-effort */ }

    res.json({
      ok: true,
      method: 'passkey',
      isNewUser: false,
      apiKey: user.api_key,
      // 2026-11-16: the dashboard is owner-only now (its cards are operator data),
      // so a non-owner lands in the app instead of on a page they cannot use.
      redirect: isOwnerUser(user) || user.role === 'admin' || user.plan === 'enterprise' ? '/terminal' : '/build',
      user: {
        id: user.id,
        username: user.username,
        displayName: user.username,
        name: user.username,
        email: user.email,
        role: user.role,
        plan: user.plan,
        is_owner: isOwnerUser(user),
        referralCode: user.referral_code,
        tokenBalance: user.token_balance || 0,
      },
    });
  });

  // ── management ───────────────────────────────────────────────────────────
  app.get('/api/auth/passkey/list', (req, res) => {
    const user = getUserByApiKey(req);
    if (!user) return res.status(401).json({ error: 'invalid or missing API key' });
    res.json({
      credentials: credsFor(user.id).map(c => ({
        id: c.id,
        label: c.label,
        credential_id: c.credential_id.slice(0, 12) + '…',
        device_type: c.device_type,
        backed_up: !!c.backed_up,
        created_at: c.created_at,
        last_used_at: c.last_used_at,
      })),
    });
  });

  app.post('/api/auth/passkey/remove', (req, res) => {
    const user = getUserByApiKey(req);
    if (!user) return res.status(401).json({ error: 'invalid or missing API key' });
    const id = String(req.body?.id || '');
    const row = db().prepare('SELECT * FROM passkey_credentials WHERE id = ? AND user_id = ?').get(id, user.id);
    if (!row) return res.status(404).json({ error: 'passkey not found on this account' });
    // The user is removing their own credential. Other sign-in paths (Google,
    // API key) remain, so this cannot lock anyone out.
    db().prepare('DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?').run(id, user.id);
    logActivity(db(), user.id, 'passkey_remove', clientContext(req), '/auth/passkey/remove', { label: row.label });
    res.json({ ok: true });
  });
}

module.exports = { installPasskeyRoutes, RP_NAME, ALLOWED_RP_IDS };
