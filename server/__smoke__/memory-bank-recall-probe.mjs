#!/usr/bin/env node
// memory-bank-recall-probe — a saved memory must also reach the bank the ◈
// header counts and the per-task recall reads.
//
// Owner, 2026-11-26: "always add memory to bank up top in tui to" and "add
// memory recall before each task". saveMemory() used to write only the keyed
// row in data/hakster.db, so a save never moved the header and never appeared
// in what a run starts from. This probe pins the whole loop with an isolated
// bank directory (HAKSTER_HOME), then runs the REAL buildMemoryFirstBlock
// sliced out of server/src/index.js against what was banked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✔ ${name}`); }
  else { fail++; console.log(`✘ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Isolate every bank write into a temp home BEFORE autolearn is loaded.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hakster-bank-probe-'));
process.env.HAKSTER_HOME = TMP;
const BANKS = path.join(TMP, '.hakster', 'memories', 'banks');

const autolearn = (await import(path.join(ROOT, 'server/src/agent/autolearn.js'))).default
  || (await import(path.join(ROOT, 'server/src/agent/autolearn.js')));
const memory = (await import(path.join(ROOT, 'server/src/memory.js'))).default
  || (await import(path.join(ROOT, 'server/src/memory.js')));

const readBankFile = (slug) => {
  const p = path.join(BANKS, `${slug}.json`);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
};

// ── 1. A save lands in the bank the header counts ──────────────────────────
const KEY = 'probe-bank-loop';
const VALUE = 'the deploy lane needs the timestamped build directory, verified by hash';
const r1 = memory.bankSavedMemory({ category: 'preference', key: KEY, value: VALUE, source: 'probe', confidence: 0.9 });
const prefs = readBankFile('user-preferences');
check('a preference save is filed into the User Preferences bank',
  r1 && r1.banked === true && r1.section === 'User Preferences', JSON.stringify(r1));
check('the banked entry carries the key so recall can match it',
  prefs.some((e) => String(e.observation).startsWith(`${KEY}:`)),
  `${prefs.length} entries`);
check('bankSavedMemory needs no database',
  typeof memory.bankSavedMemory === 'function' && !('getDb' in memory));

// ── 2. An update replaces its own copy, never duplicates it ───────────────
const VALUE2 = 'the deploy lane needs the timestamped build directory AND a byte-identical rollback';
memory.bankSavedMemory({ category: 'preference', key: KEY, value: VALUE2, source: 'probe', confidence: 0.9 });
const afterUpdate = readBankFile('user-preferences').filter((e) => String(e.observation).startsWith(`${KEY}:`));
check('an updated key keeps exactly one bank entry', afterUpdate.length === 1, `${afterUpdate.length} entries`);
check('the surviving entry is the new value, not the stale one',
  afterUpdate.length === 1 && afterUpdate[0].observation.includes('byte-identical rollback'),
  afterUpdate[0] ? afterUpdate[0].observation.slice(0, 80) : 'none');

// ── 3. The credential guard is shape-only ─────────────────────────────────
const rSecret = memory.bankSavedMemory({ category: 'fact', key: 'probe-cred', value: 'sk-' + 'a'.repeat(32), source: 'probe' });
check('a credential-shaped value is refused a bank file',
  rSecret && rSecret.banked === false && rSecret.reason === 'credential-shaped', JSON.stringify(rSecret));
check('…and nothing was written for it',
  !readBankFile('project-facts').some((e) => String(e.observation).startsWith('probe-cred:')));
const rProse = memory.bankSavedMemory({ category: 'fact', key: 'probe-prose', value: 'usage tokens are counted per key, never guessed', source: 'probe' });
check('prose that merely mentions tokens still banks', rProse && rProse.banked === true, JSON.stringify(rProse));

// ── 4. Recall reads it — the real buildMemoryFirstBlock from index.js ─────
function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let j = src.indexOf(') {', start) + 2;
  let depth = 0;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '`') { for (j++; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === '`') break; } continue; }
    if (c === "'" || c === '"') { for (j++; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === c) break; } continue; }
    if (c === '/') {
      if (src[j + 1] === '/') { for (; j < src.length; j++) if (src[j] === '\n') break; continue; }
      if (src[j + 1] === '*') { for (j += 2; j < src.length; j++) if (src[j] === '*' && src[j + 1] === '/') { j++; break; } continue; }
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
const idx = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
const buildMemoryFirstBlock = new Function('autolearn', 'searchMemories',
  `${sliceFunction(idx, 'scoreMemoryText')}\n${sliceFunction(idx, 'buildMemoryFirstBlock')}\nreturn buildMemoryFirstBlock;`
)(autolearn, () => []);

const recalled = buildMemoryFirstBlock('the deploy lane needs a rollback before the build', { maxMistakes: 4, maxLessons: 4 });
check('the run recalls what this save banked', recalled.count > 0 && recalled.text.includes('byte-identical rollback'),
  `${recalled.count} recalled`);
check('the recall block is headed as MEMORY FIRST',
  recalled.text.startsWith('=== MEMORY FIRST'), recalled.text.slice(0, 40));

// ── 5. The run's own prompt really carries the block ─────────────────────
check('the run builds the block from the task, before the first model call',
  /const memoryFirst = buildMemoryFirstBlock\(lastUserMsg\?\.content/.test(idx));
check('…and appends it to the system prompt',
  /!customerDirective && memoryFirst\.text \? '\\n\\n' \+ memoryFirst\.text/.test(idx));
check('…and announces it on the stream with its own counts',
  /type: 'memory_recall'/.test(idx));

// ── 6. The bank never exceeds its cap ────────────────────────────────────
check('banks stay within BANK_CAP', readBankFile('user-preferences').length <= autolearn.BANK_CAP);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
