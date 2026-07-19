'use strict';

/**
 * Stuck-Loop Monitor — real-time alert system for agent loop stalls.
 *
 * Tracks all stuck/loop-break events in memory with timestamps, severity,
 * and context. Exposes data via:
 *   - getStuckAlerts()     → array of alert objects
 *   - logStuckAlert()      → push a new alert
 *   - clearStuckAlerts()   → reset (useful after agent recovers)
 *   - HTTP GET /api/agent/stuck-alerts (wired in index.js)
 *   - HTTP POST /api/agent/stuck-alerts/clear
 *
 * Alerts are also written to data/stuck-alerts.log (existing behavior).
 *
 * Severity levels:
 *   - 'info'    : minor (2-3 repeated prefixes, exploration-only)
 *   - 'warning' : moderate (5+ repeats, tool-error streak, idle stall)
 *   - 'critical': severe (loop break triggered, max retries hit)
 *
 * When severity is 'critical', the alert is flagged needsHelp=true
 * so the CLI / dashboard can surface "⚠️ Agent needs help" indicators.
 */

const fs = require('fs');
const path = require('path');

const MAX_ALERTS = 200; // Keep last 200 alerts in memory
const ALERT_LOG = path.join(__dirname, '..', '..', 'data', 'stuck-alerts.log');

let _alerts = [];
let _suppressedCount = 0; // Alerts suppressed by cooldown
let _lastCriticalTs = null;

/**
 * Log a stuck-loop alert.
 * @param {string} type       - Detection type (e.g. 'semantic_loop', 'tool_error_streak')
 * @param {string} reason     - Human-readable reason
 * @param {object} context    - Additional context { turn, noProgressCount, toolName, ... }
 * @param {string} severity   - 'info' | 'warning' | 'critical'
 */
function logStuckAlert(type, reason, context = {}, severity = 'warning') {
  const ts = new Date().toISOString();
  const alert = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts,
    type,
    reason,
    severity,
    needsHelp: severity === 'critical',
    context: {
      turn: context.turn || 0,
      noProgressCount: context.noProgressCount || 0,
      toolName: context.toolName || null,
      snippet: context.snippet || null,
      ...context,
    },
  };

  _alerts.push(alert);

  // Trim to MAX_ALERTS (ring buffer)
  if (_alerts.length > MAX_ALERTS) {
    _alerts = _alerts.slice(-MAX_ALERTS);
  }

  if (severity === 'critical') {
    _lastCriticalTs = ts;
  }

  // Also append to persistent log file
  try {
    fs.appendFileSync(ALERT_LOG, JSON.stringify(alert) + '\n');
  } catch (_e) {
    // Non-fatal — log file is best-effort
  }

  // Console signal (visible in PM2 logs)
  const icon = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
  console.error(`${icon} [stuckMonitor] ${type}: ${reason} (turn ${alert.context.turn})`);

  return alert;
}

/**
 * Get all alerts, optionally filtered by severity.
 */
function getStuckAlerts(filter = {}) {
  let result = _alerts;
  if (filter.severity) {
    result = result.filter(a => a.severity === filter.severity);
  }
  if (filter.needsHelp) {
    result = result.filter(a => a.needsHelp);
  }
  return {
    alerts: result,
    count: result.length,
    criticalCount: _alerts.filter(a => a.severity === 'critical').length,
    warningCount: _alerts.filter(a => a.severity === 'warning').length,
    infoCount: _alerts.filter(a => a.severity === 'info').length,
    suppressedCount: _suppressedCount,
    lastCriticalTs: _lastCriticalTs,
    needsHelp: _alerts.some(a => a.needsHelp && (Date.now() - new Date(a.ts).getTime()) < 120000),
  };
}

/**
 * Clear all alerts (after agent recovers or user acknowledges).
 */
function clearStuckAlerts() {
  const cleared = _alerts.length;
  _alerts = [];
  _suppressedCount = 0;
  _lastCriticalTs = null;
  return { cleared, ts: new Date().toISOString() };
}

/**
 * Increment suppressed count (called when alert is suppressed by cooldown).
 */
function incrementSuppressed() {
  _suppressedCount++;
}

/**
 * Check if agent currently needs help.
 * Returns true if there's a critical alert in the last 2 minutes.
 */
function needsHelp() {
  return _alerts.some(
    a => a.needsHelp && (Date.now() - new Date(a.ts).getTime()) < 120000
  );
}

/**
 * Get a summary suitable for CLI status bar / health endpoint.
 */
function getSummary() {
  const recent = _alerts.filter(
    a => Date.now() - new Date(a.ts).getTime() < 300000 // last 5 min
  );
  return {
    needsHelp: needsHelp(),
    recentCount: recent.length,
    criticalRecent: recent.filter(a => a.severity === 'critical').length,
    warningRecent: recent.filter(a => a.severity === 'warning').length,
    lastAlert: recent.length > 0 ? recent[recent.length - 1] : null,
  };
}

module.exports = {
  logStuckAlert,
  getStuckAlerts,
  clearStuckAlerts,
  incrementSuppressed,
  needsHelp,
  getSummary,
};