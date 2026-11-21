#!/usr/bin/env node
'use strict';
/**
 * haksterAI — cross-box health probe (read-only).
 *
 * Checks the three boxes and the public sites, prints one compact report, and
 * optionally sends it through the health bot. It changes nothing anywhere:
 *   * only reads /proc, `free`, `df`, `systemctl is-active`, `pgrep -c`
 *   * SSH uses BatchMode + a short ConnectTimeout, so a sleeping box is reported
 *     as unreachable instead of hanging the probe
 *   * every remote command is wrapped in a wall-clock timeout
 *
 *   node server/scripts/health-probe.js            # print only
 *   node server/scripts/health-probe.js --send     # also send to the health bot
 *   node server/scripts/health-probe.js --json     # machine-readable
 *
 * Exit code: 0 = everything healthy, 1 = at least one FAIL, 2 = at least one WARN only.
 *
 * Why it exists: each box supervises itself with pm2/systemd, but nothing looked
 * across the three of them, so a dead origin (dash.phantomide.com) and a disk one
 * build away from full (Parrot, 12 GB) both stayed invisible until someone looked.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');

const BOXES = [
  { key: 'dell', label: 'Dell', host: null, cores: os.cpus().length },          // local
  { key: 'parrot', label: 'Parrot', host: 'parrot', cores: 4 },
  { key: 'mint', label: 'Mint .210', host: 'mint', cores: 4 },
];

const SITES = [
  'https://haksterai.com',
  'https://phantomide.com',
  'https://junkalot.co',
  'https://flixchill.link',
  'https://rmt.haksterai.com',
  'https://dash.phantomide.com',
];

// One cheap, read-only command per box. No du/find — those stall on a full disk.
const REMOTE_CMD = [
  'cat /proc/loadavg',
  'free -b | awk \'/^Mem:/{print "MEM",$2,$7}\'',
  'free -b | awk \'/^Swap:/{print "SWAP",$2,$3}\'',
  'df -Pk / | awk \'NR==2{print "DISK",$2,$4}\'',
  'systemctl is-active junkalot 2>/dev/null | sed "s/^/UNIT_JUNKALOT /"',
  'pgrep -c cloudflared 2>/dev/null | sed "s/^/CLOUDFLARED /"',
].join('; ');

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '').trim(), code: err && err.code });
    });
  });
}

async function sshBox(host) {
  return run('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR',
    host, '--', REMOTE_CMD,
  ], 20000);
}

function parseMetrics(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (!parts.length) continue;
    if (/^\d+\.\d+\s+\d+\.\d+\s+\d+\.\d+/.test(line)) out.load = Number(parts[0]);
    else if (parts[0] === 'MEM') { out.memTotal = Number(parts[1]); out.memAvail = Number(parts[2]); }
    else if (parts[0] === 'SWAP') { out.swapTotal = Number(parts[1]); out.swapUsed = Number(parts[2]); }
    else if (parts[0] === 'DISK') { out.diskTotal = Number(parts[1]) * 1024; out.diskFree = Number(parts[2]) * 1024; }
    else if (parts[0] === 'UNIT_JUNKALOT') out.junkalot = parts[1];
    else if (parts[0] === 'CLOUDFLARED') out.cloudflared = Number(parts[1]);
  }
  return out;
}

function pct(used, total) {
  return total > 0 ? Math.round((used / total) * 100) : null;
}

function gradeBox(box, m) {
  const issues = [];
  let level = 'OK';
  const worse = (next) => { if (next === 'FAIL') level = 'FAIL'; else if (next === 'WARN' && level !== 'FAIL') level = 'WARN'; };

  if (m.load === undefined) return { level: 'FAIL', issues: ['unreachable'] };
  const loadPct = Math.round((m.load / box.cores) * 100);
  if (loadPct >= 100) { issues.push(`load ${m.load} on ${box.cores} cores`); worse('WARN'); }
  if (m.memAvail !== undefined && m.memTotal) {
    const availPct = pct(m.memAvail, m.memTotal);
    if (availPct !== null && availPct < 10) { issues.push(`RAM ${100 - availPct}% used`); worse('WARN'); }
  }
  if (m.swapTotal > 0) {
    const swapPct = pct(m.swapUsed, m.swapTotal);
    if (swapPct >= 75) { issues.push(`swap ${swapPct}% used`); worse('WARN'); }
  }
  if (m.diskTotal > 0) {
    const diskPct = pct(m.diskTotal - m.diskFree, m.diskTotal);
    if (diskPct >= 95) { issues.push(`disk ${diskPct}% — ${Math.round(m.diskFree / 1e9)} GB free`); worse('FAIL'); }
    else if (diskPct >= 90) { issues.push(`disk ${diskPct}% — ${Math.round(m.diskFree / 1e9)} GB free`); worse('WARN'); }
  }
  if (box.key === 'parrot' && m.junkalot && m.junkalot !== 'active') { issues.push(`junkalot ${m.junkalot}`); worse('FAIL'); }
  return { level, issues };
}

function fmt(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const asJson = args.includes('--json');

  const results = [];

  for (const box of BOXES) {
    let m;
    if (!box.host) {
      const raw = await run('bash', ['-c', REMOTE_CMD], 10000);
      m = parseMetrics(raw.stdout);
      // local free reports bytes already, same shape
      if (m.memTotal === undefined) {
        const mem = os.totalmem();
        m.memTotal = mem;
        m.memAvail = os.freemem();
      }
      m.load = os.loadavg()[0];
    } else {
      const r = await sshBox(box.host);
      m = r.ok ? parseMetrics(r.stdout) : {};
      if (!r.ok) m.load = undefined;
    }
    results.push({ box, metrics: m, verdict: gradeBox(box, m) });
  }

  const sites = [];
  for (const url of SITES) {
    const started = Date.now();
    const r = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '12', url], 15000);
    const code = (r.stdout || '').trim();
    sites.push({ url, code, ms: Date.now() - started, ok: code === '200' });
  }

  if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), boxes: results, sites }, null, 2));
  } else {
    const when = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    console.log(`Health probe — ${when}\n`);
    for (const { box, metrics: m, verdict } of results) {
      if (m.load === undefined) {
        console.log(`${box.label.padEnd(10)} FAIL  unreachable`);
        continue;
      }
      const bits = [
        `load ${m.load.toFixed(2)}/${box.cores}`,
        `RAM ${fmt(m.memAvail)} free of ${fmt(m.memTotal)}`,
        m.swapTotal > 0 ? `swap ${pct(m.swapUsed, m.swapTotal)}%` : 'no swap',
        `disk ${pct(m.diskTotal - m.diskFree, m.diskTotal)}% (${fmt(m.diskFree)} free)`,
      ];
      if (m.cloudflared !== undefined) bits.push(`cloudflared ×${m.cloudflared}`);
      console.log(`${box.label.padEnd(10)} ${verdict.level.padEnd(5)} ${bits.join(' · ')}`);
      if (verdict.issues.length) console.log(`${''.padEnd(16)}↳ ${verdict.issues.join(' · ')}`);
    }
    console.log('');
    for (const s of sites) {
      const name = s.url.replace('https://', '').padEnd(28);
      console.log(`${name} ${s.ok ? '200' : s.code || 'ERR'}  ${s.ms} ms`);
    }
  }

  const failed = results.some((r) => r.verdict.level === 'FAIL') || sites.some((s) => !s.ok);
  const warned = results.some((r) => r.verdict.level === 'WARN');

  if (send) {
    const lines = [];
    lines.push(`Health probe ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    for (const { box, metrics: m, verdict } of results) {
      if (m.load === undefined) { lines.push(`${box.label}: unreachable`); continue; }
      lines.push(`${box.label}: ${verdict.level} · load ${m.load.toFixed(2)}/${box.cores} · RAM ${fmt(m.memAvail)} free · disk ${pct(m.diskTotal - m.diskFree, m.diskTotal)}% (${fmt(m.diskFree)} free)${verdict.issues.length ? ` · ${verdict.issues.join(', ')}` : ''}`);
    }
    lines.push('Sites: ' + sites.map((s) => `${s.url.replace('https://', '')} ${s.ok ? '200' : s.code || 'ERR'}`).join(' · '));
    const tmp = path.join(os.tmpdir(), `health-probe-${Date.now()}.txt`);
    fs.writeFileSync(tmp, lines.join('\n'));
    const sent = await run('node', [path.join(__dirname, 'telegram-report.js'), '--role', 'health', '--file', tmp], 25000);
    console.log('\nhealth bot: ' + (sent.ok ? 'delivered' : `failed (${sent.stderr || sent.code})`));
  }

  return failed ? 1 : warned ? 2 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('health-probe failed:', err.message);
  process.exitCode = 1;
});
