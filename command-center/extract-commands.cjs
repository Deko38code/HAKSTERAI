#!/usr/bin/env node
/**
 * extract-commands.cjs — scans command MDs on mint + parrot boxes,
 * extracts runnable commands (fenced blocks + inline), dedupes,
 * parses hermes/claude memories, writes commands.json + memories.json
 * for the haksterai.com command center.
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const PARROT_DIR = path.join(HERE, 'parrot');
const SOURCES = [
  { box: 'mint', file: '/home/ghost/SCRIPTS.md', label: 'SCRIPTS.md (all box bypasses + scripts)' },
  // mint box
  { box: 'mint', file: '/home/ghost/haksterai.md', label: 'haksterai.md (skills + knowledge)' },
  { box: 'mint', file: '/home/ghost/MINT-SETUP-NOTES.md', label: 'MINT-SETUP-NOTES.md' },
  { box: 'mint', file: '/home/ghost/PHANTOM-COMMANDS-SKILLS.md', label: 'PHANTOM-COMMANDS-SKILLS.md' },
  { box: 'mint', file: '/home/ghost/PHANTOM-COMPLETE-SETUP.md', label: 'PHANTOM-COMPLETE-SETUP.md' },
  { box: 'mint', file: '/home/ghost/PHANTOM-MONITOR.md', label: 'PHANTOM-MONITOR.md' },
  { box: 'mint', file: '/home/ghost/MAC-IDENTICAL-SETUP.md', label: 'MAC-IDENTICAL-SETUP.md' },
  { box: 'mint', file: '/home/ghost/MORNING-SECURITY.md', label: 'MORNING-SECURITY.md' },
  { box: 'mint', file: '/home/ghost/FIXES-2026-09-09.md', label: 'FIXES-2026-09-09.md' },
  { box: 'mint', file: '/home/ghost/.claude/MEMORY.md', label: 'Claude Code session memory' },
  { box: 'mint', file: '/home/ghost/phantom-knowledge.md', label: 'phantom-knowledge.md' },
  { box: 'mint', file: '/home/ghost/haksterAi/HAKSTER-COMMANDS-CHEATSHEET.md', label: 'HAKSTER-COMMANDS-CHEATSHEET.md' },
  { box: 'mint', file: '/home/ghost/haksterAi/HAKSTERAI-PHANTOM-MERGED.md', label: 'HAKSTERAI-PHANTOM-MERGED.md' },
  // parrot box
  { box: 'parrot', file: path.join(PARROT_DIR, 'CLAUDE.md'), label: 'CLAUDE.md' },
  { box: 'parrot', file: path.join(PARROT_DIR, 'haksterai.md'), label: 'haksterai.md' },
  { box: 'parrot', file: path.join(PARROT_DIR, 'JUNKALOT_CLAUDE_FIX.md'), label: 'JUNKALOT_CLAUDE_FIX.md' },
  { box: 'parrot', file: path.join(PARROT_DIR, 'LENOVO_CLAUDE_FIX.md'), label: 'LENOVO_CLAUDE_FIX.md' },
  { box: 'parrot', file: path.join(PARROT_DIR, 'LENOVO_TUNNEL_SETUP.md'), label: 'LENOVO_TUNNEL_SETUP.md' },
  { box: 'parrot', file: path.join(PARROT_DIR, 'phantom-changelog.md'), label: 'phantom-changelog.md' },
  { box: 'parrot', file: path.join(PARROT_DIR, 'phantom-knowledge-recent.md'), label: 'phantom-knowledge-recent.md' },
  { box: 'parrot', file: path.join(PARROT_DIR, 'phantom-knowledge.md'), label: 'phantom-knowledge.md' },
  { box: 'parrot', file: path.join(PARROT_DIR, 'SESSION_NOTES_2026-04-04.md'), label: 'SESSION_NOTES_2026-04-04.md' },
];

// Commands are "runnable" if they start with one of these prefixes
const CMD_STARTERS = [
  'sudo ', 'pm2 ', 'systemctl ', 'systemd-run ', 'curl ', 'wget ', 'ssh ', 'sshpass ', 'scp ',
  'apt ', 'apt-get ', 'dpkg ', 'npm ', 'npx ', 'node ', 'python3 ', 'python ', 'pip3 ', 'pip ', 'docker ',
  'git ', 'ollama ', 'kill ', 'killall ', 'dd ', 'mount ', 'umount ', 'bluetoothctl', 'rfkill ',
  'hciconfig ', 'nmap ', 'masscan ', 'subfinder ', 'httpx ', 'sqlmap ', 'shodan ', 'chmod ', 'chown ',
  'mv ', 'cp ', 'mkdir ', 'rm ', 'ln ', 'cat ', 'echo ', 'grep ', 'rg ', 'sed ', 'awk ', 'jq ', 'crontab ',
  './', 'bash ', 'sh ', 'tar ', 'unzip ', 'sync', 'make ', 'gcc ', 'ufw ', 'iptables ', 'ip ', 'ifconfig ',
  'macchanger ', 'proxychains', 'tor', 'ngrok ', 'cloudflared ', 'bore ', 'serveo', 'screen ', 'tmux ',
  'nohup ', 'export ', 'source ', 'alias ', 'cd ', 'ls ', 'free ', 'df ', 'du ', 'uptime', 'sensors',
  'ps ', 'top', 'htop', 'wpa_', 'nmcli ', 'xinput ', 'xfconf', 'gsettings ', 'whiskermenu', 'virsh ',
  'qemu', 'modprobe ', 'blacklist ', 'swapon ', 'swapoff ', 'zramctl', 'fstrim ', 'netstat ', 'ss ',
  'ping ', 'dig ', 'host ', 'traceroute', 'whois ', 'openssl ', 'base64 ', 'xxd ', 'md5sum', 'sha1sum',
  'sha256sum', 'sha512sum', 'b2sum', 'wg ', 'lightdm', 'xrandr', 'arandr', 'glxinfo', 'clinfo',
  'smartctl', 'hdparm', 'lsblk', 'blkid', 'fdisk', 'parted', 'snap ', 'flatpak ', 'redis-cli',
  'sqlite3 ', 'mysql ', 'psql ', 'ffmpeg', 'yt-dlp', 'mpv ', 'vlc ', 'notify-send', 'zenity',
];

function looksLikeCommand(line) {
  const l = line.trim();
  if (!l || l.length < 3 || l.length > 600) return false;
  if (l.startsWith('|') || l.startsWith('!') || l.startsWith('>')) return false;
  const bare = l.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^`+/g, '').replace(/`+$/g, '').trim();
  const lower = bare.replace(/^\$\s*/, '').replace(/^#\s*/, '');
  if (lower.startsWith('"') || lower.startsWith("'")) return false;
  return CMD_STARTERS.some(s => lower.startsWith(s));
}

function normCmd(cmd) {
  return cmd.trim().replace(/\s+/g, ' ').toLowerCase();
}

function extract() {
  const out = [];
  const seen = new Map(); // normCmd -> entry
  let id = 0;

  for (const src of SOURCES) {
    let text;
    try { text = fs.readFileSync(src.file, 'utf8'); } catch (e) { continue; }

    const lines = text.split('\n');
    let section = '(top)';
    let i = 0;
    let inFence = false, fenceLang = '', fenceBuf = [], fenceTitle = null;

    const push = (cmd, title) => {
      const c = cmd.trim();
      if (!c) return;
      const key = normCmd(c);
      if (seen.has(key)) {
        const e = seen.get(key);
        if (!e.alsoIn.includes(src.box)) e.alsoIn.push(src.box);
        return;
      }
      const entry = {
        id: ++id,
        box: src.box,
        source: src.label,
        file: path.basename(src.file),
        section,
        title: title || section,
        cmd: c,
        alsoIn: [],
      };
      out.push(entry);
      seen.set(key, entry);
    };

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // heading tracking
      const h = trimmed.match(/^(#{1,4})\s+(.*)/);
      if (h && !inFence) { section = h[2].replace(/[#*`]/g, '').trim() || section; }

      // fenced block handling
      const fenceOpen = trimmed.match(/^```(\w*)/);
      if (fenceOpen && !inFence) {
        inFence = true; fenceLang = fenceOpen[1]; fenceBuf = [];
        // title = nearest bold line above the fence
        for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
          const b = lines[j].trim().match(/^\*\*(.+?)\*\*/);
          if (b) { fenceTitle = b[1].replace(/[:*]/g, '').trim(); break; }
        }
        i++; continue;
      }
      if (trimmed === '```' && inFence) {
        inFence = false;
        const isCmdFence = ['bash', 'sh', 'shell', 'console', 'zsh', ''].includes(fenceLang);
        if (isCmdFence) {
          const cmdLines = fenceBuf.filter(l => {
            const t = l.trim();
            if (!t) return false;
            if (t.startsWith('#')) return false; // comment
            return looksLikeCommand(t);
          });
          if (cmdLines.length) push(cmdLines.join('\n'), fenceTitle || section);
        }
        fenceTitle = null;
        i++; continue;
      }
      if (inFence) { fenceBuf.push(line); i++; continue; }

      // inline: bullet/numbered with backtick code
      const inline = trimmed.match(/^[-*]\s+`([^`]{4,300})`\s*[—-]?\s*(.*)$/) ||
                     trimmed.match(/^\d+[.)]\s+`([^`]{4,300})`\s*[—-]?\s*(.*)$/);
      if (inline) {
        const code = inline[1];
        if (looksLikeCommand(code)) push(code, inline[2] ? inline[2].split(/[.(]/)[0].trim() : section);
        i++; continue;
      }
      // inline: plain one-line command
      if (looksLikeCommand(trimmed) && !trimmed.startsWith('#')) {
        push(trimmed, section);
      }
      i++;
    }
  }
  return out;
}

function extractMemories() {
  const out = [];
  const files = [
    { name: 'Hermes memory', path: '/home/ghost/.hermes/memories/MEMORY.md' },
    { name: 'Claude Code memory', path: '/home/ghost/.claude/MEMORY.md' },
  ];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f.path, 'utf8'); } catch (e) { continue; }
    const paras = text.split(/\n§\s*\n|\n\n+/);
    for (const p of paras) {
      const t = p.trim();
      if (t.length < 40) continue;
      const firstLine = t.split('\n')[0].replace(/^#+\s*/, '').slice(0, 120);
      out.push({ source: f.name, title: firstLine, body: t });
    }
  }
  return out;
}

function main() {
  const commands = extract();
  const memories = extractMemories();
  fs.writeFileSync(path.join(HERE, 'commands.json'), JSON.stringify({
    generated: new Date().toISOString(),
    count: commands.length,
    commands,
  }, null, 1));
  fs.writeFileSync(path.join(HERE, 'memories.json'), JSON.stringify({
    generated: new Date().toISOString(),
    memories,
  }, null, 1));
  console.log(`extracted ${commands.length} unique commands, ${memories.length} memories`);
  const byBox = {};
  for (const c of commands) byBox[c.box] = (byBox[c.box] || 0) + 1;
  console.log('by box:', JSON.stringify(byBox));
}

main();