import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/utils/scripts.js';
import { peersFromMcp } from '../src/utils/squad.js';

/* The compare window and the squad list both read real state; these pin the
 * two pure functions they are built on. */

test('diffLines marks nothing when the source is unchanged', () => {
  const src = ['#!/bin/bash', 'set -e', 'echo hi'];
  assert.deepEqual(diffLines(src, src).map((d) => d.mark), ['', '', '']);
});

test('diffLines marks a changed line instead of reporting the whole file', () => {
  const before = ['a', 'b', 'c'];
  const after = ['a', 'B', 'c'];
  const out = diffLines(before, after);
  assert.deepEqual(out.filter((d) => d.mark === '-').map((d) => d.text), ['b']);
  assert.deepEqual(out.filter((d) => d.mark === '+').map((d) => d.text), ['B']);
  assert.equal(out.filter((d) => d.mark === '').length, 2);
});

test('diffLines reports a removed line and keeps duplicate lines matched by count', () => {
  const out = diffLines(['x', 'x', 'y'], ['x']);
  assert.deepEqual(out.filter((d) => d.mark === '-').map((d) => d.text).sort(), ['x', 'y']);
  assert.equal(out.filter((d) => d.mark === '').length, 1);
});

test('diffLines with no previous snapshot is the source, unmarked', () => {
  assert.deepEqual(diffLines(null, ['a', 'b']), [
    { text: 'a', mark: '' },
    { text: 'b', mark: '' },
  ]);
});

test('peersFromMcp lists only agent servers, live first and lazy next, and never invents tools', () => {
  const peers = peersFromMcp({
    servers: [
      { name: 'filesystem', initialized: true, toolCount: 14, tools: ['read'] },
      { name: 'codex', initialized: false, lazy: true, toolCount: 1, tools: ['codex_readonly'] },
      { name: 'kiro', initialized: false, lazy: false, toolCount: 0, tools: [] },
      { name: 'squad', initialized: true, toolCount: 4, tools: ['squad_recon', 'squad_bypass', 'squad_browser_bridge', 'squad_report'] },
      { name: 'phantom', initialized: true, toolCount: 9, tools: ['phantom_status'] },
    ],
  });
  assert.deepEqual(peers.map((p) => p.name), ['phantom', 'squad', 'codex', 'kiro']);
  assert.deepEqual(peers.map((p) => p.state), ['live', 'live', 'lazy', 'down']);
  // A tool count on an uninitialized server is a probe, not a connection.
  assert.equal(peers[2].up, false);
  assert.equal(peers[2].tools.length, 1);
  assert.deepEqual(peers[1].tools, ['squad_recon', 'squad_bypass', 'squad_browser_bridge', 'squad_report']);
});

test('peersFromMcp is empty, not a crash, before the server has answered', () => {
  assert.deepEqual(peersFromMcp(null), []);
  assert.deepEqual(peersFromMcp({}), []);
});
