import { useEffect, useRef, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { appliedNotice, applyPending, checkForUpdate, isSourceCheckout, pendingInfo, cliDirOf } from '../../../src/updater.js';
import prefs from '../../../src/prefs.js';

/* useCliUpdate — the Claude Code update model in the TUI: the running session
 * checks in the background, downloads and verifies a newer package into
 * ~/.hakster/updates, and the next launch applies it. Nothing is restarted
 * from here and nothing is written into a source checkout.
 *
 * State: { status: 'idle'|'checking'|'current'|'staged'|'blocked'|'error'|'unknown',
 *          version, reason, checkedAt, applied }
 *
 * Owner, 2026-11-24: "need our updates to show when updates have been installed
 * upon starting cli". `applied` is that confirmation — `{ version, from,
 * appliedAt }` when the CLI on disk was installed by an earlier start (see
 * appliedNotice in src/updater.js). It is read once, at mount, and never
 * overwritten by the background check, so the start screen can say "updated
 * from vX" for the whole session.
 *
 * A stage that is byte-identical to the running build is NOT an update — it is
 * this CLI. Reporting it as 'staged' every launch was the old lie; it is
 * 'current' now (updater.pendingInfo().isCurrent).
 */
function readStartup() {
  try {
    const applied = appliedNotice();
    const pending = pendingInfo();
    if (applied) {
      return { applied, status: { status: 'applied', version: applied.version, from: applied.from, checkedAt: applied.appliedAt } };
    }
    if (pending && pending.version) {
      // A record taken when this install's own version could not be read
      // describes no update — it was written as "newer than 0.0.0". Painting a
      // badge from it is how the Dell's header claimed "pull to update" on an
      // already-current tree (owner, 2026-11-26). Say nothing instead (§10).
      if (pending.unknown) return { applied: null, status: { status: 'idle' } };
      // A leftover record from a version already behind this install is not a
      // pending update: it would announce a downgrade in the header and offer to
      // install one on the next start.
      if (pending.isCurrent || pending.superseded) {
        return {
          applied: null,
          status: { status: 'current', version: pending.runningVersion || pending.version, checkedAt: pending.stagedAt },
        };
      }
      return {
        applied: null,
        status: {
          status: pending.blocked ? 'blocked' : 'staged',
          version: pending.version,
          blocked: pending.blocked || undefined,
          // How many commits the published build was ahead when this stage was
          // taken (owner, 2026-11-26: "say in tui how many commits is behind
          // before installs like hermes").
          behind: Number(pending.behind) > 0 ? Number(pending.behind) : 0,
          checkedAt: pending.stagedAt,
        },
      };
    }
  } catch {
    /* no updater state: idle */
  }
  return { applied: null, status: { status: 'idle' } };
}

/* How often to check, from `updateCheckMinutes` (default 15). Owner, 2026-11-26:
 * "lets make the update check faster then 30 min" → 15. The check is a single
 * small GET of /cli/latest.json while the install is current, so the interval is
 * cheap to shorten; an explicit argument still wins, and anything unreadable
 * falls back to the default rather than to no check at all. Clamped to 1–240
 * minutes so a typo cannot poll the door every second or stop checks entirely. */
const DEFAULT_CHECK_MINUTES = Number(prefs.load().updateCheckMinutes) || 15;
function resolveIntervalMs(explicitMs) {
  const given = Number(explicitMs);
  if (Number.isFinite(given) && given > 0) return given;
  let mins = Number(prefs.load().updateCheckMinutes);
  if (!Number.isFinite(mins) || mins <= 0) mins = DEFAULT_CHECK_MINUTES;
  mins = Math.min(240, Math.max(1, mins));
  // A small per-session jitter keeps many CLIs from firing in lockstep.
  const jitter = Math.round((Math.random() - 0.5) * 20000);
  return mins * 60 * 1000 + jitter;
}

export default function useCliUpdate(intervalMs = null, sessionVersion = '') {
  // Read the install/update facts exactly once — they describe this launch.
  const startup = useRef(null);
  if (startup.current === null) startup.current = readStartup();
  // Fixed for the life of the session, jitter included, so a re-render never
  // resets the timer and two sessions never fire in lockstep.
  const tickMs = useRef(0);
  if (!tickMs.current) tickMs.current = resolveIntervalMs(intervalMs);
  const applied = startup.current.applied;

  const [state, setState] = useState(startup.current.status);

  // ── The code on disk is newer than the code this session started on ───────
  // Owner, 2026-11-25: "his cli updates arent installing when cli starts and
  // dosnt say installed restart cli to see changes". On this box the CLI runs
  // from its source checkout, where a stage is never written over a git tree
  // (§8) — so the update that lands is the tree itself, and the only thing
  // that makes it take effect is restarting the CLI. This compares the version
  // this session loaded (`sessionVersion`, fixed at start) with the version on
  // disk right now, and reports the honest state: installed, restart to see it.
  const diskNewer = () => {
    try {
      if (!sessionVersion) return null;
      // A source checkout never has anything installed into it (§8) — the tree
      // changing under a running session is the developer editing, not an
      // update landing. Owner, 2026-11-26 ("dont dell auto install on its own";
      // "it says it already on dell up top") — so the Dell's header stays clean
      // and no "Update installed" reaches a checkout.
      if (isSourceCheckout()) return null;
      // package.json only: this runs on a short interval, so it must stay
      // cheap (no bundle hashing on the render loop's timer).
      const diskVersion = String(
        JSON.parse(fs.readFileSync(path.join(cliDirOf(), 'package.json'), 'utf8')).version || '',
      );
      if (!diskVersion || diskVersion === sessionVersion) return null;
      // A downgrade is not "installed": it is an older tree, and saying so
      // would invite a restart that loses features.
      const pa = diskVersion.split('.').map((n) => parseInt(n, 10) || 0);
      const pb = String(sessionVersion).split('.').map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        if ((pa[i] || 0) === (pb[i] || 0)) continue;
        return (pa[i] || 0) > (pb[i] || 0) ? { version: diskVersion, from: sessionVersion } : null;
      }
      return null;
    } catch {
      return null;
    }
  };

  // The badge has to appear while the operator is looking at the screen, not
  // half an hour later: the on-disk version is compared every few seconds.
  useEffect(() => {
    if (!sessionVersion) return undefined;
    const probe = () => {
      const onDisk = diskNewer();
      if (!onDisk) return;
      setState((prev) => (prev.status === 'installed'
        ? prev
        : { status: 'installed', version: onDisk.version, from: onDisk.from, checkedAt: new Date().toISOString() }));
    };
    probe(); // the start of a session is exactly when this is most likely true
    const id = setInterval(probe, 5000);
    try {
      if (typeof id.unref === 'function') id.unref();
    } catch {
      /* timer housekeeping must never break the header */
    }
    return () => clearInterval(id);
  }, [sessionVersion]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // A newer build already on disk outranks any network answer: it is the
      // only state where a restart alone changes what this CLI runs.
      const onDisk = diskNewer();
      if (onDisk) {
        if (alive) setState({ status: 'installed', version: onDisk.version, from: onDisk.from, checkedAt: new Date().toISOString() });
        return;
      }
      // /settings updateCheck off stops the background check; a package already
      // staged stays visible and still applies on the next launch.
      if (prefs.load().updateCheck === false) return;
      setState((prev) =>
        prev.status === 'staged' || prev.status === 'blocked' || prev.status === 'applied' || prev.status === 'installed'
          ? prev
          : { ...prev, status: 'checking' },
      );
      try {
        const res = await checkForUpdate();
        if (!alive) return;
        // Claude-Code behaviour (owner, 2026-11-26: "need ours auto like claude
        // does says update installed restart cli"). A verified stage is installed
        // right away, inside the running session, so the only step left is a
        // restart — which is what the badge says. A source checkout is refused by
        // the updater itself (§8), so nothing is ever written there.
        let installedNow = null;
        if (res.status === 'staged' && !applied) {
          try {
            const a = applyPending();
            if (a && a.applied) installedNow = a;
            // A stage whose dependencies changed cannot be swapped in by copy
            // alone; say so (with the installer as the fix) rather than promise
            // an install on restart that would not happen.
            else if (a && a.reason && /dependenc/i.test(String(a.reason))) {
              installedNow = { needsInstall: true };
            }
          } catch {
            /* keep the stage — the next start can still apply it */
          }
        }
        setState((prev) => {
          // The install confirmation outranks the network answer: this session
          // is running the version an earlier start installed.
          if (applied) return prev;
          // Nor does a later check talk over a newer build already on disk.
          if (prev.status === 'installed' && diskNewer()) return prev;
          if (installedNow && installedNow.applied) {
            return {
              status: 'installed',
              version: installedNow.version,
              from: installedNow.from,
              checkedAt: new Date().toISOString(),
            };
          }
          if (installedNow && installedNow.needsInstall) {
            return {
              status: 'staged', version: res.version, needsInstall: true,
              behind: Number(res.behind) > 0 ? Number(res.behind) : 0,
              checkedAt: res.checkedAt,
            };
          }
          return {
            status: res.status,
            version: res.version,
            blocked: res.blocked || (res.status === 'blocked' ? 'source-checkout' : undefined),
            reason: res.reason,
            // Commits the published build is ahead of this install, counted from
            // the stamps (unknown reads 0, never a guess — §10).
            behind: Number(res.behind) > 0 ? Number(res.behind) : 0,
            checkedAt: res.checkedAt,
          };
        });
      } catch (e) {
        if (alive) setState({ status: 'error', reason: String((e && e.message) || e) });
      }
    };
    tick();
    const id = setInterval(tick, tickMs.current);
    try {
      if (typeof id.unref === 'function') id.unref();
    } catch {
      /* never let timer housekeeping break the check */
    }
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs, applied, sessionVersion]);

  return { ...state, applied };
}
