import { useEffect, useRef, useState } from 'react';
import { appliedNotice, checkForUpdate, pendingInfo } from '../../../src/updater.js';
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
          checkedAt: pending.stagedAt,
        },
      };
    }
  } catch {
    /* no updater state: idle */
  }
  return { applied: null, status: { status: 'idle' } };
}

export default function useCliUpdate(intervalMs = 30 * 60 * 1000) {
  // Read the install/update facts exactly once — they describe this launch.
  const startup = useRef(null);
  if (startup.current === null) startup.current = readStartup();
  const applied = startup.current.applied;

  const [state, setState] = useState(startup.current.status);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // /settings updateCheck off stops the background check; a package already
      // staged stays visible and still applies on the next launch.
      if (prefs.load().updateCheck === false) return;
      setState((prev) =>
        prev.status === 'staged' || prev.status === 'blocked' || prev.status === 'applied' ? prev : { ...prev, status: 'checking' },
      );
      try {
        const res = await checkForUpdate();
        if (!alive) return;
        setState((prev) => {
          // The install confirmation outranks the network answer: this session
          // is running the version an earlier start installed.
          if (applied) return prev;
          return {
            status: res.status,
            version: res.version,
            blocked: res.blocked || (res.status === 'blocked' ? 'source-checkout' : undefined),
            reason: res.reason,
            checkedAt: res.checkedAt,
          };
        });
      } catch (e) {
        if (alive) setState({ status: 'error', reason: String((e && e.message) || e) });
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    try {
      if (typeof id.unref === 'function') id.unref();
    } catch {
      /* never let timer housekeeping break the check */
    }
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs, applied]);

  return { ...state, applied };
}
