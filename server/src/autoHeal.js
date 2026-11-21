'use strict';
/**
 * haksterAi — Automatic self-heal loop (2026-11-22, owner request).
 *
 * Owner: "let adds the auto heal to haksterai.com dashbaoad aswell same config
 * just to ours". This is the HaksterAI-owned copy of the Junkalot auto-heal:
 * the same 10-second cycle, the same 24-hour window, the same bounded caps and
 * the same append-only log, fed only by HaksterAI's own tables.
 *
 * Bounds (CLAUDE.md §11): the loop may only take REVERSIBLE, non-destructive
 * actions:
 *   • hard-block (24 h TTL) an address that is already being refused by the
 *     IP signup guard over and over — scripted abuse, not a household
 *   • record when one of its own blocks expired, so the panel is honest about
 *     what was released and when
 *   • acknowledge a security notification whose finding is verifiably gone
 *     from the latest audit (a status flag only; the row is preserved)
 * It never deletes rows, restarts a service, edits config, changes a tunnel,
 * rotates credentials, touches another project or installs anything. Every
 * action is written to auto_heal_log, which is append-only. HK_AUTO_HEAL=off
 * is a hard kill switch; the owner can also switch it off from the panel.
 *
 * No model calls: HaksterAI already has its own read-only Auto Agent. The
 * panel's recommendations are derived from real audit findings and counts.
 */

const { getDb } = require('./db');
const ipGuard = require('./ipSignupGuard');

// ─── Same configuration as Junkalot's loop ──────────────────────────────────
const AUTO_HEAL_INTERVAL_MS = 10_000;
const PATTERN_INTERVAL_MS = 5 * 60_000;
const WINDOW_HOURS = 24;

const MAX_BLOCKS_PER_CYCLE = 3;
const MAX_BLOCKS_PER_DAY = 10;
const MAX_UNBLOCKS_PER_DAY = 3; // logged release records per 24 h
const MAX_RESOLVES_PER_CYCLE = 8;
const QUIET_UNBLOCK_MS = 24 * 60 * 60_000;

// Junkalot blocks at 3 critical events. HaksterAI's guard already refuses
// every over-limit signup, so a real household produces one or two refusals;
// ten or more in a day from one address is scripted. The block is a 24-hour
// TTL that releases itself — never a permanent ban.
const AUTO_BLOCK_REFUSALS = 10;
const BLOCK_TTL_HOURS = 24;

const AUTO_HEAL_ORIGIN = 'auto-heal';

let running = false;
let timer = null;
let reportProvider = null; // set by index.js: () => latest cached audit report
let cachedView = null;

function isHardOff() {
  return String(process.env.HK_AUTO_HEAL || '').toLowerCase() === 'off';
}

function nowIso() {
  return new Date().toISOString();
}

function parseDbTime(value) {
  if (!value) return NaN;
  const text = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
  return Date.parse(text);
}

function clampScore(value) {
  return Math.min(100, Math.max(0, Math.round(Number(value) || 0)));
}

function severityFor(score) {
  return score >= 70 ? 'critical' : score >= 40 ? 'warning' : 'info';
}

// ─── Storage (append-only log; state is one row) ────────────────────────────
let ready = false;
function ensureTables() {
  const db = getDb();
  if (!ready) {
    db.exec(`CREATE TABLE IF NOT EXISTS auto_heal_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      score INTEGER,
      severity TEXT DEFAULT 'info',
      last_cycle_at TEXT,
      last_action TEXT,
      data TEXT,
      updated_at TEXT
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS auto_heal_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      score_before INTEGER,
      score_after INTEGER
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_auto_heal_log_created ON auto_heal_log(created_at DESC)');
    db.exec(`CREATE TABLE IF NOT EXISTS auto_heal_patterns (
      key TEXT PRIMARY KEY,
      label TEXT,
      kind TEXT,
      occurrences INTEGER,
      status TEXT,
      first_seen TEXT,
      last_seen TEXT
    )`);
    db.prepare('INSERT OR IGNORE INTO auto_heal_state (id, enabled, updated_at) VALUES (1, 1, ?)').run(nowIso());
    ready = true;
  }
  try { ipGuard.ensureTables(db); } catch (_) { /* guard tables are created by the guard itself */ }
  return db;
}

function getStateRow() {
  const db = ensureTables();
  return db.prepare('SELECT * FROM auto_heal_state WHERE id = 1').get();
}

function loadData(row) {
  const empty = { cycles: 0, patterns: [], improvements: [], recommendations: [], lastPatternAt: null };
  if (!row || !row.data) return empty;
  try {
    const parsed = JSON.parse(row.data);
    if (!parsed || typeof parsed !== 'object') return empty;
    return {
      cycles: Number.isFinite(parsed.cycles) ? Number(parsed.cycles) : 0,
      patterns: Array.isArray(parsed.patterns) ? parsed.patterns.filter(p => p && typeof p === 'object').slice(0, 12) : [],
      improvements: Array.isArray(parsed.improvements) ? parsed.improvements.filter(v => typeof v === 'string').slice(0, 6) : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.filter(v => typeof v === 'string').slice(0, 8) : [],
      lastPatternAt: typeof parsed.lastPatternAt === 'string' ? parsed.lastPatternAt : null,
    };
  } catch (_) {
    return empty;
  }
}

function saveState(fields) {
  const db = ensureTables();
  const row = db.prepare('SELECT * FROM auto_heal_state WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO auto_heal_state (id, enabled, updated_at) VALUES (1, 1, ?)').run(nowIso());
  }
  const sets = [];
  const values = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  sets.push('updated_at = ?');
  values.push(nowIso());
  db.prepare(`UPDATE auto_heal_state SET ${sets.join(', ')} WHERE id = 1`).run(...values);
}

function insertLog({ kind, action, target, detail, scoreBefore, scoreAfter }) {
  const db = ensureTables();
  db.prepare(`INSERT INTO auto_heal_log (created_at, kind, action, target, detail, score_before, score_after)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(nowIso(), String(kind || 'cycle'), String(action || ''), String(target || ''), String(detail || '').slice(0, 400),
      Number.isFinite(scoreBefore) ? scoreBefore : null, Number.isFinite(scoreAfter) ? scoreAfter : null);
}

function countActions(action, hours) {
  const db = ensureTables();
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  try {
    return db.prepare('SELECT COUNT(*) AS c FROM auto_heal_log WHERE action = ? AND created_at >= ?').get(action, since).c || 0;
  } catch (_) {
    return 0;
  }
}

function countTotals() {
  const db = ensureTables();
  const totals = { blocks: 0, unblocks: 0, resolves: 0 };
  try {
    for (const action of ['block_ip', 'unblock_ip', 'resolve_report']) {
      totals[{ block_ip: 'blocks', unblock_ip: 'unblocks', resolve_report: 'resolves' }[action]] =
        db.prepare('SELECT COUNT(*) AS c FROM auto_heal_log WHERE action = ?').get(action).c || 0;
    }
  } catch (_) { /* log table missing on a brand-new DB */ }
  return totals;
}

function getLog(limit = 10) {
  const db = ensureTables();
  try {
    return db.prepare('SELECT created_at, kind, action, target, detail FROM auto_heal_log ORDER BY id DESC LIMIT ?').all(limit);
  } catch (_) {
    return [];
  }
}

// ─── Exposure measurement ───────────────────────────────────────────────────
// Everything here is read from HaksterAI's own tables. A blocked or allowed
// address drops out of the "still reachable" set, so the score improves in the
// same cycle a fix lands.
function readOpenNotifications(db) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  try {
    const rows = db.prepare('SELECT severity, COUNT(*) AS c FROM security_notifications WHERE acknowledged = 0 GROUP BY severity').all();
    for (const row of rows) {
      const sev = String(row.severity || '').toLowerCase();
      if (sev in counts) counts[sev] = Number(row.c) || 0;
      else counts.info += Number(row.c) || 0;
    }
  } catch (_) { /* table is created by the security scanner */ }
  return counts;
}

function readGuardActions(db) {
  // Only the newest non-expired action per IP is in force (same rule the guard
  // uses). An `allow` supersedes an older block.
  const effective = new Map();
  try {
    const now = Math.floor(Date.now() / 1000);
    const rows = db.prepare(`SELECT id, ip, action, reason, created_by, created_at, expires_at
                               FROM ip_guard_actions
                              WHERE expires_at IS NULL OR expires_at > ?
                              ORDER BY id DESC`).all(now);
    for (const row of rows) {
      if (!effective.has(row.ip)) effective.set(row.ip, row);
    }
  } catch (_) { /* guard table missing */ }
  return effective;
}

function computeExposure(db) {
  const notif = readOpenNotifications(db);
  const effective = readGuardActions(db);
  const blocked = new Set();
  const allowed = new Set();
  for (const [ip, row] of effective) {
    if (row.action === 'block') blocked.add(ip);
    else if (row.action === 'allow') allowed.add(ip);
  }

  const since = Math.floor(Date.now() / 1000) - WINDOW_HOURS * 3600;
  const events = [];
  try {
    events.push(...db.prepare(`SELECT ip, action, code, COUNT(*) AS count
                                 FROM ip_guard_events
                                WHERE created_at > ? AND action = 'blocked' AND code <> 'owner-block'
                                GROUP BY ip, action, code`).all(since));
  } catch (_) { /* guard table missing */ }

  const refusedByIp = new Map();
  let refused24h = 0;
  for (const row of events) {
    const ip = ipGuard.normalizeIp(row.ip);
    if (!ip || ipGuard.isPrivateIp(ip)) continue;
    const count = Number(row.count) || 0;
    refused24h += count;
    refusedByIp.set(ip, { ip, count, code: row.code });
  }

  const offenders = [];
  for (const entry of refusedByIp.values()) {
    if (blocked.has(entry.ip) || allowed.has(entry.ip)) continue;
    if (entry.count >= AUTO_BLOCK_REFUSALS) offenders.push(entry);
  }
  offenders.sort((a, b) => b.count - a.count);

  const openCritical = notif.critical;
  const activeCritical = openCritical * 3 + notif.high;
  const activeWarning = notif.medium + refused24h;

  const score = clampScore(
    Math.min(55, activeCritical * 4) +
    Math.min(20, offenders.length * 6) +
    Math.min(15, Math.round(activeWarning * 0.4)) +
    Math.min(20, openCritical * 5),
  );

  return {
    score,
    notif,
    openCritical,
    openHigh: notif.high,
    activeCritical,
    activeWarning,
    refused24h,
    offenders,
    blocked,
    allowed,
  };
}

// ─── Patterns (learned every five minutes) ─────────────────────────────────
function learnPatterns(db, before, force = false) {
  const row = getStateRow();
  const data = loadData(row);
  const last = parseDbTime(data.lastPatternAt);
  if (!force && Number.isFinite(last) && Date.now() - last < PATTERN_INTERVAL_MS) return data.patterns;

  const since = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  let rows = [];
  try {
    rows = db.prepare(`SELECT ip, action, code, COUNT(*) AS count
                         FROM ip_guard_events WHERE created_at > ?
                        GROUP BY ip, action, code`).all(since);
  } catch (_) { /* no events yet */ }

  const perIp = new Map();
  const perType = new Map();
  for (const row of rows) {
    const count = Number(row.count) || 0;
    const ip = ipGuard.normalizeIp(row.ip);
    perIp.set(ip, (perIp.get(ip) || 0) + count);
    const type = `${row.action}${row.code ? ':' + row.code : ''}`;
    perType.set(type, (perType.get(type) || 0) + count);
  }

  const found = [];
  for (const [ip, occurrences] of [...perIp.entries()].sort((a, b) => b[1] - a[1])) {
    if (!ip || occurrences < 10) continue;
    const status = before.blocked.has(ip) ? 'blocked' : ipGuard.isPrivateIp(ip) ? 'local' : 'monitoring';
    const label = status === 'local'
      ? `Local/loopback traffic from ${ip}`
      : `Repeated traffic from ${ip}`;
    upsertPattern(db, { key: `ip:${ip}`, label, kind: 'ip', occurrences, status });
    found.push({ key: `ip:${ip}`, label, kind: 'ip', occurrences, status, lastSeen: nowIso() });
    if (found.length >= 8) break;
  }
  for (const [type, occurrences] of [...perType.entries()].sort((a, b) => b[1] - a[1])) {
    if (occurrences < 15) continue;
    const label = `${type} events (${occurrences} in 7 days)`;
    upsertPattern(db, { key: `type:${type}`, label, kind: 'event_type', occurrences, status: 'monitoring' });
    found.push({ key: `type:${type}`, label, kind: 'event_type', occurrences, status: 'monitoring', lastSeen: nowIso() });
    if (found.length >= 12) break;
  }
  return found.length ? found : data.patterns;
}

function upsertPattern(db, { key, label, kind, occurrences, status }) {
  try {
    const existing = db.prepare('SELECT key FROM auto_heal_patterns WHERE key = ?').get(key);
    if (existing) {
      db.prepare('UPDATE auto_heal_patterns SET label = ?, occurrences = ?, status = ?, last_seen = ? WHERE key = ?')
        .run(label, occurrences, status, nowIso(), key);
    } else {
      db.prepare('INSERT INTO auto_heal_patterns (key, label, kind, occurrences, status, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(key, label, kind, occurrences, status, nowIso(), nowIso());
    }
  } catch (_) { /* pattern learning is advisory */ }
}

// ─── Improvements and recommendations (real numbers only) ──────────────────
function buildImprovements({ score, after, blocksToday, unblocksToday, resolvesToday, patterns }) {
  const lines = [];
  if (score === 0) lines.push('No open exposure in the last 24 hours — nothing to fix right now.');
  else if (score < 40) lines.push(`Open exposure is low (${score}/100). The loop is watching; no action was needed this cycle.`);
  else lines.push(`Open exposure is ${score}/100 from ${after.activeCritical} critical and ${after.activeWarning} warning signals that are still reachable.`);

  if (blocksToday > 0) lines.push(`${blocksToday} address${blocksToday === 1 ? '' : 'es'} blocked automatically in the last 24 hours — review them under IP Signup Guard in case a real customer was caught.`);
  if (blocksToday >= MAX_BLOCKS_PER_DAY) lines.push(`The daily auto-block cap (${MAX_BLOCKS_PER_DAY}) is reached. Investigate the source before raising it.`);
  if (unblocksToday > 0) lines.push(`${unblocksToday} auto-block${unblocksToday === 1 ? ' expired' : 's expired'} after the 24-hour TTL and ${unblocksToday === 1 ? 'was' : 'were'} released.`);
  if (resolvesToday > 0) lines.push(`${resolvesToday} security notification${resolvesToday === 1 ? '' : 's'} acknowledged automatically after the finding cleared.`);
  if (after.offenders.length > 0) lines.push(`${after.offenders.length} address${after.offenders.length === 1 ? ' is' : 'es are'} over the refusal threshold and will be blocked within the caps.`);
  if (patterns.length > 0) lines.push(`Learned pattern: ${patterns[0].label} (${patterns[0].occurrences} events in 7 days).`);
  return lines.slice(0, 6);
}

function buildRecommendations(db, after) {
  const lines = [];
  try {
    const open = db.prepare(`SELECT severity, title FROM security_notifications WHERE acknowledged = 0
                              ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
                              LIMIT 3`).all();
    for (const row of open) {
      lines.push(`Review ${row.severity} finding: ${row.title}`);
    }
  } catch (_) { /* scanner table missing */ }
  if (after.offenders.length > 0) {
    lines.push(`${after.offenders.length} IP${after.offenders.length === 1 ? '' : 's'} over ${AUTO_BLOCK_REFUSALS} refusals in 24h — auto-blocked up to the daily cap.`);
  }
  if (lines.length === 0) lines.push('No open findings need attention.');
  return lines.slice(0, 8);
}

// ─── View for the dashboard ────────────────────────────────────────────────
function buildView() {
  const row = getStateRow();
  const data = loadData(row);
  const hardOff = isHardOff();
  const view = {
    enabled: !hardOff && row.enabled !== 0,
    hardOff,
    score: typeof row.score === 'number' ? row.score : null,
    severity: row.severity === 'critical' || row.severity === 'warning' ? row.severity : 'info',
    summary: data.improvements[0] || '',
    lastCycleAt: row.last_cycle_at || null,
    lastAiAt: null,
    lastAction: row.last_action || '',
    cycles: data.cycles,
    actionsToday: {
      blocks: countActions('block_ip', 24),
      unblocks: countActions('unblock_ip', 24),
      resolves: countActions('resolve_report', 24),
    },
    totals: countTotals(),
    patterns: data.patterns,
    improvements: data.improvements,
    recommendations: data.recommendations,
    patches: [],
    aiSource: '',
    intervalMs: AUTO_HEAL_INTERVAL_MS,
    aiIntervalMs: null,
    nextAiInMs: null,
    log: getLog(10).map(entry => ({
      at: entry.created_at,
      kind: entry.kind,
      action: entry.action,
      target: entry.target,
      detail: entry.detail,
    })),
  };
  cachedView = view;
  return view;
}

function getAutoHealView() {
  try {
    return buildView();
  } catch (_) {
    return cachedView || {
      enabled: false, hardOff: isHardOff(), score: null, severity: 'info', summary: '',
      lastCycleAt: null, lastAiAt: null, lastAction: '', cycles: 0,
      actionsToday: { blocks: 0, unblocks: 0, resolves: 0 },
      totals: { blocks: 0, unblocks: 0, resolves: 0 },
      patterns: [], improvements: [], recommendations: [], patches: [], aiSource: '',
      intervalMs: AUTO_HEAL_INTERVAL_MS, aiIntervalMs: null, nextAiInMs: null, log: [],
    };
  }
}

function setEnabled(enabled) {
  saveState({ enabled: enabled ? 1 : 0 });
  insertLog({
    kind: 'control',
    action: enabled ? 'enable' : 'disable',
    target: 'owner',
    detail: enabled ? 'Owner switched automatic healing on' : 'Owner switched automatic healing off',
  });
  return getAutoHealView();
}

function setReportProvider(provider) {
  reportProvider = typeof provider === 'function' ? provider : null;
}

// ─── The cycle ─────────────────────────────────────────────────────────────
function runAutoHealCycle(reason = 'timer') {
  if (running) return getAutoHealView();
  running = true;
  try {
    const db = ensureTables();
    const row = getStateRow();
    const hardOff = isHardOff();
    const enabled = !hardOff && row.enabled !== 0;

    const before = computeExposure(db);
    const actions = [];

    if (enabled) {
      // 1. Hard-block scripted abusers (24 h TTL, capped per cycle and per day).
      const blocksToday = countActions('block_ip', 24);
      const budget = Math.max(0, Math.min(MAX_BLOCKS_PER_CYCLE, MAX_BLOCKS_PER_DAY - blocksToday));
      for (const entry of before.offenders.slice(0, budget)) {
        const why = `${entry.count} signup/login refusals in 24h`;
        const reasonText = `Auto-heal: ${why}`;
        try {
          ipGuard.setAction(db, {
            ip: entry.ip,
            action: 'block',
            reason: reasonText,
            hours: BLOCK_TTL_HOURS,
            by: AUTO_HEAL_ORIGIN,
          });
          before.blocked.add(entry.ip);
          actions.push({ action: 'block_ip', target: entry.ip, detail: reasonText });
        } catch (_) { /* guard write failed; next cycle retries */ }
      }

      // 2. Record its own blocks that reached the end of their TTL. The block
      //    released itself (expires_at), so this is accounting, not an action —
      //    nothing is deleted and no row is rewritten.
      const unblocksToday = countActions('unblock_ip', 24);
      if (unblocksToday < MAX_UNBLOCKS_PER_DAY) {
        const nowSec = Math.floor(Date.now() / 1000);
        let logged = 0;
        try {
          const expired = db.prepare(`SELECT id, ip, created_at, expires_at FROM ip_guard_actions
                                       WHERE created_by = ? AND expires_at IS NOT NULL AND expires_at <= ?
                                       ORDER BY id DESC LIMIT 20`).all(AUTO_HEAL_ORIGIN, nowSec);
          for (const block of expired) {
            if (unblocksToday + logged >= MAX_UNBLOCKS_PER_DAY) break;
            const already = db.prepare("SELECT id FROM auto_heal_log WHERE action = 'unblock_ip' AND detail LIKE ? LIMIT 1")
              .get(`%block #${block.id}%`);
            if (already) continue;
            actions.push({
              action: 'unblock_ip',
              target: block.ip,
              detail: `block #${block.id} expired after ${BLOCK_TTL_HOURS}h — released`,
            });
            logged += 1;
          }
        } catch (_) { /* guard table missing */ }
      }

      // 3. Acknowledge a notification only when the latest audit verifies the
      //    finding is gone. The row is kept; only the status flag changes.
      const report = reportProvider ? reportProvider() : null;
      if (report && Array.isArray(report.findings)) {
        const currentKeys = new Set(report.findings.map(f => `${f.category}:${f.title}`));
        let resolved = 0;
        try {
          // CLI provenance / volume rows are raised by this box's own guard and
          // never appear in the audit report, so the audit-comparison rule must
          // not auto-acknowledge them. They clear only when the owner does.
          const openRows = db.prepare(`SELECT id, key, title, first_seen FROM security_notifications
                                        WHERE acknowledged = 0
                                          AND category NOT IN ('cli-provenance', 'cli-volume')
                                        ORDER BY last_seen DESC LIMIT 50`).all();
          for (const notif of openRows) {
            if (resolved >= MAX_RESOLVES_PER_CYCLE) break;
            if (currentKeys.has(notif.key)) continue;
            const first = parseDbTime(notif.first_seen);
            if (Number.isFinite(first) && Date.now() - first < 10 * 60_000) continue;
            db.prepare('UPDATE security_notifications SET acknowledged = 1, notified = 0 WHERE id = ?').run(notif.id);
            actions.push({
              action: 'resolve_report',
              target: notif.title || notif.key,
              detail: 'The latest audit no longer reports this finding',
            });
            resolved += 1;
          }
        } catch (_) { /* scanner table missing */ }
      }
    }

    const after = computeExposure(db);
    const score = after.score;
    const severity = severityFor(score);

    for (const action of actions) {
      insertLog({
        kind: 'fix',
        action: action.action,
        target: action.target,
        detail: action.detail,
        scoreBefore: before.score,
        scoreAfter: score,
      });
    }

    const patterns = learnPatterns(db, after, reason === 'manual');
    const blocksToday = countActions('block_ip', 24);
    const unblocks = countActions('unblock_ip', 24);
    const resolvesToday = countActions('resolve_report', 24);
    const improvements = buildImprovements({ score, after, blocksToday, unblocksToday: unblocks, resolvesToday, patterns });
    const recommendations = buildRecommendations(db, after);

    const lastAction = actions.length > 0
      ? `${actions[0].action.replace('_', ' ')} ${actions[0].target}`
      : row.last_action || (enabled ? 'Watching — no action needed' : 'Automatic healing is off');

    const latest = loadData(getStateRow());
    saveState({
      score,
      severity,
      last_cycle_at: nowIso(),
      last_action: lastAction,
      data: JSON.stringify({
        ...latest,
        cycles: latest.cycles + 1,
        improvements,
        recommendations,
        patterns,
        lastPatternAt: nowIso(),
      }),
    });

    return getAutoHealView();
  } catch (err) {
    console.warn('[auto-heal] cycle failed:', err && err.message ? err.message : err);
    return getAutoHealView();
  } finally {
    running = false;
  }
}

function startAutoHealScheduler() {
  if (timer) return;
  if (isHardOff()) {
    console.log('[auto-heal] disabled by HK_AUTO_HEAL=off');
    return;
  }
  // Keep the timer ref'd: this is a long-lived server, and an unref'd timer
  // was observed to stop firing ~90 s after boot on this box (2026-11-22).
  // Holding the handle keeps the cycle alive; a heartbeat every minute makes
  // any future stall visible in the log instead of silent.
  let tick = 0;
  timer = setInterval(() => {
    tick += 1;
    try { runAutoHealCycle('timer'); } catch (err) {
      console.warn('[auto-heal] timer tick failed:', err && err.message ? err.message : err);
    }
    if (tick % 6 === 0) {
      const view = getAutoHealView();
      console.log(`[auto-heal] alive — cycle ${view.cycles}, score ${view.score}, last ${view.lastCycleAt}`);
    }
  }, AUTO_HEAL_INTERVAL_MS);
  runAutoHealCycle('startup');
  console.log(`[auto-heal] checking every ${AUTO_HEAL_INTERVAL_MS / 1000}s; bounded, append-only log`);
}

module.exports = {
  AUTO_HEAL_INTERVAL_MS,
  WINDOW_HOURS,
  runAutoHealCycle,
  getAutoHealView,
  setEnabled,
  setReportProvider,
  startAutoHealScheduler,
  isHardOff,
};
