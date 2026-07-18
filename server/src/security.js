'use strict';
/**
 * haksterAi — Security & Health Checks
 * Scans the running haksterAi instance for vulnerabilities, misconfigurations,
 * exposed secrets, open ports, weak file permissions, and dependency issues.
 * Returns a structured report with severity levels.
 * Persists findings to DB and fires notifications when risks persist across scans.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { getDb } = require('./db');
const { v4: uuidv4 } = require('uuid');

const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' };
const PERSIST_THRESHOLD = 2; // Risk must appear in N consecutive scans before notifying
const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let _scanTimer = null;
let _notifCallback = null; // set by index.js to push into WS/notif queue

function execAsync(cmd, opts = {}) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 8000, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function checkExposedSecrets(serverDir) {
  const findings = [];
  const envPath = path.join(serverDir, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const secretPattern = /(?:API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY|CREDENTIAL)\s*=\s*["']?([^\s"']{8,})/gi;
    let match;
    while ((match = secretPattern.exec(content)) !== null) {
      findings.push({
        severity: SEVERITY.HIGH,
        category: 'secrets',
        title: 'Secret in .env file',
        detail: `Potential secret detected in ${path.basename(envPath)} (key name hidden). Ensure .env is gitignored and not world-readable.`,
      });
    }
    const stat = fs.statSync(envPath);
    const mode = (stat.mode & 0o777).toString(8);
    if (mode !== '600' && mode !== '640') {
      findings.push({
        severity: SEVERITY.MEDIUM,
        category: 'permissions',
        title: 'Loose .env permissions',
        detail: `.env file is mode ${mode} — should be 600 (owner-only). Run: chmod 600 ${envPath}`,
      });
    }
  }
  // Check if .env is gitignored
  const gitignorePath = path.join(serverDir, '..', '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gi = fs.readFileSync(gitignorePath, 'utf8');
    if (!/\.env/i.test(gi)) {
      findings.push({
        severity: SEVERITY.CRITICAL,
        category: 'secrets',
        title: '.env not in .gitignore',
        detail: 'The .env file is not listed in .gitignore — secrets could be committed to git.',
      });
    }
  }
  return findings;
}

async function checkOpenPorts() {
  const findings = [];
  const { stdout } = await execAsync('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null');
  const lines = stdout.trim().split('\n').filter(l => l.includes('LISTEN') || l.includes('0.0.0.0') || l.includes(':::'));
  const boundPorts = new Set();
  for (const line of lines) {
    const match = line.match(/[\d.]+:(\d+)\b/);
    if (match) boundPorts.add(match[1]);
    if (/\b0\.0\.0\.0\b|\b::\b|\b\*\b/.test(line)) {
      const pm = line.match(/[:*](\d+)\s/);
      if (pm) {
        findings.push({
          severity: SEVERITY.MEDIUM,
          category: 'network',
          title: `Port ${pm[1]} bound on all interfaces`,
          detail: `A service is listening on 0.0.0.0:${pm[1]} — accessible from network. Use 127.0.0.1 binding if only local access is needed.`,
        });
      }
    }
  }
  return findings;
}

async function checkDependencies(serverDir) {
  const findings = [];
  const { stdout, err } = await execAsync('npm audit --json 2>/dev/null', { cwd: serverDir, timeout: 15000 });
  if (!err && stdout) {
    try {
      const audit = JSON.parse(stdout);
      const vulns = audit.metadata && audit.metadata.vulnerabilities;
      if (vulns) {
        const total = (vulns.critical || 0) + (vulns.high || 0) + (vulns.moderate || 0);
        if (vulns.critical > 0) {
          findings.push({ severity: SEVERITY.CRITICAL, category: 'dependencies', title: `${vulns.critical} critical npm vulnerabilities`, detail: 'Run `npm audit fix` or review with `npm audit` for details.' });
        }
        if (vulns.high > 0) {
          findings.push({ severity: SEVERITY.HIGH, category: 'dependencies', title: `${vulns.high} high-severity npm vulnerabilities`, detail: 'Run `npm audit fix` to address.' });
        }
        if (vulns.moderate > 0) {
          findings.push({ severity: SEVERITY.MEDIUM, category: 'dependencies', title: `${vulns.moderate} moderate npm vulnerabilities`, detail: 'Run `npm audit` for details.' });
        }
      }
    } catch {}
  }
  return findings;
}

async function checkDangerousAllowlist() {
  const findings = [];
  try {
    const db = getDb();
    const rows = db.prepare('SELECT command FROM command_allowlist').all();
    const dangerous = [];
    for (const row of rows) {
      if (/\brm\s+-rf\b|\bmkfs\b|\bdd\s+if=|\bshutdown\b|\breboot\b|\bformat\b/i.test(row.command)) {
        dangerous.push(row.command);
      }
    }
    if (dangerous.length > 0) {
      findings.push({
        severity: SEVERITY.CRITICAL,
        category: 'allowlist',
        title: `${dangerous.length} dangerous commands permanently allowed`,
        detail: `Commands like "rm -rf", "mkfs", "dd" are on the permanent allowlist: ${dangerous.slice(0, 3).join(', ')}${dangerous.length > 3 ? '...' : ''}. Remove via DELETE /api/agent/allowlist/:id.`,
      });
    }
  } catch {}
  return findings;
}

async function checkDbIntegrity() {
  const findings = [];
  try {
    const db = getDb();
    const integrity = db.prepare('PRAGMA integrity_check').get();
    if (integrity && integrity.integrity_check !== 'ok') {
      findings.push({
        severity: SEVERITY.HIGH,
        category: 'database',
        title: 'SQLite integrity check failed',
        detail: `Result: ${integrity.integrity_check}. The database may be corrupted.`,
      });
    }
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    if (fkViolations.length > 0) {
      findings.push({
        severity: SEVERITY.MEDIUM,
        category: 'database',
        title: `${fkViolations.length} foreign key violations`,
        detail: 'Database has orphaned foreign key references. Consider cleaning up.',
      });
    }
  } catch (e) {
    findings.push({ severity: SEVERITY.HIGH, category: 'database', title: 'DB check error', detail: e.message });
  }
  return findings;
}

async function checkFilePermissions(serverDir) {
  const findings = [];
  const dbPath = path.join(serverDir, 'data');
  if (fs.existsSync(dbPath)) {
    try {
      const stat = fs.statSync(dbPath);
      const mode = (stat.mode & 0o777).toString(8);
      if (stat.isDirectory() && mode !== '700' && mode !== '750') {
        findings.push({ severity: SEVERITY.LOW, category: 'permissions', title: `Data dir is mode ${mode}`, detail: `Consider: chmod 700 ${dbPath}` });
      }
    } catch {}
  }
  return findings;
}

async function checkCorsConfig(corsOrigins) {
  const findings = [];
  if (corsOrigins.includes('*')) {
    findings.push({
      severity: SEVERITY.HIGH,
      category: 'cors',
      title: 'CORS allows all origins',
      detail: 'CORS_ORIGINS is set to "*" — any website can call the API. Restrict to known origins.',
    });
  }
  return findings;
}

async function checkProcessSecurity() {
  const findings = [];
  const { stdout } = await execAsync('id -u 2>/dev/null');
  const uid = stdout.trim();
  if (uid === '0') {
    findings.push({
      severity: SEVERITY.HIGH,
      category: 'process',
      title: 'Server running as root',
      detail: 'The haksterAi server process is running as UID 0 (root). Consider running as a non-privileged user.',
    });
  }
  return findings;
}

async function checkSshKeys() {
  const findings = [];
  const sshDir = path.join(os.homedir(), '.ssh');
  if (fs.existsSync(sshDir)) {
    try {
      const stat = fs.statSync(sshDir);
      const mode = (stat.mode & 0o777).toString(8);
      if (mode !== '700') {
        findings.push({ severity: SEVERITY.MEDIUM, category: 'permissions', title: `.ssh dir is mode ${mode}`, detail: `Should be 700. Run: chmod 700 ${sshDir}` });
      }
    } catch {}
    const keys = fs.readdirSync(sshDir).filter(f => f.startsWith('id_') && !f.endsWith('.pub'));
    for (const key of keys) {
      const kp = path.join(sshDir, key);
      const stat = fs.statSync(kp);
      const mode = (stat.mode & 0o777).toString(8);
      if (mode !== '600') {
        findings.push({ severity: SEVERITY.HIGH, category: 'permissions', title: `SSH key ${key} is mode ${mode}`, detail: `Private keys must be 600. Run: chmod 600 ${kp}` });
      }
    }
  }
  return findings;
}

async function runSecurityAudit(serverDir, corsOrigins) {
  const start = Date.now();
  const checks = await Promise.all([
    checkExposedSecrets(serverDir),
    checkOpenPorts(),
    checkDependencies(serverDir),
    checkDangerousAllowlist(),
    checkDbIntegrity(),
    checkFilePermissions(serverDir),
    checkCorsConfig(corsOrigins),
    checkProcessSecurity(),
    checkSshKeys(),
  ]);
  const findings = checks.flat();
  const summary = {
    critical: findings.filter(f => f.severity === SEVERITY.CRITICAL).length,
    high: findings.filter(f => f.severity === SEVERITY.HIGH).length,
    medium: findings.filter(f => f.severity === SEVERITY.MEDIUM).length,
    low: findings.filter(f => f.severity === SEVERITY.LOW).length,
    info: findings.filter(f => f.severity === SEVERITY.INFO).length,
  };
  summary.total = findings.length;
  summary.passed = summary.critical === 0 && summary.high === 0;
  return {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - start,
    summary,
    findings: findings.sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      return (order[a.severity] || 5) - (order[b.severity] || 5);
    }),
  };
}

// ── Persistent notification tracking ──────────────────────────────
function findingKey(f) {
  return `${f.category}:${f.title}`;
}

function initSecurityDb() {
  const db = getDb();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS security_notifications (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      severity TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      scan_count INTEGER DEFAULT 1,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      notified INTEGER DEFAULT 0,
      acknowledged INTEGER DEFAULT 0
    )
  `).run();
}

function persistFindings(findings) {
  initSecurityDb();
  const db = getDb();
  const now = new Date().toISOString();
  const currentKeys = new Set(findings.map(findingKey));
  const newAlerts = [];
  const persistentAlerts = [];

  // Upsert each finding
  for (const f of findings) {
    const key = findingKey(f);
    const existing = db.prepare('SELECT * FROM security_notifications WHERE key = ?').get(key);
    if (existing) {
      // Already tracked — increment scan_count, update last_seen
      db.prepare(`
        UPDATE security_notifications
        SET last_seen = ?, scan_count = scan_count + 1, detail = ?
        WHERE key = ?
      `).run(now, f.detail || '', key);

      // If it has persisted across enough scans and hasn't been notified yet, flag it
      const updated = db.prepare('SELECT * FROM security_notifications WHERE key = ?').get(key);
      if (updated.scan_count >= PERSIST_THRESHOLD && !updated.notified && !updated.acknowledged) {
        persistentAlerts.push(updated);
        db.prepare('UPDATE security_notifications SET notified = 1 WHERE key = ?').run(key);
      }
    } else {
      // New finding
      const id = uuidv4();
      db.prepare(`
        INSERT INTO security_notifications (id, key, severity, category, title, detail, scan_count, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(id, key, f.severity, f.category, f.title, f.detail || '', now, now);
      newAlerts.push({ id, ...f, key });
    }
  }

  // Resolve findings that are no longer present (mark acknowledged=auto-resolved)
  const allRows = db.prepare('SELECT key, id, title FROM security_notifications WHERE acknowledged = 0').all();
  const resolved = [];
  for (const row of allRows) {
    if (!currentKeys.has(row.key)) {
      db.prepare('UPDATE security_notifications SET acknowledged = 1, notified = 0 WHERE key = ?').run(row.key);
      resolved.push(row);
    }
  }

  return { newAlerts, persistentAlerts, resolved };
}

function sendSecurityNotifications(persistentAlerts) {
  if (!persistentAlerts.length || typeof _notifCallback !== 'function') return;
  const critical = persistentAlerts.filter(a => a.severity === 'critical');
  const high = persistentAlerts.filter(a => a.severity === 'high');
  const medium = persistentAlerts.filter(a => a.severity === 'medium');

  if (critical.length) {
    _notifCallback({
      message: `🚨 ${critical.length} CRITICAL security risk${critical.length > 1 ? 's' : ''} persisting: ${critical.map(a => a.title).join('; ')}`,
      type: 'security',
      priority: 'critical',
      source: 'security-audit',
    });
  }
  if (high.length) {
    _notifCallback({
      message: `⚠️ ${high.length} HIGH security risk${high.length > 1 ? 's' : ''} persisting: ${high.map(a => a.title).join('; ')}`,
      type: 'security',
      priority: 'high',
      source: 'security-audit',
    });
  }
  if (medium.length) {
    _notifCallback({
      message: `📋 ${medium.length} medium security issue${medium.length > 1 ? 's' : ''} persisting. Review at /api/health/security/notifications`,
      type: 'security',
      priority: 'normal',
      source: 'security-audit',
    });
  }
}

async function runScheduledAudit(serverDir, corsOrigins) {
  // BUG FIX: The background audit was catching errors but silently swallowing
  // them. Now we retry once with a fresh DB handle, and log the full error
  // (not just .message) so we can actually diagnose persistent failures.
  try {
    const report = await runSecurityAudit(serverDir, corsOrigins);
    const { newAlerts, persistentAlerts, resolved } = persistFindings(report.findings);
    sendSecurityNotifications(persistentAlerts);
    return { report, newAlerts, persistentAlerts, resolved };
  } catch (err) {
    console.error('[security] Scheduled audit failed (attempt 1):', err.message);
    // Retry once — the DB may have been momentarily locked by a concurrent write
    try {
      // Force a fresh DB connection to recover from stale-locked state
      const { resetDb } = require('./db');
      if (typeof resetDb === 'function') resetDb();
      const report = await runSecurityAudit(serverDir, corsOrigins);
      const { newAlerts, persistentAlerts, resolved } = persistFindings(report.findings);
      sendSecurityNotifications(persistentAlerts);
      console.log('[security] Scheduled audit succeeded on retry.');
      return { report, newAlerts, persistentAlerts, resolved };
    } catch (err2) {
      console.error('[security] Scheduled audit failed (attempt 2, giving up):', err2.message, err2.stack);
      return null;
    }
  }
}

function startSecurityScanner(serverDir, corsOrigins, notifCb) {
  if (_scanTimer) clearInterval(_scanTimer);
  _notifCallback = notifCb;
  // Run an initial audit immediately
  runScheduledAudit(serverDir, corsOrigins);
  // Then on interval
  _scanTimer = setInterval(() => runScheduledAudit(serverDir, corsOrigins), SCAN_INTERVAL_MS);
  console.log(`[security] Scanner started — interval ${SCAN_INTERVAL_MS / 1000}s, persist threshold ${PERSIST_THRESHOLD} scans`);
}

function getSecurityNotifications({ acknowledged = false, limit = 50 } = {}) {
  initSecurityDb();
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM security_notifications
    WHERE acknowledged = ?
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
      last_seen DESC
    LIMIT ?
  `).all(acknowledged ? 1 : 0, limit);
  return rows;
}

function acknowledgeSecurityNotification(id) {
  initSecurityDb();
  const db = getDb();
  const result = db.prepare('UPDATE security_notifications SET acknowledged = 1, notified = 0 WHERE id = ?').run(id);
  return result.changes > 0;
}

function acknowledgeAllSecurityNotifications() {
  initSecurityDb();
  const db = getDb();
  const result = db.prepare('UPDATE security_notifications SET acknowledged = 1, notified = 0 WHERE acknowledged = 0').run();
  return result.changes;
}

module.exports = {
  runSecurityAudit,
  runScheduledAudit,
  startSecurityScanner,
  getSecurityNotifications,
  acknowledgeSecurityNotification,
  acknowledgeAllSecurityNotifications,
  SEVERITY,
};