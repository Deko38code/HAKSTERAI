// header-vars-declared.test.mjs — an undeclared identifier in the header cost
// every 0.3.129 install its dashboard: `...memTallParts` was spread where
// `memTotalParts` was meant, so App threw `ReferenceError` on first render and
// the TUI never painted. The suite stayed green because nothing renders App.
//
// This pins the cheap invariant that would have caught it: every identifier in
// the header's part-array cluster (`mem*`, `header*`, `health*`) that is used in
// a spread must also be declared in the file. It is deliberately not a
// type-checker — it only makes this exact class of slip unshipable.
//
// `npm run build:ui` is what carries the fix to users (§50.2); this test is what
// stops the fix being needed again.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src', 'App.jsx'), 'utf8');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Only the header cluster — a broader scan would flag every `...props` spread
// and every destructured param, which is noise, not signal.
const spreadIdents = new Set();
for (const m of src.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) {
  const id = m[1];
  if (/^(mem|header|health)/.test(id)) spreadIdents.add(id);
}

test('the scan actually found the header cluster', () => {
  assert.ok(src.includes('...memBar'), 'App.jsx no longer spreads ...memBar — the scan has gone stale');
  assert.ok(spreadIdents.size >= 3, `only ${spreadIdents.size} header identifiers found`);
});

test('every header identifier spread in App.jsx is declared', () => {
  const missing = [...spreadIdents].filter((id) => {
    const declared = new RegExp(`(?:const|let|var|function)\\s+${escape(id)}\\b`).test(src);
    // A shorthand destructure or a parameter also declares it.
    const param = new RegExp(`[{,(]\\s*${escape(id)}\\s*[,})=]`).test(src);
    return !declared && !param;
  });
  assert.deepEqual(missing, [], `undeclared in App.jsx: ${missing.join(', ')}`);
});
