'use strict';
/**
 * Build pattern learning (owner, 2026-11-21: "pattern learning for faster
 * building times").
 *
 * Derived, never stored twice: every number here comes from the recorded build
 * rows in builds.jsonl. Nothing is invented — with no history the result is
 * null, and the applet says so instead of showing a made-up typical time.
 *
 * What it gives a build:
 *   - the median total duration of recent successful builds (a fair ETA base)
 *   - the slowest stage, so the next optimisation targets real time
 *   - whether the last few builds are faster or slower than the ones before
 */

const store = require('./store.cjs');

const WINDOW = 40;          // most recent successful builds considered
const CACHE_MS = 60000;

let cache = { at: 0, value: null };

function median(values) {
  const v = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

function buildPattern() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  let rows = [];
  try { ({ rows } = store.readAll()); } catch (_) { rows = []; }

  const done = rows
    // builds.jsonl is a shared store; only this project's builds describe this
    // applet's build times. Rows with no project tag are older local rows and
    // still count.
    .filter((r) => r && (r.project === 'haksterai' || !r.project))
    .filter((r) => r.outcome === 'success' && Number.isFinite(r.durationMs) && r.durationMs > 0)
    .slice(-WINDOW);

  if (!done.length) {
    cache = { at: Date.now(), value: null };
    return null;
  }

  const durations = done.map((r) => r.durationMs);
  const stageBuckets = {};
  for (const r of done) {
    for (const st of (r.stages || [])) {
      if (st && st.status === 'done' && Number.isFinite(st.ms) && st.ms > 0) {
        (stageBuckets[st.id] = stageBuckets[st.id] || []).push(st.ms);
      }
    }
  }
  const stages = Object.keys(stageBuckets)
    .map((id) => ({ id, medianMs: median(stageBuckets[id]), samples: stageBuckets[id].length }))
    .filter((s) => s.medianMs != null)
    .sort((a, b) => b.medianMs - a.medianMs);

  const recent = durations.slice(-5);
  const prior = durations.slice(-10, -5);
  const recentMedian = median(recent);
  const priorMedian = median(prior);
  const trend = recentMedian != null && priorMedian != null
    ? (recentMedian < priorMedian * 0.95 ? 'faster' : recentMedian > priorMedian * 1.05 ? 'slower' : 'steady')
    : null;

  const value = {
    sampledBuilds: done.length,
    medianTotalMs: median(durations),
    fastestMs: Math.min(...durations),
    slowestMs: Math.max(...durations),
    lastMs: durations[durations.length - 1] || null,
    slowestStage: stages[0] ? { id: stages[0].id, medianMs: stages[0].medianMs } : null,
    stages,
    trend,
    basis: `medians of the last ${done.length} successful recorded builds`,
    at: new Date().toISOString(),
  };
  cache = { at: Date.now(), value };
  return value;
}

module.exports = { buildPattern, WINDOW };
