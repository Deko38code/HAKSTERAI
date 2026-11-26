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
  assert.ok(/the full error:/.test(launcher), 'the operator is no longer told how to see the real error');
});

test('the Windows installer recognises an existing Bun and says what to do', () => {
  const ps1 = fs.readFileSync(path.join(CLI_DIR, '..', 'install.ps1'), 'utf8');
  assert.ok(/\.bun\\bin\\bun\.exe/.test(ps1), 'install.ps1 no longer knows about bun.sh/install.ps1');
  assert.ok(/irm bun\.sh\/install\.ps1/.test(ps1), 'install.ps1 no longer gives the fallback command');
});

test('the Ink fallback no longer claims a Linux-only tool', () => {
  const ink = read('ui.mjs');
  assert.ok(!ink.includes('ss not readable'), 'the fallback still blames ss on Windows');
  assert.ok(ink.includes('no port tool'));
});
