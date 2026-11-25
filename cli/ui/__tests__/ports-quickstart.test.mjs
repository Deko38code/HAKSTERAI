/* ports-quickstart — the /menu numbers start a port, and never bounce a live one.
 *
 * Owner, 2026-11-26: "and add ports to /menu for quick start ports etc with
 * 1-10 commands to start from clicking what # to start in menu man if users
 * want to". These tests pin the three things that would make the feature wrong
 * rather than merely different:
 *
 *   - the numbering matches the top grid's order, so `3` means the same port in
 *     both places and the operator never has to learn two mappings;
 *   - a listening port is REFUSED, not started, because `pm2 start` on a live
 *     app is a bounce and a bounce drops whoever is attached (CLAUDE.md §37, §45);
 *   - a service this box cannot start says so instead of firing a command that
 *     cannot work (phantom lives on the Parrot box) — §13, never claim an action
 *     that did not happen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  QUICKSTART_PORTS,
  quickStartNumber,
  quickStartRows,
  quickStartEntry,
  startPlan,
} from '../src/ports-quickstart.mjs';
import { EXPECTED_SERVICES } from '../../smartness.mjs';

const CLI_DIR = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const REPO = path.resolve(CLI_DIR, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const SCAN = { ok: true, ports: [3579, 3580, 5555, 8081, 8100, 8111, 8112, 8888, 5599], procs: {}, at: Date.now() };
const SERVICES = EXPECTED_SERVICES.map((s) => ({ ...s, up: SCAN.ports.includes(s.port), proc: '' }));

test('there are at most ten numbered quick starts, numbered 1-10 with no gaps', () => {
  assert.ok(QUICKSTART_PORTS.length <= 10, `${QUICKSTART_PORTS.length} entries — the keys are 1-0`);
  const numbers = QUICKSTART_PORTS.map((e) => e.n);
  assert.deepEqual(numbers, Array.from({ length: QUICKSTART_PORTS.length }, (_, i) => i + 1));
});

test('the 0 key is the tenth entry, and nothing else is a number key', () => {
  assert.equal(quickStartNumber('0'), 10);
  for (let d = 1; d <= 9; d += 1) assert.equal(quickStartNumber(String(d)), d);
  for (const notANumber of ['a', 'enter', 'up', '', null, undefined, '11']) {
    assert.equal(quickStartNumber(notANumber), 0, `${notANumber} is not a quick-start key`);
  }
});

test('the first numbers match the top grid: 3 is phantom in both places', () => {
  assert.deepEqual(
    QUICKSTART_PORTS.slice(0, EXPECTED_SERVICES.length).map((e) => e.port),
    EXPECTED_SERVICES.map((s) => s.port),
    'the menu numbering must follow the same order as the ports grid',
  );
});

test('every entry names a real port, a name, and a start path or an honest reason', () => {
  for (const e of QUICKSTART_PORTS) {
    assert.ok(Number.isInteger(e.port) && e.port > 0, `bad port on #${e.n}`);
    assert.ok(String(e.name || '').length > 0, `#${e.n} has no name`);
    assert.ok(e.pm2 === null || /^[a-z0-9][a-z0-9-]*$/.test(e.pm2), `#${e.n} pm2 name ${e.pm2}`);
  }
  const phantom = QUICKSTART_PORTS.find((e) => e.port === 4000);
  assert.ok(phantom, 'phantom should keep its grid slot');
  assert.equal(phantom.pm2, null, 'phantom runs on the Parrot box — no local pm2 name may be invented');
});

test('live state comes from the scan, including ports outside EXPECTED_SERVICES', () => {
  const rows = quickStartRows(SERVICES, SCAN);
  const byPort = new Map(rows.map((r) => [r.port, r]));
  assert.equal(byPort.get(3579).up, true);
  assert.equal(byPort.get(4000).up, false);
  // 8888 and 8100 are not in EXPECTED_SERVICES, so a services-only reading would
  // paint them red while they are listening — the scan has to win.
  assert.equal(byPort.get(8888).up, true, 'stalkerhek listens on 8888');
  assert.equal(byPort.get(8100).up, true, 'hakterm listens on 8100');
  assert.equal(byPort.get(8888).color, 'green');
  assert.equal(byPort.get(4000).color, 'red');
});

test('each row shows the number to press, and carries the action behind it', () => {
  const rows = quickStartRows(SERVICES, SCAN);
  for (const row of rows) {
    assert.ok(row.label.startsWith(`${row.n} `), `row ${row.n} must lead with its key: ${row.label}`);
    assert.equal(row.action.port, row.n);
    assert.equal(row.kind, 'port');
  }
  assert.equal(quickStartEntry(2, SERVICES, SCAN).port, 8081);
  assert.equal(quickStartEntry(10, SERVICES, SCAN).port, 5599);
  assert.equal(quickStartEntry(11, SERVICES, SCAN), null);
});

test('a listening port is refused, never restarted', () => {
  const entry = quickStartEntry(1, SERVICES, SCAN);
  assert.equal(entry.up, true);
  const plan = startPlan(entry);
  assert.equal(plan.cmd, undefined, 'an online service must not produce a command');
  assert.match(plan.skip, /already online/);
  assert.match(plan.skip, /not bouncing/);
});

test('a down service with a pm2 name starts with `pm2 start`, never `restart`', () => {
  const downScan = { ok: true, ports: [3579], procs: {}, at: Date.now() };
  const rows = quickStartRows(SERVICES.map((s) => ({ ...s, up: s.port === 3579 })), downScan);
  const cinevault = rows.find((r) => r.port === 8081);
  const plan = startPlan(cinevault);
  assert.equal(plan.cmd, 'pm2');
  assert.deepEqual(plan.args, ['start', 'cinevault']);
  assert.ok(!plan.args.includes('restart'), 'quick start must never bounce a service');
});

test('phantom explains it is not local instead of firing a command that cannot work', () => {
  const plan = startPlan(quickStartEntry(3, SERVICES, SCAN));
  assert.equal(plan.cmd, undefined);
  assert.match(plan.skip, /Parrot/);
});

test('App.jsx wires the digits to the starter and puts PORTS in the menu', () => {
  const app = read('cli/ui/src/App.jsx');
  assert.match(app, /quickStartNumber\(key\.name\)/, 'digit keys must reach the quick start');
  assert.match(app, /startPortByNumber\(portNumber\)/, 'the digit must start that port');
  assert.match(app, /pushSection\('PORTS · press 1-0 to start one'/, 'the menu needs its PORTS block');
  assert.match(app, /'port' in row\.action/, 'enter on a port row must run the same start');
  // The refusals live in the module, so a source edit cannot quietly turn a
  // start into a restart.
  assert.ok(!/startPortByNumber[\s\S]{0,4000}pm2[\s\S]{0,80}restart/.test(app),
    'the quick-start path must never call pm2 restart');
});

test('a row colour is honoured by the popout renderer', () => {
  const popout = read('cli/ui/src/components/CatalogPopout.jsx');
  assert.match(popout, /row\.color \|\| KIND_COLOR\[row\.kind\]/);
  assert.match(popout, /port: 'green'/);
  assert.match(popout, /1-0 starts a port/);
});

test('the shipped TUI bundle carries the quick start', () => {
  const bundle = read('cli/ui-fb.mjs');
  // ASCII-only markers: esbuild escapes the box-drawing characters (`·` lands
  // in the bundle as `\xB7`), so a marker containing one would report a stale
  // bundle that is actually current.
  for (const marker of ['press 1-0 to start one', 'already online', 'no local start command']) {
    assert.ok(
      bundle.includes(marker),
      `ui-fb.mjs is stale — run npm run build:ui so the shipped TUI carries ${marker}`,
    );
  }
});
