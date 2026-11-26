/* ports-quickstart — the numbered quick-start list that lives in /menu.
 *
 * Owner, 2026-11-26: "and add ports to /menu for quick start ports etc with
 * 1-10 commands to start from clicking what # to start in menu man if users
 * want to".
 *
 * The order is the top status box's own order (EXPECTED_SERVICES in
 * smartness.mjs), so `3` means the third port in the grid the operator is
 * already reading — the menu and the grid never disagree about what a number
 * points at. Past those five come the other services this box actually runs,
 * up to ten (`0` is the tenth).
 *
 * Two rules this module keeps, because getting them wrong is a production
 * incident rather than a cosmetic bug:
 *
 *   1. A port that is already listening is NEVER started. `pm2 start` on a live
 *      app is a bounce, and a bounce drops whoever is attached to it
 *      (CLAUDE.md §37, §45). `startPlan()` returns a refusal, not a command.
 *   2. Only a service with a real process-manager name is startable. `phantom`
 *      runs on the Parrot box, so it has no local start command and says so
 *      instead of firing a `pm2 start` that cannot work (§13: never claim an
 *      action that did not happen).
 *
 * Every pm2 name below was measured on this box on 2026-11-26 by matching
 * `ss -tlnp` pids against `pm2 jlist`; none of them is a guess.
 */

/** The ten numbered quick starts. `n` is the key the operator presses (10 is
 *  the `0` key). Order = EXPECTED_SERVICES first, then the rest of the box. */
export const QUICKSTART_PORTS = [
  { n: 1, port: 3579, name: 'HAKSTER-AI', pm2: 'hakster-router' },
  { n: 2, port: 8081, name: 'cinevault', pm2: 'cinevault' },
  { n: 3, port: 4000, name: 'phantom', pm2: null }, // runs on the Parrot box
  { n: 4, port: 8082, name: 'claude-proxy', pm2: 'claude-code-proxy' },
  { n: 5, port: 5555, name: 'miniforge', pm2: 'miniforge' },
  { n: 6, port: 8888, name: 'stalkerhek', pm2: 'stalkerhek' },
  { n: 7, port: 8111, name: 'rmt', pm2: 'rmt' },
  { n: 8, port: 8100, name: 'hakterm', pm2: 'hakterm' },
  { n: 9, port: 3580, name: 'hakster', pm2: 'hakster' },
  { n: 10, port: 5599, name: 'tools-gateway', pm2: 'tools-gateway' },
];

/** The `0` key is the tenth entry. */
export function quickStartNumber(keyName) {
  const k = String(keyName == null ? '' : keyName);
  if (!/^[0-9]$/.test(k)) return 0;
  return k === '0' ? 10 : Number(k);
}

/** Live state for the ten rows.
 *
 *  `services` is `serviceStates(scan)` — only the five EXPECTED_SERVICES. The
 *  other five are not in that list, so their state comes straight from the scan
 *  itself; falling back to a services-only reading would paint every extra row
 *  red even while it is listening. When the scan did not run, the row says
 *  `unknown` rather than inventing `down`. */
export function quickStartRows(services = [], scan = null) {
  const list = Array.isArray(services) ? services : [];
  const fromServices = new Set(list.filter((s) => s && s.up).map((s) => Number(s.port)));
  const fromScan = new Set(((scan && scan.ports) || []).map(Number));
  const scanOk = !!(scan && scan.ok);
  const isUp = (port) => (scanOk ? fromScan.has(port) : fromServices.has(port));
  return QUICKSTART_PORTS.map((entry) => {
    const up = isUp(entry.port);
    const state = scanOk || fromServices.size ? (up ? 'online' : 'down') : 'unknown';
    return {
      kind: 'port',
      n: entry.n,
      port: entry.port,
      name: entry.name,
      pm2: entry.pm2,
      up,
      color: up ? 'green' : 'red',
      label: `${entry.n} ${up ? '●' : '○'} :${entry.port} ${entry.name}`,
      detail: entry.pm2 ? `${state} · pm2 ${entry.pm2}` : `${state} · Parrot box, no local start`,
      action: { port: entry.n },
    };
  });
}

/** The row for a pressed number, or null. */
export function quickStartEntry(n, services = [], scan = null) {
  const want = Math.trunc(Number(n) || 0);
  if (!want) return null;
  return quickStartRows(services, scan).find((r) => r.n === want) || null;
}

/** What pressing a number may do. Never a restart, and never a command that
 *  cannot run on this machine.
 *
 *  `host` is what the caller measured about the box it is running on:
 *    `{ pm2: true | false | undefined }` — is the process manager here?
 *  `undefined` means "not measured yet" and behaves exactly as before; it never
 *  guesses. A paid install on Windows or macOS has no pm2 and hosts none of our
 *  services, so pressing 1-0 must say that in one line instead of spawning a
 *  binary that is not there and reporting its ENOENT (owner, 2026-11-26:
 *  "/menu on msi install all need to work on install").
 *
 *  Returns `{ cmd, args }` to run, or `{ skip }` with the reason to say back. */
export function startPlan(entry, host = {}) {
  if (!entry) return { skip: 'no such port number' };
  if (entry.up) {
    return { skip: `already online — not bouncing it (an update never drops a live session)` };
  }
  if (!entry.pm2) {
    return { skip: `no local start command — ${entry.name} runs on the Parrot box` };
  }
  if (host && host.pm2 === false) {
    return { skip: `pm2 is not installed on this machine — this CLI does not host our services here · /ports shows what is listening` };
  }
  return { cmd: 'pm2', args: ['start', String(entry.pm2)] };
}
