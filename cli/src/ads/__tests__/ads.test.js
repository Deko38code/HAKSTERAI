'use strict';
/* Tests for the ported ad core. Run: node --test cli/src/ads/__tests__/
 *
 * These cover the parts that are security- or money-relevant: escape-sequence
 * stripping (an ad is untrusted text drawn in a terminal), layout fitting, and
 * the timing rules that decide how often a slot auctions and how often an
 * impression is billed. */
const test = require('node:test');
const assert = require('node:assert');

const { sanitizeTerminalText, sanitizeTerminalOutput, sanitizeTerminalStrings } = require('../terminal-safe-text');
const { getInlineAdLayout, wrapToLines, truncateToWidth, extractDomain, MIN_INLINE_WIDTH_WITH_DESTINATION } = require('../inline-ad-layout');
const { getAd, resetAdCache, recordImpression, refusalReason, adSessionSnapshot } = require('../ad-cache');

/* ───────────────────────── sanitizer ───────────────────────── */

test('strips an OSC 52 clipboard write — the reason this exists', () => {
  // A terminal that receives this overwrites the user's clipboard.
  const evil = 'Great deal!\x1b]52;c;cGF3bmVk\x07 on trailers';
  assert.strictEqual(sanitizeTerminalText(evil), 'Great deal! on trailers');
});

test('strips an OSC 8 hyperlink so visible text cannot lie about its target', () => {
  const evil = '\x1b]8;;https://evil.example\x07click me\x1b]8;;\x07';
  assert.strictEqual(sanitizeTerminalText(evil), 'click me');
});

test('strips CSI cursor/screen control', () => {
  assert.strictEqual(sanitizeTerminalText('\x1b[2J\x1b[Hwiped'), 'wiped');
});

test('strips bidi overrides that would make two readers see different words', () => {
  assert.strictEqual(sanitizeTerminalText('invoice\u202egnp.exe\u202c'), 'invoicegnp.exe');
});

test('strips zero-width characters used to split a word invisibly', () => {
  assert.strictEqual(sanitizeTerminalText('p\u200ba\u200by'), 'pay');
});

test('keeps printable text, newlines and indentation intact', () => {
  const ok = 'line one\n  indented\nline three';
  assert.strictEqual(sanitizeTerminalText(ok), ok);
});

test('normalizes CRLF and tabs', () => {
  assert.strictEqual(sanitizeTerminalText('a\r\nb\tc'), 'a\nb  c');
});

test('sanitizeTerminalOutput keeps only the final progress-bar redraw', () => {
  assert.strictEqual(sanitizeTerminalOutput('10%\r50%\r100%\nnext'), '100%\nnext');
});

test('sanitizeTerminalStrings cleans every field and drops prototype keys', () => {
  // JSON.parse makes __proto__ a real OWN key, which an object literal cannot.
  const out = sanitizeTerminalStrings(JSON.parse(JSON.stringify({
    title: 'hi\x1b[31mred',
    nested: { adText: 'oops\x07' },
    list: ['\x1b]52;c;x\x07ok'],
    payload: { __proto__: { polluted: true }, keep: 'yes' },
  })));
  assert.strictEqual(out.title, 'hired');
  assert.strictEqual(out.nested.adText, 'oops');
  assert.deepStrictEqual(out.list, ['ok']);
  assert.strictEqual({}.polluted, undefined, 'prototype must not be polluted');
  assert.ok(!Object.prototype.hasOwnProperty.call(out.payload, '__proto__'));
  assert.strictEqual(out.payload.keep, 'yes');
});

/* ───────────────────────── layout ───────────────────────── */

test('extractDomain drops www and survives an unparseable url', () => {
  assert.strictEqual(extractDomain('https://www.neon.tech/pricing'), 'neon.tech');
  // unparseable, so it is shown as-is — but with the escape sequence stripped
  assert.strictEqual(extractDomain('not a url\x1b[31m'), 'not a url');
});

test('layout shows the destination at wide widths but hides it when narrow', () => {
  const ad = { title: 'Ship faster with Neon', adText: 'Serverless Postgres for agents', url: 'https://neon.tech' };
  const wide = getInlineAdLayout(ad, 80);
  assert.strictEqual(wide.label, 'neon.tech');
  const narrow = getInlineAdLayout(ad, MIN_INLINE_WIDTH_WITH_DESTINATION - 1);
  assert.strictEqual(narrow.label, '');
});

test('layout never exceeds the width it was given', () => {
  const ad = { title: 'x'.repeat(200), adText: 'y'.repeat(200), url: 'https://example.com' };
  for (const w of [20, 40, 48, 60, 80, 120]) {
    const { title, description, label } = getInlineAdLayout(ad, w);
    assert.ok(title.length <= Math.max(0, w - 4), `title ${title.length} > ${w - 4} at width ${w}`);
    assert.ok(description.length <= Math.max(0, w - 4), `desc at width ${w}`);
    assert.ok(label.length <= 24, `label at width ${w}`);
  }
});

test('truncateToWidth ellipsizes rather than overflowing', () => {
  assert.strictEqual(truncateToWidth('abcdefgh', 4), 'abc…');
  assert.strictEqual(truncateToWidth('abc', 4), 'abc');
  assert.strictEqual(truncateToWidth('abc', 0), '');
});

test('wrapToLines hard-splits a word longer than the line', () => {
  const lines = wrapToLines('see https://example.com/' + 'a'.repeat(60) + ' now', 20, 4);
  assert.ok(lines.length <= 4);
  for (const l of lines) assert.ok(l.length <= 20, `"${l}" is ${l.length} cols`);
});

test('wrapToLines respects maxLines', () => {
  const lines = wrapToLines(Array.from({ length: 40 }, (_, i) => 'w' + i).join(' '), 20, 3);
  assert.ok(lines.length <= 3, `got ${lines.length} lines`);
});

/* ───────────────────────── ad cache ───────────────────────── */

function fakeAuction(ads, provider = 'first_party') {
  const calls = { n: 0 };
  const deps = {
    adsEnabled: () => true,
    authToken: () => 'token-a',
    announcedPlacements: async () => ['CLI-Slot'],
    fetchAuction: async () => { calls.n++; return { ads, provider }; },
    sanitize: (a) => a,
    now: () => 1000,
  };
  return { deps, calls };
}
const AD = { title: 'T', adText: 'D', url: 'https://e.com', impUrl: 'imp-1', provider: 'first_party' };

test('a held answer is served without a second auction', async () => {
  resetAdCache();
  const { deps, calls } = fakeAuction([AD]);
  const a = await getAd('CLI-Slot', deps);
  const b = await getAd('CLI-Slot', deps);
  assert.strictEqual(a.title, 'T');
  assert.strictEqual(b.title, 'T');
  assert.strictEqual(calls.n, 1, 'should auction once inside the TTL');
});

test('a NO-FILL is held exactly as firmly as a fill', async () => {
  resetAdCache();
  const { deps, calls } = fakeAuction([]);
  assert.strictEqual(await getAd('CLI-Slot', deps), null);
  assert.strictEqual(await getAd('CLI-Slot', deps), null);
  assert.strictEqual(calls.n, 1, 'a paced-out slot must not re-auction per keystroke');
});

test('the hold expires so a paused campaign stops showing', async () => {
  resetAdCache();
  let t = 1000;
  const { deps, calls } = fakeAuction([AD]);
  deps.now = () => t;
  deps.ttlMs = 100;
  await getAd('CLI-Slot', deps);
  t = 1200; // past the TTL
  await getAd('CLI-Slot', deps);
  assert.strictEqual(calls.n, 2);
});

test('concurrent asks share one in-flight request', async () => {
  resetAdCache();
  const { deps, calls } = fakeAuction([AD]);
  const [a, b] = await Promise.all([getAd('CLI-Slot', deps), getAd('CLI-Slot', deps)]);
  assert.strictEqual(a.title, b.title);
  assert.strictEqual(calls.n, 1);
});

test('one impression per held answer, even as the row remounts', async () => {
  resetAdCache();
  const { deps } = fakeAuction([AD]);
  const ad = await getAd('CLI-Slot', deps);
  let acks = 0;
  const ack = () => { acks++; return true; };
  assert.strictEqual(recordImpression(ad, ack), true);
  assert.strictEqual(recordImpression(ad, ack), false, 'a remount must not re-bill');
  assert.strictEqual(recordImpression(ad, ack), false);
  assert.strictEqual(acks, 1);
});

test('a failed acknowledgement rolls back so it can be retried', async () => {
  resetAdCache();
  const { deps } = fakeAuction([AD]);
  const ad = await getAd('CLI-Slot', deps);
  assert.strictEqual(recordImpression(ad, () => false), false);
  assert.strictEqual(recordImpression(ad, () => true), true, 'rollback must allow a retry');
});

test('switching account drops the previous account\'s held fill', async () => {
  resetAdCache();
  const { deps, calls } = fakeAuction([AD]);
  await getAd('CLI-Slot', deps);
  deps.authToken = () => 'token-b';
  await getAd('CLI-Slot', deps);
  assert.strictEqual(calls.n, 2, 'a second account must not be served the first one\'s ad');
});

test('refusals: ads off, not announced, no impression url, foreign fill', () => {
  assert.strictEqual(refusalReason({ adsEnabled: false }), 'ads-off');
  assert.strictEqual(refusalReason({ adsEnabled: true, announcedIds: [], placementId: 'X' }), 'placement-not-announced');
  assert.strictEqual(refusalReason({ adsEnabled: true, ad: { title: 't' } }), 'no-impression-url');
  assert.strictEqual(refusalReason({ adsEnabled: true, ad: AD, provider: 'gravity', requireFirstParty: true }), 'foreign-fill');
  assert.strictEqual(refusalReason({ adsEnabled: true, ad: AD, provider: 'first_party', requireFirstParty: true }), null);
  // an honest no-fill is not a refusal
  assert.strictEqual(refusalReason({ adsEnabled: true, ad: undefined }), null);
});

test('a foreign-network fill is never drawn', async () => {
  resetAdCache();
  const { deps } = fakeAuction([AD], 'gravity');
  assert.strictEqual(await getAd('CLI-Slot', deps), null);
});

test('an explicit empty ad list is an honest no-fill, not an empty ad', async () => {
  resetAdCache();
  const { deps } = fakeAuction([]);
  assert.strictEqual(await getAd('CLI-Slot', deps), null);
});

test('an unannounced placement is refused without a round trip', async () => {
  resetAdCache();
  const { deps, calls } = fakeAuction([AD]);
  deps.announcedPlacements = async () => [];
  assert.strictEqual(await getAd('CLI-Slot', deps), null);
  assert.strictEqual(calls.n, 0, 'must not call out for a placement nobody announced');
});

test('a throwing auction yields a held no-fill rather than an unhandled rejection', async () => {
  resetAdCache();
  const { deps } = fakeAuction([AD]);
  deps.fetchAuction = async () => { throw new Error('network'); };
  assert.strictEqual(await getAd('CLI-Slot', deps), null);
  assert.ok(adSessionSnapshot().failedRequests >= 1);
});
