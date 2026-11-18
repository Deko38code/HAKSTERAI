'use strict';
/**
 * Cross-project build feed — strictly limited, authenticated, read-only.
 *
 * HaksterAI owns these records. PhantomIDE may read a whitelisted projection
 * of them and nothing else. The projection is built by copying named fields
 * into a new object; there is no pass-through of the record, so a field added
 * to the store later cannot leak by accident.
 *
 * Explicitly NOT in the feed: log text, file paths, diffs, environment,
 * credentials, approval identities, deployment permissions, anything writable.
 *
 * Credentials: a dedicated token, generated once into its own 0600 file and
 * used for nothing else. It is never the app API key, never a browser key and
 * never accepted by any other route.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CRED_FILE = path.join(__dirname, '..', 'data', 'feed-credentials.json');

function ensureCredential() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch (_) {}
  const cred = {
    name: 'phantomide-build-feed',
    scope: 'builds:read',
    project: 'haksterai',
    token: crypto.randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
    note: 'Least-privilege read token for the PhantomIDE build-history feed. Not an application credential.',
  };
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2), { mode: 0o600 });
  try { fs.chmodSync(CRED_FILE, 0o600); } catch (_) {}
  return cred;
}

function authorized(req) {
  const cred = ensureCredential();
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const key = req.headers['x-build-feed-key'] || bearer || '';
  if (!key) return false;
  const a = Buffer.from(key);
  const b = Buffer.from(cred.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The whole record, reduced to the whitelisted projection. */
function sanitize(rec) {
  if (!rec) return null;
  const groups = (g) => (g ? Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length])) : null);
  return {
    key: rec.key,
    buildId: rec.buildId,
    project: rec.project,
    box: rec.box,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    durationMs: rec.durationMs,
    buildStatus: rec.buildStatus,
    outcome: rec.outcome,
    trigger: rec.trigger,
    approved: Boolean(rec.approved),
    deployment: { requested: Boolean(rec.deployment?.requested), outcome: rec.deployment?.outcome || 'unknown' },
    git: rec.git ? {
      available: rec.git.available,
      branch: rec.git.branch,
      shortCommit: rec.git.shortCommit,
      dirty: rec.git.dirty,
      committedCount: rec.git.committedCount,
      uncommittedCount: rec.git.uncommittedCount,
      // counts only — file paths are project internals and stay home
      committed: groups(rec.git.committed),
      uncommitted: groups(rec.git.uncommitted),
    } : { available: false },
    versions: rec.versions,
    dependencies: rec.dependencies ? {
      changed: Boolean(rec.dependencies.diff?.changed),
      added: rec.dependencies.diff?.added?.length ?? null,
      updated: rec.dependencies.diff?.updated?.length ?? null,
      removed: rec.dependencies.diff?.removed?.length ?? null,
    } : null,
    stages: (rec.stages || []).map((s) => ({ id: s.id, label: s.label, status: s.status, ms: s.ms })),
    progress: rec.progress,
    tests: rec.tests ? { ran: rec.tests.ran, result: rec.tests.result } : null,
    health: rec.health ? { checked: rec.health.checked, result: rec.health.result } : null,
    warnings: (rec.logs?.warnings || []).length,
    errors: (rec.logs?.errors || []).length,
    summary: rec.summary,
  };
}

function publicMeta() {
  const cred = ensureCredential();
  const st = fs.statSync(CRED_FILE);
  return { name: cred.name, scope: cred.scope, project: cred.project, createdAt: cred.createdAt, file: CRED_FILE, mode: (st.mode & 0o777).toString(8) };
}

module.exports = { authorized, sanitize, ensureCredential, publicMeta, CRED_FILE };
