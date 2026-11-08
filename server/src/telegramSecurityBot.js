'use strict';

// Security posture bot (fleet slot 7).
//
// Read-only host security checks for the Dell. Nothing here changes the system: every
// command only reports. Any fix stays with Deke — the bot says so instead of acting.
//
// Commands: /security /audit /ports /ssh /fw /updates /users /help

const { exec } = require('child_process');

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
  '🛡 *Security Bot* — read-only posture checks',
  '',
  '`/security` — full summary',
  '`/ports` — listening ports and owners',
  '`/ssh` — recent failed SSH logins',
  '`/fw` — firewall state',
  '`/updates` — pending package updates',
  '`/users` — root/uid-0 and sudo group accounts',
  '`/help` — this list',
  '',
  'Every check is read-only. Fixes are proposed, never applied.',
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
  return [
    '🛡 *Security summary* (read-only)',
    '',
    `• Listening sockets: ${listenCount}`,
    `• Failed-login lines (24h sample): ${failedCount}`,
    `• ${upgradable}`,
    `• Firewall: ${fwHead.replace(/[*_`]/g, '')}`,
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

const COMMANDS = {
  '/security': summary,
  '/audit': summary,
  '/ports': ports,
  '/ssh': sshFailures,
  '/fw': firewall,
  '/firewall': firewall,
  '/updates': updates,
  '/users': users,
};

// Returns message text for a security-bot command, or null when the text is not ours.
async function handleSecurityCommand(text) {
  const cmd = String(text || '').trim().split(/\s+/)[0].toLowerCase();
  if (!cmd.startsWith('/')) return null;
  if (cmd === '/help' || cmd === '/start') return HELP;
  const handler = COMMANDS[cmd];
  if (!handler) return null;
  const body = await handler();
  return body;
}

function securityDigest() {
  return summary();
}

module.exports = { handleSecurityCommand, securityDigest, HELP };
