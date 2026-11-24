import { useEffect, useRef } from 'react';

/* useServerWatch — notice when the server goes away or comes back changed.
 *
 * The TUI already survives a server restart: the panel poll keeps its last good
 * reading and marks itself OFFLINE, and a turn in flight reconnects and resends
 * (useAgentStream). What it never said was *what happened* — an update the
 * server applied and restarted is the expected, good outcome, and it read
 * exactly like a crash from the outside (owner, 2026-11-24: "if server drops
 * after updates").
 *
 * The honest way to tell an update from a restart is the server's own build
 * stamp: a restart that installed something comes back on a new
 * `server.build`, a crash recovery comes back on the same one. That comparison
 * is also the *only* detector that catches the common case — PM2 respawns in
 * about a second, so a 3-second poll often never sees the port refuse at all.
 * So each tick reads the stamp alongside the status, and there are three
 * distinguishable events:
 *
 *   port dropped, stamp changed    → "server updated — restarted in Ns · build X"
 *   port dropped, stamp unchanged  → "server restarted — back in Ns · build X"
 *   stamp changed, no drop seen    → "server updated — now on build X"
 *                                    (no downtime is claimed: none was measured)
 *
 * Silence and truthfulness both matter: nothing is said while the server stays
 * up on the same build, no figure is invented when a reading is missing, and a
 * restart that lands mid-turn is left to the turn's own reconnect lines so the
 * operator reads one story instead of two.
 *
 * Cost: two small GETs per tick, and a re-render only when a transition
 * happens — never per tick. Ticks are 3 s while healthy and 1 s while down, so
 * a recovery is noticed on the next second rather than three seconds later.
 */

const HEALTHY_MS = 3000;
const DOWN_MS = 1000;
const REQUEST_MS = 4000;

const authHeaders = () =>
  (process.env.HAKSTER_API_KEY ? { 'x-api-key': process.env.HAKSTER_API_KEY } : {});

/** `2026-11-24T06:31:42.635Z` → `06:31:42`; anything unexpected is passed through. */
function shortBuild(build) {
  const raw = String(build || '');
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(raw);
  return m ? m[1] : raw.slice(0, 19);
}

/** Seconds with one decimal, the same shape the status bar's clock uses. */
const fmtSecs = (ms) => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;

const getJson = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(REQUEST_MS), headers: authHeaders() });
  if (!r.ok) return null;
  return r.json();
};

export function useServerWatch({ api, busy = false, onRecovered } = {}) {
  // Both inputs are read from inside a timer that outlives any render, so they
  // are mirrored here rather than captured in a closure.
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = !!busy; }, [busy]);
  const onRecoveredRef = useRef(onRecovered);
  useEffect(() => { onRecoveredRef.current = onRecovered; }, [onRecovered]);

  useEffect(() => {
    if (!api) return undefined;
    let alive = true;
    let timer = null;
    // `build` is the last stamp actually read; null means "not known yet",
    // which is why a first tick can never announce a change.
    const state = { down: false, downAt: 0, build: null };

    const tick = async () => {
      if (!alive) return;
      const [status, version] = await Promise.all([
        getJson(`${api}/api/tui/status`).catch(() => null),
        getJson(`${api}/api/version`).catch(() => null),
      ]);
      if (!alive) return;

      const ok = !!status;
      const build = version && version.server && version.server.build ? String(version.server.build) : null;
      const prevBuild = state.build;

      if (!ok) {
        if (!state.down) {
          state.down = true;
          state.downAt = Date.now();
        }
      } else {
        const wasDown = state.down;
        const downtimeMs = wasDown ? Date.now() - state.downAt : 0;
        state.down = false;
        if (build) state.build = build;
        // An update is claimed only when both readings exist and differ.
        const updated = !!(prevBuild && build && prevBuild !== build);

        if ((updated || wasDown) && typeof onRecoveredRef.current === 'function') {
          const text = updated
            ? `⬆ server updated — ${wasDown ? `restarted in ${fmtSecs(downtimeMs)}` : 'now on'} · build ${shortBuild(build)}`
            : `server restarted — back in ${fmtSecs(downtimeMs)}${build ? ` · build ${shortBuild(build)}` : ''}`;
          // A restart during a run is the turn's story to tell (useAgentStream
          // prints its own "reconnecting…" / "resending" lines); announcing it
          // twice would read as two separate failures. State is still updated
          // above, so the notice is not merely delayed into a duplicate later.
          if (!busyRef.current) onRecoveredRef.current({ updated, downtimeMs, build, text });
        }
      }

      if (alive) timer = setTimeout(tick, state.down ? DOWN_MS : HEALTHY_MS);
    };

    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api]);
}

export default useServerWatch;
