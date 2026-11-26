/* cli-authorize-origin-probe.mjs — the /cli/authorize page must work from the
 * address the CLI actually printed.
 *
 * Owner, 2026-11-26: "im testing sign in flow on dell i signed out and logged in
 * the allow button wont click". The CLI on the Dell points at
 * http://127.0.0.1:3579, so the magic link opened on that origin — where the
 * browser holds no session, and where a relative sign-in link starts OAuth on an
 * address Google has no redirect URI for. The page could never become ready, so
 * the Allow button stayed disabled.
 *
 * This probe renders the page exactly as the route does and pins:
 *   - a loopback/LAN origin carries the public site and hands the code over,
 *   - the public origin, astro dev and a signed-in local origin are unchanged,
 *   - PUBLIC_URL wins over the default.
 *
 * Run: node server/__smoke__/cli-authorize-origin-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'index.js');
const src = fs.readFileSync(srcPath, 'utf8');

// ── pull the constant + the route helper out of the server file ──────────
const tplStart = src.indexOf('const CLI_AUTHORIZE_HTML = `');
if (tplStart < 0) fail('CLI_AUTHORIZE_HTML not found');
const tplBodyStart = tplStart + 'const CLI_AUTHORIZE_HTML = `'.length;
const tplEnd = src.indexOf('`;', tplBodyStart);
if (tplEnd < 0) fail('CLI_AUTHORIZE_HTML terminator not found');
const template = src.slice(tplBodyStart, tplEnd);

const fnStart = src.indexOf('function cliSiteOrigin(req) {');
if (fnStart < 0) fail('cliSiteOrigin not found');
const fnEnd = src.indexOf('\n}\n', fnStart);
if (fnEnd < 0) fail('cliSiteOrigin end not found');
const fnSrc = src.slice(fnStart, fnEnd + 2);

const sandbox = {
  CLI_AUTHORIZE_HTML: template,
  cliOrigin: (req) => req.__origin,
  process: { env: {} },
  JSON,
};
vm.createContext(sandbox);
vm.runInContext(fnSrc, sandbox);
const cliSiteOrigin = sandbox.cliSiteOrigin;

// cliAuthorizePage is now a thin wrapper; render through the same rule the
// route uses, so what is tested is what ships.
const cliAuthorizePage = (req) => template.split('__SITE_ORIGIN__').join(JSON.stringify(cliSiteOrigin(req)));

// ── cases ────────────────────────────────────────────────────────────────
const HAK = 'https://haksterai.com';
const cases = [
  {
    name: 'Dell CLI link — loopback origin hands off to the public site',
    host: '127.0.0.1:3579', origin: 'http://127.0.0.1:3579', env: {},
    expectSite: HAK, expectRedirect: true,
  },
  {
    name: 'standby box — private LAN origin hands off',
    host: '10.0.0.210:3581', origin: 'http://10.0.0.210:3581', env: {},
    expectSite: HAK, expectRedirect: true,
  },
  {
    name: 'public site — page is left exactly as it was',
    host: 'haksterai.com', origin: HAK, env: {},
    expectSite: '', expectRedirect: false,
  },
  {
    name: 'astro dev on :4321 — never redirected to production',
    host: 'localhost:4321', origin: 'http://localhost:4321', env: {},
    expectSite: '', expectRedirect: false,
  },
  {
    name: 'PUBLIC_URL overrides the default site',
    host: '127.0.0.1:3579', origin: 'http://127.0.0.1:3579', env: { PUBLIC_URL: 'https://example.test/' },
    expectSite: 'https://example.test', expectRedirect: true,
  },
];

let pass = 0;
for (const c of cases) {
  Object.keys(sandbox.process.env).forEach((k) => delete sandbox.process.env[k]);
  Object.assign(sandbox.process.env, c.env);
  const req = { __origin: c.origin, get: () => c.host };
  const html = cliAuthorizePage(req);

  const siteLiteral = `window.__HAKSTER_AUTHORIZE_SITE__ = ${JSON.stringify(c.expectSite)};`;
  const okSite = html.includes(siteLiteral);
  const okRedirect = html.includes('location.replace(SITE + \'/cli/authorize?user_code=\'');
  const okSignin = html.includes("(SITE || '') + '/?signin=1&redirect='");
  const okButton = html.includes('id="allow" disabled') && html.includes("allow.addEventListener('click'");
  const okPlaceholder = !html.includes('__SITE_ORIGIN__');

  const ok = okSite && okSignin && okButton && okPlaceholder && (c.expectRedirect ? okRedirect : true);
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  if (!ok) console.log(`    site=${okSite} signin=${okSignin} button=${okButton} placeholder=${okPlaceholder} redirect=${okRedirect}`);
  if (ok) pass += 1;
}

// The plain-origin page must keep today's behaviour byte for byte: no site
// literal of any non-empty value, and the Allow button still gated on a session.
const plain = cliAuthorizePage({ __origin: HAK, get: () => 'haksterai.com' });
const unchanged = plain.includes('window.__HAKSTER_AUTHORIZE_SITE__ = "";')
  && plain.includes("if (!SITE) return;")
  && plain.includes('if (!key) { showSignin(\'\'); schedule(); return; }');
console.log(`${unchanged ? '✓' : '✗'} public-origin page keeps its original gating`);
if (unchanged) pass += 1;

// ── the CLI's printed link: /api/cli/device/start must carry browserUrl ───
// Without it a loopback CLI prints a link it cannot work with, and the operator
// has to swap the host by hand. The route and the page must use ONE rule.
const startBlock = src.slice(src.indexOf("app.post('/api/cli/device/start'"), src.indexOf("app.post('/api/cli/device/approve'"));
const wired = /browserUrl:\s*siteOrigin\s*\?/.test(startBlock)
  && /const siteOrigin = cliSiteOrigin\(req\)/.test(startBlock)
  && /verificationUrl:\s*`\$\{cliOrigin\(req\)\}\$\{authorizePath\}`/.test(startBlock);
console.log(`${wired ? '✓' : '✗'} device/start offers browserUrl from the same cliSiteOrigin rule`);
if (wired) pass += 1;

// The value itself, per request shape the server actually sees.
const originCases = [
  ['loopback 127.0.0.1:3579', '127.0.0.1:3579', 'http://127.0.0.1:3579', HAK],
  ['loopback localhost:3579', 'localhost:3579', 'http://localhost:3579', HAK],
  ['standby 10.0.0.210:3581', '10.0.0.210:3581', 'http://10.0.0.210:3581', HAK],
  ['public haksterai.com', 'haksterai.com', HAK, ''],
  ['astro dev :4321', 'localhost:4321', 'http://localhost:4321', ''],
];
let originPass = 0;
for (const [name, host, origin, expect] of originCases) {
  Object.keys(sandbox.process.env).forEach((k) => delete sandbox.process.env[k]);
  const got = cliSiteOrigin({ __origin: origin, get: () => host });
  const ok = got === expect;
  if (ok) originPass += 1;
  console.log(`${ok ? '✓' : '✗'} cliSiteOrigin ${name} -> ${JSON.stringify(got)}`);
}
if (originPass === originCases.length) pass += 1;

const total = cases.length + 1 + 1 + 1;
console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
