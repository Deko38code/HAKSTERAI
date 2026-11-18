'use strict';
/**
 * Append-only release journal.
 *
 * Every stage of every build writes one JSON line with a real timestamp. The
 * journal is the only source of truth for progress: the percentage shown to a
 * client is computed from completed stages, and the ETA from the measured
 * medians of previous releases of the same project. Nothing is estimated when
 * there is no evidence — a first build reports an indeterminate state.
 *
 * Nothing here deletes or rewrites: the file only ever grows.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const JOURNAL = path.join(DATA_DIR, 'releases.jsonl');

// Weights are deliberately coarse: they are stage shares of the whole job, not
// guesses about how long each one takes.
const STAGES = [
  { id: 'preflight', label: 'Checking disk and resources', weight: 5 },
  { id: 'prepare', label: 'Preparing isolated release tree', weight: 10 },
  { id: 'build', label: 'Building the site', weight: 60 },
  { id: 'verify', label: 'Verifying the candidate artifact', weight: 20 },
  { id: 'done', label: 'Release ready', weight: 5 },
];

function append(event) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  } catch (_) { /* the journal must never break a build */ }
}

function read(limit = 5000) {
  let text = '';
  try { text = fs.readFileSync(JOURNAL, 'utf8'); } catch (_) { return []; }
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines.slice(-limit)) {
    try { out.push(JSON.parse(line)); } catch (_) { /* skip a torn line */ }
  }
  return out;
}

/** Median duration of each stage across finished releases of one project. */
function stageMedians(project) {
  const rows = read().filter((e) => e.project === project);
  const byRelease = new Map();
  for (const e of rows) {
    if (!e.release || !e.stage) continue;
    let r = byRelease.get(e.release);
    if (!r) { r = {}; byRelease.set(e.release, r); }
    if (e.type === 'stage.start') r[e.stage] = r[e.stage] || { start: Date.parse(e.at) };
    if (e.type === 'stage.end' && r[e.stage] && !r[e.stage].end) r[e.stage].end = Date.parse(e.at);
  }
  const out = {};
  for (const stage of STAGES) {
    const durations = [];
    for (const r of byRelease.values()) {
      const s = r[stage.id];
      if (s && s.start && s.end) durations.push(s.end - s.start);
    }
    if (durations.length) {
      durations.sort((a, b) => a - b);
      out[stage.id] = durations[Math.floor(durations.length / 2)];
    }
  }
  return out;
}

/**
 * Progress for a release. `completed` is the list of finished stage ids.
 * Returns percent only when the stage list can be measured; with no measured
 * medians the ETA is null and the caller must show an indeterminate state.
 */
function progress(project, completed, currentStage) {
  const total = STAGES.reduce((n, s) => n + s.weight, 0);
  const done = STAGES.filter((s) => completed.includes(s.id)).reduce((n, s) => n + s.weight, 0);
  const medians = stageMedians(project);
  const remaining = STAGES.filter((s) => !completed.includes(s.id));
  const known = remaining.every((s) => medians[s.id] != null);
  const etaSec = known ? Math.round(remaining.reduce((n, s) => n + medians[s.id], 0) / 1000) : null;
  return {
    percent: Math.round((done / total) * 100),
    completedStages: completed.slice(),
    currentStage: currentStage || null,
    etaSec,
    etaBasis: known ? 'measured medians of previous releases' : 'none yet — indeterminate',
  };
}

module.exports = { JOURNAL, STAGES, append, read, stageMedians, progress };
