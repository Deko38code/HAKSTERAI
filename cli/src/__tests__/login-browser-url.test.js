/* login-browser-url.test.js — the link the CLI prints must be the one the
 * operator's browser can actually use.
 *
 * Owner, 2026-11-26: "im testing sign in flow on dell i sighed out and logged in
 * the alow button wont click". The Dell's ~/.hakster/config.json points the CLI
 * at http://127.0.0.1:3579, so the server built the verification link on that
 * origin — where the browser holds no session and where OAuth has no registered
 * redirect URI. The Allow button was gated on a session it could never get.
 *
 * The server now answers /api/cli/device/start with `browserUrl` when the
 * request arrived on a loopback/LAN address it does not serve a session on. The
 * CLI prints that link and keeps polling its own origin — same process, so the
 * approval is still seen. An older server sends no browserUrl and nothing
 * changes.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const LOOPBACK = 'http://127.0.0.1:3579';
const PUBLIC = 'https://haksterai.com';

/** Run login() against a stub fetch, capturing what it told the operator. */
async function run(startBody) {
  const lines = [];
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    if (String(url).endsWith('/api/cli/device/start')) {
      return { ok: true, status: 200, json: async () => startBody };
    }
    // First poll answers denied, so the flow ends without touching config.
    return { ok: true, status: 200, json: async () => ({ status: 'denied' }) };
  };
  try {
    const { login } = require('../login');
    const res = await login({ server: LOOPBACK, open: false, onPrompt: (l) => lines.push(l) });
    return { res, lines, calls };
  } finally {
    global.fetch = realFetch;
  }
}

const base = {
  deviceCode: 'dev-code',
  userCode: 'ABCD-EFGH',
  expiresInSeconds: 900,
  intervalSeconds: 1,
};

test('server offers browserUrl — the CLI prints the public link, not loopback', async () => {
  const { lines } = await run({
    ...base,
    verificationUrl: `${LOOPBACK}/cli/authorize?user_code=ABCD-EFGH`,
    browserUrl: `${PUBLIC}/cli/authorize?user_code=ABCD-EFGH`,
  });
  const text = lines.join('\n');
  assert.ok(
    text.includes(`${PUBLIC}/cli/authorize?user_code=ABCD-EFGH`),
    'the public link is the one printed'
  );
  assert.ok(
    !text.includes(`${LOOPBACK}/cli/authorize`),
    'the loopback link is not offered to the browser'
  );
});

test('older server sends no browserUrl — the printed link is unchanged', async () => {
  const { lines } = await run({
    ...base,
    verificationUrl: `${PUBLIC}/cli/authorize?user_code=ABCD-EFGH`,
  });
  assert.ok(
    lines.join('\n').includes(`${PUBLIC}/cli/authorize?user_code=ABCD-EFGH`),
    'falls back to verificationUrl'
  );
});

test('a blank browserUrl is ignored rather than printing an empty link', async () => {
  const { lines } = await run({
    ...base,
    verificationUrl: `${PUBLIC}/cli/authorize?user_code=ABCD-EFGH`,
    browserUrl: '',
  });
  const line = lines.find((l) => l.includes('authorize?user_code='));
  assert.ok(line && line.includes(PUBLIC), 'prints the real link, never a blank one');
});

test('polling still goes to the configured origin, not the browser link', async () => {
  const { res } = await run({
    ...base,
    verificationUrl: `${LOOPBACK}/cli/authorize?user_code=ABCD-EFGH`,
    browserUrl: `${PUBLIC}/cli/authorize?user_code=ABCD-EFGH`,
  });
  assert.equal(res.ok, false);
  assert.match(String(res.reason), /denied/);
});
