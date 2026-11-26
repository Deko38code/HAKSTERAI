/* listening-ports.js — "what is listening on this machine?" on every platform.
 *
 * Owner, 2026-11-26 (Surface Pro, Windows): "says scan unavailable ss not
 * readable". The services grid asked `ss -tlnp`, which is a Linux tool — on
 * Windows the exec failed with ENOENT and the panel honestly reported that it
 * could not scan. The panel was right; the scanner was Linux-only.
 *
 * One implementation, three backends, all read-only:
 *   linux   ss -tlnp          (the original)
 *   win32   netstat -ano      (ships with Windows; LISTENING rows only)
 *   darwin  netstat -an -p tcp (BSD netstat; LISTEN rows only)
 *
 * Nothing here installs, changes or probes anything: it starts the platform's
 * own tool, parses its output and returns the ports. A backend that cannot run
 * returns `ok: false` with a reason, so the panel can say WHY it has no
 * reading instead of inventing one (§10, §13).
 */
'use strict';

const { execFile } = require('child_process');

/** The tool this platform's scan uses. */
function backendFor(platform = process.platform) {
  if (platform === 'win32') return 'netstat';
  if (platform === 'darwin') return 'netstat';
  return 'ss';
}

/** The argv for that tool. */
function argsFor(backend, platform = process.platform) {
  if (backend === 'netstat') return platform === 'darwin' ? ['-an', '-p', 'tcp'] : ['-ano'];
  return ['-tlnp'];
}

/** Trailing port digits of a local address: `0.0.0.0:135`, `[::]:135`,
 *  `127.0.0.1.5000`, `*.22` all resolve to their port. 0 means "no port". */
function extractPort(address) {
  const m = String(address == null ? '' : address).match(/([0-9]{1,5})\s*$/);
  if (!m) return 0;
  const port = Number(m[1]);
  return port > 0 && port <= 65535 ? port : 0;
}

/** Linux: `ss -tlnp` — unchanged from the original parser so nothing about the
 *  existing reading moves. */
function parseSs(text) {
  const ports = new Set();
  const procs = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/:([0-9]{2,5})\s+\S+\s+.*users:\(\("([^"]+)"/);
    if (m) { ports.add(Number(m[1])); procs[m[1]] = m[2]; continue; }
    const m2 = line.match(/:([0-9]{2,5})\s+\S+/);
    if (m2) ports.add(Number(m2[1]));
  }
  return { ports: [...ports].sort((a, b) => a - b), procs };
}

/** Windows: `netstat -ano` — only rows whose state is LISTENING count, so an
 *  established browser connection to :443 is not reported as a local service.
 *  The PID column is kept; Windows netstat does not name the process. */
function parseNetstatWin(text) {
  const ports = new Set();
  const procs = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!/^TCP/i.test(line)) continue;
    const f = line.split(/\s+/);
    // Proto · Local · Foreign · State · PID
    if (f.length < 4) continue;
    const local = f[1];
    // Established/TimeWait/SynSent rows also carry a port; only a listening
    // socket is a local service.
    const state = (f[3] || '').toUpperCase();
    if (state !== 'LISTENING' && state !== 'LISTEN') continue;
    const port = extractPort(local);
    if (!port) continue;
    ports.add(port);
    const pid = f[4] || '';
    if (pid && /^[0-9]+$/.test(pid)) procs[port] = `pid ${pid}`;
  }
  return { ports: [...ports].sort((a, b) => a - b), procs };
}

/** macOS/BSD: `netstat -an -p tcp` — `tcp4 0 0 *.22 *.* LISTEN`. */
function parseNetstatBsd(text) {
  const ports = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!/^tcp/i.test(line)) continue;
    const f = line.split(/\s+/);
    if (f.length < 6) continue;
    if (String(f[5]).toUpperCase() !== 'LISTEN') continue;
    const port = extractPort(f[3]);
    if (port) ports.add(port);
  }
  return { ports: [...ports].sort((a, b) => a - b), procs: {} };
}

/** Parse `stdout` for `backend`. Exported so the tests can run a real capture
 *  of each platform's output without a Windows box. */
function parse(backend, text, platform = process.platform) {
  if (backend === 'netstat') {
    return platform === 'darwin' ? parseNetstatBsd(text) : parseNetstatWin(text);
  }
  return parseSs(text);
}

/**
 * Scan this machine's listening TCP ports.
 * Resolves `{ ok, ports, procs, backend, reason?, at }` — never rejects.
 */
function scanPorts(timeoutMs = 4000, platform = process.platform) {
  return new Promise((resolve) => {
    const backend = backendFor(platform);
    const at = () => Date.now();
    try {
      execFile(
        backend,
        argsFor(backend, platform),
        { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true },
        (err, stdout) => {
          const text = String(stdout || '');
          if (err && !text) {
            const code = err.code || '';
            const reason = code === 'ENOENT' ? `${backend}-not-installed` : code === 'ETIMEDOUT' ? 'timeout' : 'failed';
            return resolve({ ok: false, ports: [], procs: {}, backend, reason, at: at() });
          }
          const parsed = parse(backend, text, platform);
          resolve({ ok: true, ports: parsed.ports, procs: parsed.procs, backend, at: at() });
        },
      );
    } catch {
      return resolve({ ok: false, ports: [], procs: {}, backend, reason: 'failed', at: at() });
    }
  });
}

module.exports = {
  backendFor,
  argsFor,
  extractPort,
  parse,
  parseSs,
  parseNetstatWin,
  parseNetstatBsd,
  scanPorts,
};
