'use strict';
/* windows-tui.test.js — the paid dashboard must start on Windows.
 *
 * Owner, 2026-11-26 (Surface Pro): "terminal has none of our grids ... it shows
 * input bar tui only and didnt show png logo matrix ... says scan unavailable
 * ss not readable". That screen was the OLD Ink fallback, reached because the
 * launcher could not find Bun. These tests pin the two things that caused it:
 *
 *   1. Bun discovery looked only at PATH and our own runtime folder, so a Bun
 *      installed by its own installer (~/.bun/bin, winget, scoop, npm -g) was
 *      invisible and the dashboard was skipped in silence.
 *   2. The services scan was `ss -tlnp`, a Linux tool. On Windows the panel was
 *      honest but useless; netstat ships with Windows and says the same thing.
 *
 * Every parser check runs against a real capture of that platform's output, so
 * these pass on Linux while describing Windows correctly.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ports = require('../listening-ports.js');
const rp = require('../runtime-paths.js');

// ── the services scan on Windows ───────────────────────────────────────────

// Verbatim shape of `netstat -ano` on Windows 11 (pids are illustrative).
const NETSTAT_WIN = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1120
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
  TCP    0.0.0.0:5040           0.0.0.0:0              LISTENING       8124
  TCP    127.0.0.1:5000         0.0.0.0:0              LISTENING       9876
  TCP    192.168.1.20:49812     142.250.72.14:443      ESTABLISHED     7456
  TCP    192.168.1.20:49813     140.82.112.4:443       TIME_WAIT       0
  TCP    [::]:135               [::]:0                 LISTENING       1120
  TCP    [::1]:5000             [::]:0                 LISTENING       9876
  TCP    0.0.0.0:49664          0.0.0.0:0              LISTENING       900
  UDP    0.0.0.0:500            *:*                                    3210
  UDP    [::]:3702              *:*                                    2680
`;

test('Windows netstat: LISTENING rows only, IPv4 and IPv6 both parsed', () => {
  const out = ports.parseNetstatWin(NETSTAT_WIN);
  assert.deepEqual(out.ports, [135, 445, 5000, 5040, 49664]);
  // An established browser connection is not a local service.
  assert.ok(!out.ports.includes(49812), 'ESTABLISHED row leaked into the services list');
  assert.ok(!out.ports.includes(49813), 'TIME_WAIT row leaked into the services list');
  assert.ok(!out.ports.includes(500), 'UDP row leaked into the TCP services list');
  // Windows netstat names no process, so the pid is what we can be honest about.
  assert.equal(out.procs['135'], 'pid 1120');
  assert.equal(out.procs['49664'], 'pid 900');
});

test('platform picks its own tool, and the args match it', () => {
  assert.equal(ports.backendFor('win32'), 'netstat');
  assert.deepEqual(ports.argsFor('netstat', 'win32'), ['-ano']);
  assert.equal(ports.backendFor('darwin'), 'netstat');
  assert.deepEqual(ports.argsFor('netstat', 'darwin'), ['-an', '-p', 'tcp']);
  assert.equal(ports.backendFor('linux'), 'ss');
  assert.deepEqual(ports.argsFor('ss', 'linux'), ['-tlnp']);
});

test('BSD netstat keeps LISTEN and ignores the rest', () => {
  const bsd = `
tcp4       0      0  *.22                   *.*                    LISTEN
tcp6       0      0  *.631                  *.*                    LISTEN
tcp4       0      0  127.0.0.1.5432         127.0.0.1.61000        ESTABLISHED
tcp4       0      0  127.0.0.1.5000         *.*                    LISTEN
`;
  assert.deepEqual(ports.parseNetstatBsd(bsd).ports, [22, 631, 5000]);
});

test('a local address resolves to its port on every shape', () => {
  assert.equal(ports.extractPort('0.0.0.0:135'), 135);
  assert.equal(ports.extractPort('[::]:445'), 445);
  assert.equal(ports.extractPort('127.0.0.1:5000'), 5000);
  assert.equal(ports.extractPort('127.0.0.1.5000'), 5000);
  assert.equal(ports.extractPort('*.*'), 0);
  assert.equal(ports.extractPort(''), 0);
});

test('linux parsing is unchanged by the platform work', () => {
  const ss = `
State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      4096         0.0.0.0:22          0.0.0.0:*     users:(("sshd",pid=812,fd=3))
LISTEN 0      511        127.0.0.1:3579        0.0.0.0:*     users:(("node",pid=1234,fd=21))
`;
  const out = ports.parseSs(ss);
  assert.deepEqual(out.ports, [22, 3579]);
  assert.equal(out.procs['3579'], 'node');
});

// ── finding Bun on a Windows box ───────────────────────────────────────────

test('Bun is found where Windows installers actually put it', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\deke\\AppData\\Local',
    APPDATA: 'C:\\Users\\deke\\AppData\\Roaming',
    ProgramFiles: 'C:\\Program Files',
  };
  const list = rp.wellKnownBun(env, 'win32');
  const home = require('node:os').homedir();
  assert.equal(list[0], path.join(home, '.bun', 'bin', 'bun.exe'), 'bun.sh/install.ps1 writes here — checked first');
  assert.ok(list.includes(path.join('C:\\Users\\deke\\AppData\\Local', 'Programs', 'bun', 'bun.exe')));
  assert.ok(list.includes(path.join('C:\\Users\\deke\\AppData\\Roaming', 'npm', 'bun.cmd')), 'npm -g shim');
  assert.ok(list.includes(path.join('C:\\Program Files', 'Bun', 'bun.exe')));
  // Every candidate must be a concrete path, never a bare name.
  for (const c of list) {
    assert.ok(/[\\/]/.test(c) && /bun(\.exe|\.cmd|\.bat)?$/.test(c), `not a bun path: ${c}`);
  }
});

test('no Windows guesswork on other platforms', () => {
  assert.deepEqual(rp.wellKnownBun({}, 'linux'), []);
  assert.deepEqual(rp.wellKnownBun({}, 'darwin'), []);
});

// ── the launcher must never drop to the old TUI in silence ─────────────────

const CLI_DIR = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(CLI_DIR, p), 'utf8');

test('the launcher consults the Windows locations before falling back', () => {
  const src = read('src/runtime-paths.js');
  assert.ok(/wellKnownBun\(env\)/.test(src), 'findBun no longer consults wellKnownBun');
  const launcher = read('index.js');
  assert.ok(/dashboardDied/.test(launcher), 'a crashing dashboard is no longer reported');
  // 2026-11-26: the launcher no longer only *tells* you to reproduce the crash —
  // it captures the dashboard's own stderr (piped, because the alternate screen
  // wipes it), prints the tail, and names the saved log. Assert that stronger
  // guarantee rather than the old instruction line it replaced.
  assert.ok(/what it said:/.test(launcher), 'a crashed dashboard no longer prints what it actually said');
  assert.ok(/full log:/.test(launcher), 'a crashed dashboard no longer names where its output was saved');
});

test('the Windows installer recognises an existing Bun and says what to do', () => {
  const ps1 = fs.readFileSync(path.join(CLI_DIR, '..', 'install.ps1'), 'utf8');
  // The locator covers every place a Windows Bun lands (PATH, our runtime, .bun,
  // scoop, winget, npm -g, Program Files). Assert the capability, not one spelling:
  // bun.sh/install.ps1 writes %USERPROFILE%\.bun\bin, and that must be covered.
  assert.ok(/function Find-Bun/i.test(ps1), 'install.ps1 has no Bun locator');
  assert.ok(/\.bun\\bin/.test(ps1), 'install.ps1 no longer checks %USERPROFILE%\\.bun\\bin');
  assert.ok(/bun\.exe/.test(ps1), 'install.ps1 no longer looks for bun.exe');
  assert.ok(/irm bun\.sh\/install\.ps1/.test(ps1), 'install.ps1 no longer gives the fallback command');
});

test('the Ink fallback no longer claims a Linux-only tool', () => {
  const ink = read('ui.mjs');
  assert.ok(!ink.includes('ss not readable'), 'the fallback still blames ss on Windows');
  assert.ok(ink.includes('no port tool'));
  // The /ports failure line used to read "ss unavailable — port scan could not
  // run", which is the exact symptom reported from the Surface Pro ("says scan
  // univalible ss not readable"). The scan is platform-aware now, so the line
  // must name the backend that actually failed rather than assuming `ss` — a
  // test that only checked for one misspelling never caught it (§50.1).
  assert.ok(!/ss unavailable/.test(ink), 'the /ports line still names ss on every platform');
  assert.ok(ink.includes('port scan could not run'), 'the /ports failure line is still reported');
  assert.ok(
    /\$\{scan\.backend \|\| "port tool"\} unavailable/.test(ink),
    'the /ports failure line names the backend that failed'
  );
});

// ── the dashboard's native renderer must be installed, not just named ──────
// The Surface Pro's dashboard opened and died because @opentui/core's OPTIONAL
// per-platform package was never installed, and the launcher could only fall
// back with "reinstall the CLI so npm fetches it". Both installers now install
// that package themselves, and the launcher names the exact command.

const REPO_DIR = path.join(CLI_DIR, '..');
const readRoot = (p) => fs.readFileSync(path.join(REPO_DIR, p), 'utf8');

test('the Windows installer installs the renderer for this machine', () => {
  const ps1 = readRoot('install.ps1');
  assert.ok(/@opentui\/core-win32-\$otArch/.test(ps1), 'install.ps1 no longer names the renderer from the architecture');
  assert.ok(/OSArchitecture/.test(ps1), 'the architecture is no longer read from the runtime');
  assert.ok(/Arm64/.test(ps1), 'an ARM64 Surface is no longer handled');
  assert.ok(/Get-Content \$otCore -Raw \| ConvertFrom-Json/.test(ps1), 'the renderer version is no longer matched to the installed @opentui/core');
  assert.ok(/Test-Path \(Join-Path \$p 'package\.json'\)/.test(ps1), 'the installer no longer checks whether the renderer is already present');
  assert.ok(/npm install -g /.test(ps1), 'a failed renderer install no longer gives the exact command');
});

test('the Linux/macOS installer does the same, musl included', () => {
  const sh = readRoot('install.sh');
  assert.ok(/@opentui\/core-\$OT_OS-\$OT_ARCH/.test(sh), 'install.sh no longer names the renderer from uname');
  assert.ok(/-musl/.test(sh), 'musl Linux is no longer handled');
  assert.ok(/aarch64\|arm64\) OT_ARCH=arm64/.test(sh), 'arm64 is no longer mapped');
  assert.ok(/npm install -g --prefix/.test(sh), 'the renderer is no longer installed where the CLI resolves from');
  assert.ok(/dashboard renderer could not be installed/.test(sh), 'a failed renderer install is no longer reported');
});

// ── the renderer version, and the Bun that renderer needs ─────────────────
// The dashboard died on Windows because @opentui/core 0.3.4's per-platform
// package was an early stub build. 0.9.x ships the full native renderer
// (mingw-w64, ffmpeg, libwebp) — and it declares `bun >= 1.3.14`, so an old Bun
// then fails inside the native library, which reads as "the dashboard opened
// and vanished". Both halves are pinned here against the packages themselves,
// so a later bump cannot move one without the other.

test('the CLI ships a renderer new enough to have a real Windows build', () => {
  const pkg = JSON.parse(read('package.json'));
  const floor = (v) => String(v).replace(/^[\^~]/, '').split('.').map(Number);
  const core = floor(pkg.dependencies['@opentui/core']);
  // 0.9.0 is where the Windows package became a full native build; anything
  // below it is the stub that failed on the Surface Pro.
  assert.ok(
    core[0] > 0 || (core[0] === 0 && core[1] >= 9),
    `@opentui/core is ${pkg.dependencies['@opentui/core']} — the Windows renderer needs 0.9.x or newer`
  );
  assert.equal(pkg.dependencies['@opentui/react'], pkg.dependencies['@opentui/core'], 'core and react must move together');
});

test('the launcher refuses a Bun older than the renderer requires', () => {
  const launcher = read('index.js');
  const m = launcher.match(/const MIN_BUN = \[(\d+),\s*(\d+),\s*(\d+)\]/);
  assert.ok(m, 'the launcher no longer declares the Bun floor the renderer needs');
  const min = [Number(m[1]), Number(m[2]), Number(m[3])];
  // The floor is not a guess: it must satisfy @opentui/core's own engines field.
  const corePkg = JSON.parse(read('node_modules/@opentui/core/package.json'));
  const want = String((corePkg.engines && corePkg.engines.bun) || '').match(/(\d+)\.(\d+)\.(\d+)/);
  assert.ok(want, '@opentui/core no longer declares a bun engine — recheck the floor');
  const req = [Number(want[1]), Number(want[2]), Number(want[3])];
  for (let i = 0; i < 3; i += 1) {
    if (min[i] !== req[i]) { assert.ok(min[i] > req[i], `MIN_BUN ${min.join('.')} is below the required ${req.join('.')}`); break; }
  }
  assert.ok(/olderThan\(bunVer, MIN_BUN\)/.test(launcher), 'the floor is declared but never enforced');
  assert.ok(/install Bun from bun\.sh/.test(launcher), 'an old Bun no longer names its own fix');
});

test('the launcher names the exact fix instead of "reinstall the CLI"', () => {
  const src = read('index.js');
  assert.ok(!/reinstall the CLI so npm fetches it/.test(src), 'the launcher still gives the vague instruction');
  assert.ok(/Fix it with: \$\{gap\.fix\}/.test(src), 'the missing-renderer message no longer carries the command');
  assert.ok(/npm install --no-save --no-package-lock \$\{spec\}/.test(src), 'the repair command is no longer built from the real package name');
  assert.ok(/cd "\$\{__dirname\}"/.test(src), 'the repair command no longer installs where this copy resolves from');
  assert.ok(/platformPackages\(\)/.test(src), 'the platform package list is no longer derived once for both paths');
  assert.ok(/coreVersion/.test(src), 'the repair command no longer matches the installed @opentui/core version');
});
