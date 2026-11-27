import { useEffect, useRef, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { haksterDir } from '../../../src/home-dir.js';

/* useBankDrift — does the OTHER box hold the same memories as this one?
 *
 * Owner (2026-11-27): "i always want the memory count correct and the same on
 * both boxes for better memory recalling … this box has 438 and lenonvo cli
 * says 437". useMemoryBank counts THIS box's disk — it cannot see that the
 * standby is behind. This hook asks the server (GET
 * /api/agent/memory-banks/health), which measures both boxes and returns each
 * one's real count plus the drift per bank file. The header then prints
 * `438/438` in green, or `438/437` in red, so a box that has fallen behind is
 * visible instead of silent.
 *
 * Nothing is guessed: an unreachable peer, a pending read, or a signed-out /
 * non-owner account all come back as `null` and the header simply shows the
 * local total it already had (§10, §13). Counts only — no bank text and no
 * account detail ever reach the render path.
 */
const DEFAULT_API = process.env.HAKSTER_API_URL || 'http://localhost:3579';

function configuredServer() {
  if (process.env.HAKSTER_API_URL) return String(process.env.HAKSTER_API_URL).replace(/\/+$/, '');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(haksterDir(), 'config.json'), 'utf8'));
    if (cfg && typeof cfg.server === 'string' && cfg.server) return cfg.server.replace(/\/+$/, '');
  } catch { /* fall through */ }
  return DEFAULT_API;
}

export default function useBankDrift(intervalMs = 60000, enabled = true) {
  const [state, setState] = useState({ localTotal: null, peerTotal: null, equal: null, peerLabel: null, restricted: false });
  const alive = useRef(true);
  const timer = useRef(null);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    const key = process.env.HAKSTER_API_KEY || '';
    if (!key) return undefined; // signed out: no read, nothing claimed

    const load = async () => {
      try {
        const res = await fetch(`${configuredServer()}/api/agent/memory-banks/health`, {
          headers: { 'x-api-key': key },
          cache: 'no-store',
        });
        if (!alive.current) return;
        // Owner-only route: a paid user's key reads 403 and the marker simply
        // does not render. That is a permission, not a fault (§34).
        if (res.status === 403 || res.status === 401) {
          setState((s) => ({ ...s, restricted: true, equal: null }));
          return;
        }
        const body = await res.json().catch(() => null);
        if (!alive.current || !body || typeof body !== 'object') return;
        const localTotal = body.local && Number.isFinite(body.local.total) ? body.local.total : null;
        const peerTotal = body.peer && body.peer.reachable === true && Number.isFinite(body.peer.total)
          ? body.peer.total
          : null;
        // The server compares every root (the box's banks and each per-user
        // set), so trust its verdict when it gives one; equal totals alone can
        // hide a user's banks being behind.
        const equal = peerTotal == null
          ? null
          : (typeof body.equal === 'boolean' ? body.equal : localTotal === peerTotal);
        setState({
          localTotal,
          peerTotal,
          equal,
          peerLabel: (body.peer && body.peer.label) || null,
          restricted: false,
        });
      } catch { /* unreachable server: keep the last honest reading */ }
    };

    load();
    const every = Math.max(15000, Number(intervalMs) || 60000);
    timer.current = setInterval(load, every);
    try { if (typeof timer.current.unref === 'function') timer.current.unref(); } catch { /* Bun timers */ }
    return () => {
      alive.current = false;
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [intervalMs, enabled]);

  return state;
}
