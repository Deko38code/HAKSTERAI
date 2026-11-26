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
async function run(startBody, extra = {}) {
  const lines = [];
  const polled = [];
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    if (String(url).endsWith('/api/cli/device/start')) {
      return { ok: true, status: 200, json: async () => startBody };
    }
    polled.push(String(url));
    // First poll answers denied, so the flow ends without touching config.
    return { ok: true, status: 200, json: async () => ({ status: 'denied' }) };
  };
  try {
    const { login } = require('../login');
    const res = await login({ server: LOOPBACK, open: false, onPrompt: (l) => lines.push(l), ...extra });
    return { res, lines, calls, polled };
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

test('older server + loopback link — the CLI carries the code to the site itself', async () => {
  // The Dell, 2026-11-26: the running server was older than the handoff fix, so
  // it answered only a 127.0.0.1 link. The page there has no session and Google
  // has no redirect URI for it, so Allow could never enable. The CLI now prints
  // the site's own link while still polling the process that issued the code.
  const { lines, polled } = await run({
    ...base,
    verificationUrl: `${LOOPBACK}/cli/authorize?user_code=ABCD-EFGH`,
  });
  const text = lines.join('\n');
  assert.ok(
    text.includes(`${PUBLIC}/cli/authorize?user_code=ABCD-EFGH`),
    'the site link is printed'
  );
  assert.ok(!text.includes(`${LOOPBACK}/cli/authorize`), 'the loopback link is not offered');
  assert.ok(polled.length > 0 && polled.every((u) => u.startsWith(LOOPBACK)), 'polling stays on the issuing origin');
});

test('the site origin is named explicitly through HAKSTER_SITE', async () => {
  const real = process.env.HAKSTER_SITE;
  process.env.HAKSTER_SITE = 'https://staging.haksterai.com';
  try {
    const { lines } = await run({
      ...base,
      verificationUrl: `${LOOPBACK}/cli/authorize?user_code=ABCD-EFGH`,
    });
    assert.ok(
      lines.join('\n').includes('https://staging.haksterai.com/cli/authorize?user_code=ABCD-EFGH'),
      'an operator who serves the site elsewhere is honoured'
    );
  } finally {
    if (real === undefined) delete process.env.HAKSTER_SITE; else process.env.HAKSTER_SITE = real;
  }
});

test('a LAN address is treated like loopback, a public one is not', async () => {
  const lan = await run({ ...base, verificationUrl: 'http://10.0.0.210:3581/cli/authorize?user_code=ABCD-EFGH' });
  assert.ok(lan.lines.join('\n').includes(`${PUBLIC}/cli/authorize`), 'LAN is handed over');

  const remote = await run({ ...base, verificationUrl: 'https://box.example.net/cli/authorize?user_code=ABCD-EFGH' });
  const text = remote.lines.join('\n');
  assert.ok(text.includes('https://box.example.net/cli/authorize'), 'a public origin is left alone');
  assert.ok(!text.includes(PUBLIC), 'no substitution where a session can exist');
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
