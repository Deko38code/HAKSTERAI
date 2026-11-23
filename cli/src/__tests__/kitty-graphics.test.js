'use strict';
/* Tests for the kitty graphics helper (no terminal needed — the writer is
 * captured in memory). Run: node --test cli/src/__tests__/kitty-graphics.test.js */
const test = require('node:test');
const assert = require('node:assert');
const kg = require('../kitty-graphics.js');

test('detects kitty from env, refuses plain terminals', () => {
  assert.equal(kg.isSupported({ KITTY_WINDOW_ID: '3' }, { isTTY: true }), true);
  assert.equal(kg.isSupported({ TERM: 'xterm-kitty' }, { isTTY: true }), true);
  assert.equal(kg.isSupported({ TERM_PROGRAM: 'Ghostty' }, { isTTY: true }), true);
  assert.equal(kg.isSupported({ TERM: 'xterm-256color' }, { isTTY: true }), false);
  assert.equal(kg.isSupported({ KITTY_WINDOW_ID: '3' }, { isTTY: false }), false);
  assert.equal(kg.isSupported({ KITTY_WINDOW_ID: '3', HAKSTER_GRAPHICS: 'off' }, { isTTY: true }), false);
});

test('PNG size is read from IHDR', () => {
  const fs = require('node:fs');
  const buf = fs.readFileSync(kg.logoPath());
  const size = kg.pngSize(buf);
  assert.ok(size && size.width === 256 && size.height === 256, JSON.stringify(size));
});

test('transmits in chunks with metadata on the first only', () => {
  const out = [];
  const res = kg.placeImage({ cols: 20, rows: 10, id: 7, write: (s) => out.push(s) });
  assert.ok(res && res.chunks >= 2, 'expected multiple chunks');
  assert.match(out[0], /^\x1b_Ga=T,f=100,t=d,c=20,r=10,i=7,z=-1,C=1,q=2,m=1;/);
  assert.match(out[0], /\x1b\\$/);
  for (const chunk of out.slice(1, -1)) assert.match(chunk, /^\x1b_Gm=1;[A-Za-z0-9+/=]+\x1b\\$/);
  assert.match(out[out.length - 1], /^\x1b_Gm=0;[A-Za-z0-9+/=]+\x1b\\$/);
  const payload = out.map((s) => s.replace(/^\x1b_G[^;]*;/, '').replace(/\x1b\\$/, '')).join('');
  assert.equal(Buffer.from(payload, 'base64').length, res.bytes);
});

test('delete and cursor sequences are well formed', () => {
  const out = [];
  kg.moveCursor(4, 9, (s) => out.push(s));
  kg.deleteImage(7, (s) => out.push(s));
  kg.deleteAll((s) => out.push(s));
  assert.deepEqual(out, ['\x1b[4;9H', '\x1b_Ga=d,d=i,i=7,q=2\x1b\\', '\x1b_Ga=d,d=a,q=2\x1b\\']);
});

test('missing file is reported, never thrown', () => {
  assert.equal(kg.placeImage({ file: '/nonexistent/logo.png', write: () => {} }), null);
});
