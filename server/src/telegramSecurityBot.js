'use strict';

// Security posture bot (fleet slot 7).
//
// Read-only host security checks for the Dell. Nothing here changes the system: every
// command only reports. Any fix stays with Deke — the bot says so instead of acting.
//
// Commands: /security /audit /ports /ssh /fw /updates /users /help
//           /scan [phantom|hakster|all]  /scanlast   — read-only web vulnerability scans
//           /logins /ips /baseline       — login audit, source IPs, learned patterns

const { exec } = require('child_process');
const {
  scanAll,
  persistScan,
  loadState,
  formatReport,
  TARGETS,
  HISTORY_FILE,
} = require('./webVulnScanner');
const {
  collectAll,
  updateBaseline,
  loadBaseline,
  recentLoginsText,
  topIpsText,
  baselineText,
  anomaliesFrom,
} = require('./loginAudit');
const guard = require('./accessGuard');

function sh(command, timeout = 20000) {
  return new Promise((resolve) => {
    exec(command, { timeout, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
      const errLine = String((err && (stderr || err.message)) || '').split('\n')[0].slice(0, 120);
      if (err && !stdout) {
        const needsRoot = /permission denied|operation not permitted|must be root|access denied/i.test(errLine);
        return resolve(needsRoot ? '(needs root)' : `(unavailable: ${errLine})`);
      }
      resolve(String(stdout || '').trim().slice(0, 3500));
    });
  });
}

const HELP = [
  '🛡 *Security Bot* — read-only checks. Nothing is ever changed.',
  '',
  '*Host*',
  '`/security` — full summary',
  '`/ports` — listening ports and owners',
  '`/ssh` — recent failed SSH logins',
  '`/fw` — firewall state',
  '`/updates` — pending package updates',
  '`/users` — root/uid-0 and sudo group accounts',
  '',
  '*Web (owner sites only)*',
  '`/scan` — scan phantomide.com + haksterai.com now',
  '`/scan phantom` · `/scan hakster` — one site',
  '`/scanlast` — last scheduled scan result',
  '',
  '*Logins · IPs · patterns*',
  '`/logins` — recent successful and failed logins',
  '`/ips` — source IPs seen, with counts',
  '`/baseline` — what the bot has learned (usual IPs, users, hours)',
  '',
  '*Access · paid · denials*',
  '`/guard` — who was challenged or denied in the last 24h',
  '`/access <email>` — is this account actually paid?',
  '`/denials` — active IP denials',
  '`/deny <ip> [minutes] [reason]` — block an IP at the app',
  '`/undeny <ip>` — lift it',
  '`/whois <ip>` — everything recorded for one address',
  '`/enforce <surface>` · `/observe <surface>` — flip enforcement',
  '',
  '`/help` — this list',
].join('\n');

async function ports() {
  const ss = await sh("ss -ltnp 2>/dev/null | awk 'NR==1 || /LISTEN/' | head -25");
  return ss || '(no listener data)';
}

async function sshFailures() {
  const lastb = await sh('lastb -n 10 2>/dev/null | head -12');
  const journal = await sh("journalctl -u ssh --since '24 hours ago' --no-pager 2>/dev/null | grep -i 'failed password\\|invalid user' | tail -10");
  const parts = [];
  if (lastb && !lastb.startsWith('(unavailable')) parts.push('Recent bad logins:\n' + lastb);
  if (journal && !journal.startsWith('(unavailable')) parts.push('SSH journal (24h):\n' + journal);
  if (!parts.length) {
    const auth = await sh("grep -i 'failed password\\|invalid user' /var/log/auth.log 2>/dev/null | tail -10");
    if (auth && !auth.startsWith('(unavailable')) parts.push('auth.log:\n' + auth);
  }
  return parts.join('\n\n') || '(no failed-login data readable without root)';
}

async function firewall() {
  const ufw = await sh('ufw status verbose 2>&1 | head -15');
  const nft = await sh('nft list ruleset 2>/dev/null | head -20');
  const rootOnly = /you need to be root|must be root|permission denied|operation not permitted/i;
  const parts = [];
  if (ufw && !rootOnly.test(ufw)) parts.push('ufw:\n' + ufw);
  if (nft && !nft.startsWith('(unavailable') && !rootOnly.test(nft)) parts.push('nftables:\n' + nft);
  return parts.join('\n\n') || '(needs root — firewall state is not readable by the bot user)';
}

async function updates() {
  const raw = await sh("apt list --upgradable 2>/dev/null | grep -v '^WARNING' | tail -n +2 | head -20");
  if (raw.startsWith('(needs root)')) return raw;
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '0 upgradable packages (package lists current)';
  return `${lines.length} upgradable package(s):\n${lines.join('\n')}`;
}

async function users() {
  const uid0 = await sh("awk -F: '$3==0 {print $1\" (uid 0)\"}' /etc/passwd");
  const sudo = await sh("getent group sudo 2>/dev/null | cut -d: -f4");
  const sshRoot = await sh("grep -Ei '^\\s*PermitRootLogin' /etc/ssh/sshd_config 2>/dev/null");
  const logins = await sh("who 2>/dev/null | head -10");
  return [
    'uid-0 accounts: ' + (uid0 || 'none'),
    'sudo group: ' + (sudo || 'none'),
    'PermitRootLogin: ' + (sshRoot || '(default — not set in sshd_config)'),
    'Currently logged in:\n' + (logins || 'none'),
  ].join('\n');
}

async function summary() {
  const [p, s, f, u] = await Promise.all([ports(), sshFailures(), firewall(), updates()]);
  const failedCount = (s.match(/Failed password|invalid user|failed/gi) || []).length;
  const listenCount = p.split('\n').filter((l) => /LISTEN/.test(l)).length;
  const upgradable = u.split('\n')[0] || 'updates unknown';
  const fwHead = f.startsWith('(')
    ? f
    : (f.split('\n').find((l) => l.trim()) || 'firewall state unknown');
  const web = loadState();
  const base = loadBaseline();
  return [
    '🛡 *Security summary* (read-only)',
    '',
    `• Listening sockets: ${listenCount}`,
    `• Failed-login lines (24h sample): ${failedCount}`,
    `• ${upgradable}`,
    `• Firewall: ${fwHead.replace(/[*_`]/g, '')}`,
    web
      ? `• Last web scan: ${String(web.at || '').slice(0, 16).replace('T', ' ')}Z — ${(web.summary && web.summary.high) || 0} high, ${(web.summary && web.summary.medium) || 0} medium`
      : '• Web scan: none yet — send /scan',
    base
      ? `• Login baseline: ${base.totalEvents || 0} events, ${Object.keys(base.ips || {}).length} source IPs`
      : '• Login baseline: still learning',
    '',
    'Ports:',
    p.split('\n').slice(0, 12).join('\n'),
    '',
    'SSH failures:',
    s.split('\n').slice(0, 8).join('\n'),
    '',
    'Nothing was changed. Ask Deke before any fix.',
  ].join('\n');
}

// ── web vulnerability scans (read-only, the two owner-authorized hosts only) ────────

function scanTargetsFromArg(arg) {
  const which = String(arg || '').trim().toLowerCase();
  if (!which || which === 'all' || which === 'both') return Object.keys(TARGETS);
  return [which];
}

async function scanNow(arg) {
  const keys = scanTargetsFromArg(arg);
  const unknown = keys.filter((k) => !TARGETS[k]);
  if (unknown.length) return `Unknown target "${unknown[0]}". Use: /scan, /scan phantom, /scan hakster.`;
  const res = await scanAll(keys);
  persistScan(res);
  return formatReport(res, { maxFindings: 8 });
}

function lastScanText() {
  const st = loadState();
  if (!st) return 'No web scan has run yet. Send /scan to run one now.';
  const when = String(st.at || '').replace('T', ' ').replace(/\..*$/, ' UTC');
  const s = st.summary || {};
  const rows = (st.grades || []).map((g) => {
    const c = g.counts || {};
    return `• ${g.key}: grade ${g.grade} — ${c.high || 0} high · ${c.medium || 0} medium · ${c.low || 0} low`;
  });
  return [
    `🔒 *Last web scan* — ${when}`,
    `Total: ${s.high || 0} high · ${s.medium || 0} medium · ${s.low || 0} low`,
    ...rows,
    '',
    'Scheduled scans run every 6 hours; alerts post when findings change.',
  ].join('\n');
}

// ── login / IP / pattern commands ───────────────────────────────────────────────────

async function loginsNow() {
  const events = await collectAll({ sinceHours: 24 });
  if (!events.length) return 'No login events parsed in the last 24h (logs unreadable or quiet).';
  updateBaseline(events);
  return recentLoginsText(events, 15);
}

function ipsNow() {
  const base = loadBaseline();
  return topIpsText(base, 15);
}

function baselineNow() {
  return baselineText();
}

// ── access guard commands ───────────────────────────────────────────────────────────

async function guardNow(arg) {
  const hours = Number(arg) || 24;
  const phantom = await guard.phantomGuardText(hours);
  return [guard.summaryText(hours), '', phantom].join('\n');
}

function whoisNow(arg) {
  return guard.whoisText(arg);
}

function accessNow(arg) {
  if (!arg) return 'usage: /access <email>';
  return guard.accessText(arg);
}

function denialsNow() {
  const list = guard.listDenials();
  if (!list.length) return 'No active IP denials.';
  const now = Math.floor(Date.now() / 1000);
  return [
    '🚫 *Active IP denials*',
    '',
    ...list.map((d) => `• ${d.ip} — ${Math.max(1, Math.round((d.until - now) / 60))} min left · ${d.reason || 'no reason'} · by ${d.created_by || '?'}`),
    '',
    'App-level rows with an expiry. No firewall rule was touched.',
  ].join('\n');
}

function denyNow(args) {
  const [ip, min, ...rest] = args || [];
  if (!ip) return 'usage: /deny <ip> [minutes] [reason]';
  if (guard.isPrivateOrLocal(ip)) {
    return `${ip} is a private/local address. Denials for the owner's own network are refused — that is how you lock yourself out.`;
  }
  const d = guard.denyIp(ip, { minutes: Number(min) || 60, reason: rest.join(' ') || 'manual (telegram)', by: 'owner/telegram' });
  return `🚫 ${d.ip} denied for ${d.minutes} min (until ${new Date(d.until * 1000).toISOString().slice(11, 16)}Z).\nReason: ${d.reason}\nApp-level only — no firewall rule was touched.`;
}

function undenyNow(arg) {
  if (!arg) return 'usage: /undeny <ip>';
  return guard.undenyIp(arg) ? `✅ ${arg} can reach the app again.` : `${arg} was not denied.`;
}

function modeNow(mode, surface) {
  const which = surface || 'hakster';
  return `${guard.setMode(mode, which)}\nGlobal mode: ${guard.loadSettings().mode}. Free and trialing accounts are never blocked by this.`;
}

const COMMANDS = {
  '/security': summary,
  '/audit': summary,
  '/ports': ports,
  '/ssh': sshFailures,
  '/fw': firewall,
  '/firewall': firewall,
  '/updates': updates,
  '/users': users,
  '/logins': loginsNow,
  '/ips': ipsNow,
  '/baseline': baselineNow,
};

// Returns message text for a security-bot command, or null when the text is not ours.
async function handleSecurityCommand(text) {
  const parts = String(text || '').trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  if (!cmd.startsWith('/')) return null;
  if (cmd === '/help' || cmd === '/start') return HELP;
  if (cmd === '/scan' || cmd === '/scanall') return scanNow(parts[1]);
  if (cmd === '/scanlast' || cmd === '/lastscan') return lastScanText();
  if (cmd === '/guard') return guardNow(parts[1]);
  if (cmd === '/access') return accessNow(parts[1]);
  if (cmd === '/whois') return whoisNow(parts[1]);
  if (cmd === '/denials') return denialsNow();
  if (cmd === '/deny') return denyNow(parts.slice(1));
  if (cmd === '/undeny') return undenyNow(parts[1]);
  if (cmd === '/enforce' || cmd === '/observe') return modeNow(cmd.slice(1), parts[1]);
  const handler = COMMANDS[cmd];
  if (!handler) return null;
  const body = await handler();
  return body;
}

function securityDigest() {
  return summary();
}

// Used by the scheduled login reporter in telegramBots.js.
async function loginReport(hours = 1) {
  const events = await collectAll({ sinceHours: hours });
  const anomalies = updateBaseline(events);
  return { events, anomalies };
}

module.exports = {
  handleSecurityCommand,
  securityDigest,
  loginReport,
  anomaliesFrom,
  HELP,
};
