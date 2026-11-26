/* esc closes the dashboard, and /menu closes it on the way in (§ page exits).
 *
 * Owner, 2026-11-26: "need to make sure the /menu closes the dashboard 1
 * wouldnt close with esc".
 *
 * Two things are pinned here:
 *   1. esc leaves the dashboard — the one full page that had no escape exit
 *      (monitor, usage, scripts, squad, mcp, settings, debug and models all
 *      already handled it). A run in flight still stops first.
 *   2. `/menu` and its Ctrl+P shortcut close a full page before opening the
 *      palette, because CatalogPopout draws in the chat column's composer slot
 *      — opening it over the dashboard would show nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'src', 'App.jsx');
const src = fs.readFileSync(APP, 'utf8');

const block = (start, end) => {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `missing anchor: ${start}`);
  const stop = src.indexOf(end, at);
  assert.ok(stop > at, `missing end anchor: ${end}`);
  return src.slice(at, stop);
};

test('esc leaves the dashboard as well as the monitor', () => {
  // Anchor on the branch's own comment: the /menu popout has an esc one-liner
  // higher up in the same handler, so a bare `if (key.name === 'escape')`
  // anchor would match the wrong block.
  const at = src.indexOf('// esc is the way out of every page');
  assert.ok(at > 0, 'missing the app-wide esc branch');
  const start = src.lastIndexOf("if (key.name === 'escape') {", at);
  assert.ok(start > 0, 'esc branch must start before its comment');
  const esc = src.slice(start, src.indexOf('return;\n    }', at));
  // A run in flight is still stopped by the first esc, never left running.
  assert.match(esc, /if \(agent\.busy\) agent\.abort\(\)/, 'esc must still stop a live run first');
  assert.match(esc, /view === 'monitor' \|\| view === 'dashboard'/, 'esc must return the dashboard to chat');
  assert.match(esc, /setView\('chat'\)/, 'esc must set the chat view');
});

test('/menu closes the full page before opening the popout', () => {
  const menu = block("case '/menu':", 'return;');
  const viewAt = menu.indexOf("setView('chat')");
  const openAt = menu.indexOf('setMenuOpen(true)');
  assert.ok(viewAt >= 0, '/menu must return to the chat view');
  assert.ok(openAt >= 0, '/menu must open the popout');
  assert.ok(viewAt < openAt, '/menu must close the page before the popout opens');
});

test('Ctrl+P closes the full page the same way /menu does', () => {
  const ctrlP = block("if (key.ctrl && key.name === 'p') {", 'return;\n    }');
  assert.match(ctrlP, /setMenuQuery\(''\)/, 'Ctrl+P still resets the filter');
  const viewAt = ctrlP.indexOf("setView('chat')");
  const openAt = ctrlP.indexOf('setMenuOpen(true)');
  assert.ok(viewAt >= 0, 'Ctrl+P must return to the chat view');
  assert.ok(viewAt < openAt, 'Ctrl+P must close the page before the popout opens');
});
