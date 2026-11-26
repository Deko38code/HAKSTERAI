#!/usr/bin/env node
'use strict';
/**
 * Add or update one model key id in the per-key registry.
 *
 * Owner (2026-11-26): "i will add a new key and we will gie each ollama key id so
 * we know how many reqeuest usage tokens per token".
 *
 * A key added later is DATA, not a code change (§26.5 — same shape as a new
 * client): this writes `data/provider-keys.json` through the same module the
 * server reads, so the CLI billing page and the admin meter pick it up on their
 * next poll.
 *
 * What is stored: the id, a label, the client it serves, the env-var NAME it
 * lives in, its lanes, its basis and — only when the value is already in this
 * process's environment — a 16-char SHA-256 prefix used to tell two keys apart.
 * The value itself is never written, printed or echoed (§9, §23, §31).
 *
 * Usage:
 *   node scripts/provider-key-add.cjs --id key-junkalot-2 --label "Junkalot Coach 2" \
 *        --client junkalot.co --env-var OLLAMA_JUNKALOT_KEY_2 --lanes "" --basis recorded-lane \
 *        [--note "..." ] [--replace]
 *
 *   --fingerprint-env NAME   compute the prefix from process.env[NAME] if it is set
 *
 * Exit codes: 0 written · 1 refused (duplicate id without --replace, bad args)
 */

const providerKeys = require('../server/src/providerKeys');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  // A bare flag (e.g. --replace) has no value after it.
  return next && !next.startsWith('--') ? next : true;
}

const id = String(arg('id', '') || '').trim();
if (!id) {
  console.error('✗ --id is required, e.g. --id key-junkalot-2');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
  console.error('✗ --id must be lowercase letters, digits and dashes (2–63 chars)');
  process.exit(2);
}

const replace = arg('replace', false) === true;
const registry = providerKeys.loadRegistry();
const existing = registry.keys.find((k) => k.id === id);
if (existing && !replace) {
  console.error(`✗ ${id} already exists — pass --replace to update it (nothing was written)`);
  process.exit(1);
}

const lanesRaw = arg('lanes', existing ? existing.lanes.join(',') : '');
const lanes = typeof lanesRaw === 'string'
  ? lanesRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20)
  : [];

// The fingerprint is computed from the live value only when the caller names the
// env var and it is present in this process. Absent means blank — never guessed.
const fpEnv = String(arg('fingerprint-env', '') || '').trim();
let fingerprint = existing ? existing.fingerprint || '' : '';
if (fpEnv) {
  const value = process.env[fpEnv];
  fingerprint = value ? providerKeys.fingerprintKey(value) : '';
  if (!fingerprint) console.log(`· ${fpEnv} is not set in this shell, so no fingerprint was recorded`);
}

const row = {
  id,
  label: String(arg('label', existing ? existing.label : id) || id).slice(0, 80),
  client: String(arg('client', existing ? existing.client : '') || '').slice(0, 80),
  provider: String(arg('provider', existing ? existing.provider : '') || '').slice(0, 60),
  envVar: String(arg('env-var', existing ? existing.envVar : '') || '').slice(0, 80),
  envOwner: String(arg('env-owner', existing ? existing.envOwner : 'dell') || 'dell').slice(0, 40),
  lanes,
  basis: String(arg('basis', existing ? existing.basis : 'lane-attributed') || 'lane-attributed').slice(0, 40),
  usageSource: String(arg('usage-source', existing ? existing.usageSource : '') || '').slice(0, 160),
  note: String(arg('note', existing ? existing.note : '') || '').slice(0, 300),
  fingerprint,
  createdAt: existing ? existing.createdAt : new Date().toISOString().slice(0, 10),
};

const keys = registry.keys.filter((k) => k.id !== id);
keys.push(row);
providerKeys.saveRegistry({ note: registry.note, keys });

// Names only — never the key, never the fingerprint in full.
console.log(`✔ ${existing ? 'updated' : 'added'} ${id}`);
console.log(`   label   ${row.label || '—'}`);
console.log(`   client  ${row.client || '—'}`);
console.log(`   env var ${row.envVar || '—'} (value never stored here)`);
console.log(`   lanes   ${row.lanes.length ? row.lanes.join(', ') : '— (recorded-lane basis)'}`);
console.log(`   fp      ${row.fingerprint ? row.fingerprint.slice(0, 6) + '…' : '—'}`);
console.log('   registry data/provider-keys.json — usage shows on the next CLI/admin poll');
