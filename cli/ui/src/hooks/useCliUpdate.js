import { useEffect, useState } from 'react';
import { checkForUpdate, pendingInfo } from '../../../src/updater.js';
import prefs from '../../../src/prefs.js';

/* useCliUpdate — the Claude Code update model in the TUI: the running session
 * checks in the background, downloads and verifies a newer package into
 * ~/.hakster/updates, and the next launch applies it. Nothing is restarted
 * from here and nothing is written into a source checkout.
 *
 * State: { status: 'idle'|'checking'|'current'|'staged'|'blocked'|'error'|'unknown',
 *          version, reason, checkedAt }
 * A package staged by an earlier session is reported immediately, before the
 * first network check, so a restart that was pending shows up at once.
 */
export default function useCliUpdate(intervalMs = 30 * 60 * 1000) {
  const [state, setState] = useState(() => {
    try {
      const pending = pendingInfo();
      if (pending && pending.version) {
        return {
          status: pending.blocked ? 'blocked' : 'staged',
          version: pending.version,
          blocked: pending.blocked || undefined,
          checkedAt: pending.stagedAt,
        };
      }
    } catch {
      /* no updater state: idle */
    }
    return { status: 'idle' };
  });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // /settings updateCheck off stops the background check; a package already
      // staged stays visible and still applies on the next launch.
      if (prefs.load().updateCheck === false) return;
      setState((prev) => (prev.status === 'staged' || prev.status === 'blocked' ? prev : { ...prev, status: 'checking' }));
      try {
        const res = await checkForUpdate();
        if (!alive) return;
        setState({
          status: res.status,
          version: res.version,
          blocked: res.blocked || (res.status === 'blocked' ? 'source-checkout' : undefined),
          reason: res.reason,
          checkedAt: res.checkedAt,
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
  }, [intervalMs]);

  return state;
}
