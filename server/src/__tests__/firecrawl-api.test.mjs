import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { apiBases, isAccountFailure, searchRows, DEFAULT_BASES } = require('../firecrawl-api.js');

// Firecrawl moved to API v2 — v1 retires 2026-12-10 (owner's notice, 2026-11-26).
// These pin the migration so a later edit cannot quietly drop back to v1-only, and
// pin the two response shapes the code has to read.

test('v2 is tried first, v1 stays behind it as the fallback', () => {
  assert.equal(DEFAULT_BASES[0], 'https://api.firecrawl.dev/v2');
  assert.equal(DEFAULT_BASES[1], 'https://api.firecrawl.dev/v1');
  assert.deepEqual(apiBases(), DEFAULT_BASES);
});

test('FIRECRAWL_BASE_URL pins one base and drops the fallback', () => {
  const before = process.env.FIRECRAWL_BASE_URL;
  process.env.FIRECRAWL_BASE_URL = 'https://firecrawl-proxy.internal/v2/';
  try {
    assert.deepEqual(apiBases(), ['https://firecrawl-proxy.internal/v2']);
  } finally {
    if (before === undefined) delete process.env.FIRECRAWL_BASE_URL;
    else process.env.FIRECRAWL_BASE_URL = before;
  }
  assert.deepEqual(apiBases(), DEFAULT_BASES, 'the default comes back when the override is gone');
});

test('an auth/limit refusal is not retried on another API version', () => {
  for (const s of [401, 403, 429]) assert.equal(isAccountFailure(s), true, `status ${s}`);
  for (const s of [0, 400, 404, 500, 502]) assert.equal(isAccountFailure(s), false, `status ${s}`);
});

test('search reads the v1 shape (data[])', () => {
  const rows = searchRows({ success: true, data: [{ url: 'https://a.example', title: 'A', description: 'about a' }] });
  assert.deepEqual(rows, [{ title: 'A', url: 'https://a.example', snippet: 'about a' }]);
});

test('search reads the v2 shape (data.web[])', () => {
  const rows = searchRows({ success: true, data: { web: [{ url: 'https://b.example', title: 'B', description: 'about b' }] } });
  assert.deepEqual(rows, [{ title: 'B', url: 'https://b.example', snippet: 'about b' }]);
});

test('search never throws on an unexpected body — it answers no rows', () => {
  assert.deepEqual(searchRows(null), []);
  assert.deepEqual(searchRows({ success: false, error: 'nope' }), []);
  assert.deepEqual(searchRows({ data: { web: 'not-an-array' } }), []);
});
