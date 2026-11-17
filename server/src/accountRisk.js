'use strict';

const crypto = require('crypto');

function mountAccountRiskRoutes(app, { requireOwner, getDb }) {
  function ensureReviewTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS account_risk_reviews (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('verification_requested','reviewed')),
      note TEXT,
      updated_by TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`);
  }

  app.get('/api/admin/account-risk', requireOwner, (req, res) => {
    try {
      const db = getDb();
      ensureReviewTable(db);
      const users = db.prepare(`SELECT id, username, email, role, plan, status, created_at,
        last_login_at, last_login_ip FROM users ORDER BY created_at DESC`).all();
      const signals = new Map(users.map(u => [u.id, []]));
      const add = (id, signal) => { if (signals.has(id)) signals.get(id).push(signal); };

      const sharedIps = db.prepare(`SELECT ip_address, COUNT(DISTINCT user_id) AS account_count
        FROM access_logs WHERE created_at >= unixepoch() - 2592000 AND ip_address <> ''
        GROUP BY ip_address HAVING COUNT(DISTINCT user_id) >= 3`).all();
      const ipRows = db.prepare(`SELECT DISTINCT user_id, ip_address FROM access_logs
        WHERE created_at >= unixepoch() - 2592000 AND ip_address <> ''`).all();
      const ipCounts = new Map(sharedIps.map(x => [x.ip_address, x.account_count]));
      for (const row of ipRows) if (ipCounts.has(row.ip_address)) {
        add(row.user_id, { type: 'shared_ip', label: `IP shared by ${ipCounts.get(row.ip_address)} accounts`, value: row.ip_address, severity: 'medium' });
      }

      const sharedDevices = db.prepare(`SELECT device_fingerprint, COUNT(DISTINCT user_id) AS account_count
        FROM user_devices GROUP BY device_fingerprint HAVING COUNT(DISTINCT user_id) >= 2`).all();
      const deviceCounts = new Map(sharedDevices.map(x => [x.device_fingerprint, x.account_count]));
      const deviceRows = db.prepare(`SELECT user_id, device_fingerprint, device_name, last_seen_at
        FROM user_devices`).all();
      for (const row of deviceRows) if (deviceCounts.has(row.device_fingerprint)) {
        add(row.user_id, { type: 'shared_device', label: `Device seen on ${deviceCounts.get(row.device_fingerprint)} accounts`, value: row.device_name || row.device_fingerprint.slice(0, 10), severity: 'high' });
      }

      const contexts = db.prepare(`SELECT s.user_id, cc.webdriver, cc.is_bot, cc.gpu, cc.device_model,
        cc.user_agent, cc.browser, cc.platform FROM client_contexts cc
        JOIN sessions s ON s.id = cc.session_id
        WHERE s.user_id IS NOT NULL AND cc.updated_at >= unixepoch() - 7776000`).all();
      const automationSeen = new Set();
      const vmSeen = new Set();
      const integritySeen = new Set();
      for (const row of contexts) {
        const marker = `${row.user_id}:`;
        if (['1', 'true'].includes(String(row.webdriver || '').toLowerCase()) && !automationSeen.has(marker + 'webdriver')) {
          automationSeen.add(marker + 'webdriver');
          add(row.user_id, { type: 'automation', label: 'Browser reports webdriver mode', value: 'webdriver signal', severity: 'medium' });
        }
        if (['1', 'true'].includes(String(row.is_bot || '').toLowerCase()) && !automationSeen.has(marker + 'bot')) {
          automationSeen.add(marker + 'bot');
          add(row.user_id, { type: 'automation', label: 'Browser context classified as automated', value: 'bot signal', severity: 'high' });
        }
        const machineHints = `${row.gpu || ''} ${row.device_model || ''} ${row.platform || ''}`;
        if (/virtualbox|vmware|virtual machine|parallels|qemu|xen|hyper-v|swiftshader/i.test(machineHints) && !vmSeen.has(row.user_id)) {
          vmSeen.add(row.user_id);
          add(row.user_id, { type: 'virtual_machine', label: 'Device context contains a virtual-machine indicator', value: 'GPU/device metadata', severity: 'low' });
        }
        const ua = String(row.user_agent || '');
        if (/headlesschrome|phantomjs|playwright|puppeteer|selenium/i.test(ua) && !integritySeen.has(row.user_id)) {
          integritySeen.add(row.user_id);
          add(row.user_id, { type: 'browser_integrity', label: 'User agent contains an automation or headless marker', value: row.browser || 'user agent', severity: 'high' });
        }
      }

      const bursts = db.prepare(`SELECT user_id, COUNT(*) AS events FROM (
          SELECT user_id, created_at FROM access_logs WHERE created_at >= unixepoch() - 600
          UNION ALL
          SELECT user_id, created_at FROM user_activity WHERE created_at >= unixepoch() - 600
        ) WHERE user_id IS NOT NULL GROUP BY user_id HAVING COUNT(*) >= 60`).all();
      for (const row of bursts) add(row.user_id, { type: 'velocity', label: `${row.events} access/activity events in 10 minutes`, value: row.events, severity: 'high' });

      // Exact normalized repeats are hashed and counted; prompt text never leaves this handler.
      const promptRows = db.prepare(`SELECT s.user_id, m.content FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE m.role = 'user' AND m.created_at >= unixepoch() - 86400 AND s.user_id IS NOT NULL
        ORDER BY m.created_at DESC LIMIT 10000`).all();
      const repeated = new Map();
      for (const row of promptRows) {
        const normalized = String(row.content || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (normalized.length < 24) continue;
        const hash = crypto.createHash('sha256').update(normalized).digest('hex');
        let item = repeated.get(hash);
        if (!item) repeated.set(hash, item = { count: 0, userIds: new Set() });
        item.count++;
        item.userIds.add(row.user_id);
      }
      for (const item of repeated.values()) if (item.count >= 8 || item.userIds.size >= 3) {
        for (const id of item.userIds) add(id, { type: 'repeated_prompt', label: `Repeated prompt pattern (${item.count} matches, ${item.userIds.size} accounts)`, value: 'normalized hash match', severity: item.userIds.size >= 3 ? 'high' : 'medium' });
      }

      const reviews = new Map(db.prepare('SELECT user_id, state, note, updated_at FROM account_risk_reviews').all().map(x => [x.user_id, x]));
      const result = users.map(user => {
        const userSignals = signals.get(user.id) || [];
        const score = Math.min(100, userSignals.reduce((sum, s) => sum + (s.severity === 'high' ? 35 : s.severity === 'medium' ? 18 : 8), 0));
        const severity = score >= 70 ? 'high' : score >= 35 ? 'medium' : score > 0 ? 'low' : 'clear';
        const device = db.prepare(`SELECT device_name, device_type, os_name, os_version, browser, browser_version, timezone, language, last_seen_at
          FROM user_devices WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 1`).get(user.id) || null;
        return { ...user, score, severity, signals: userSignals, device, review: reviews.get(user.id) || null };
      }).sort((a, b) => b.score - a.score || (b.last_login_at || 0) - (a.last_login_at || 0));

      res.json({ users: result, summary: {
        total: result.length,
        flagged: result.filter(u => u.score > 0).length,
        high: result.filter(u => u.severity === 'high').length,
        verificationRequested: result.filter(u => u.review?.state === 'verification_requested').length,
        suspended: result.filter(u => u.status === 'suspended').length,
      }, coverage: { vpnProxy: 'unavailable', location: 'unavailable', incognito: 'unavailable', devtools: 'unavailable', installedSoftware: 'unavailable' } });
    } catch (err) {
      console.error('[account-risk] dashboard query failed:', err.message);
      res.status(500).json({ error: 'Account risk data unavailable' });
    }
  });

  app.post('/api/admin/account-risk/:id/action', requireOwner, (req, res) => {
    try {
      const db = getDb();
      ensureReviewTable(db);
      const { action, note = '' } = req.body || {};
      const user = db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.role === 'admin') return res.status(400).json({ error: 'Admin accounts cannot be changed here' });
      if (!['request_verification', 'mark_reviewed', 'suspend', 'reactivate'].includes(action)) {
        return res.status(400).json({ error: 'Unknown account risk action' });
      }
      const cleanNote = String(note).slice(0, 500);
      if (action === 'request_verification' || action === 'mark_reviewed') {
        const state = action === 'request_verification' ? 'verification_requested' : 'reviewed';
        db.prepare(`INSERT INTO account_risk_reviews (user_id, state, note, updated_by, updated_at)
          VALUES (?, ?, ?, ?, unixepoch()) ON CONFLICT(user_id) DO UPDATE SET
          state=excluded.state, note=excluded.note, updated_by=excluded.updated_by, updated_at=unixepoch()`)
          .run(user.id, state, cleanNote, req.user.id);
      } else if (action === 'suspend') {
        db.prepare("UPDATE users SET status = 'suspended', updated_at = unixepoch() WHERE id = ? AND status <> 'banned'").run(user.id);
        db.prepare(`INSERT INTO api_key_audit (user_id, action, reason, performed_by) VALUES (?, 'suspend', ?, ?)`)
          .run(user.id, cleanNote || 'Admin account risk review', req.user.id);
      } else {
        if (user.status === 'banned') return res.status(400).json({ error: 'Banned accounts require a separate review' });
        db.prepare("UPDATE users SET status = 'active', updated_at = unixepoch() WHERE id = ? AND status = 'suspended'").run(user.id);
        db.prepare(`INSERT INTO api_key_audit (user_id, action, reason, performed_by) VALUES (?, 'reactivate', ?, ?)`)
          .run(user.id, cleanNote || 'Admin account risk review', req.user.id);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[account-risk] action failed:', err.message);
      res.status(500).json({ error: 'Could not update account review' });
    }
  });
}

module.exports = { mountAccountRiskRoutes };
