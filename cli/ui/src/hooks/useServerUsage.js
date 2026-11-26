import { useCallback, useEffect, useRef, useState } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { haksterDir } from '../../../src/home-dir.js';

/* useServerUsage — this ACCOUNT's usage, as the server records it.
 *
 * Owner 2026-11-23: "we need the cli to have usage page per user like claude
 * uses just exact", "for daily weekly usage", "live graphs refresh rate etc
 * scrape usage page".
 *
 * One source, the same one the website's account page reads: GET /api/usage
 * with the signed-in account's own key. Nothing is estimated here — every
 * number on the usage page is what the server's ledger returned, and a failure
 * is reported as a failure rather than shown as zero (§10).
 *
 * The refresh rate is the owner's, from the CLI's own prefs (usageRefresh,
 * seconds; 0 pauses). It is a poll, not a stream: the page is a measurement,
 * so a fixed cadence is honest and cheap.
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

export function useServerUsage(refreshSeconds = 15, enabled = true) {
  const [state, setState] = useState({ data: null, error: null, updatedAt: null, loading: true });
  const timerRef = useRef(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    const key = process.env.HAKSTER_API_KEY || '';
    const base = configuredServer();
    if (!key) {
      setState((s) => ({ ...s, loading: false, error: 'not signed in — run hakster login' }));
      return;
    }
    try {
      const res = await fetch(`${base}/api/usage`, {
        headers: { 'x-api-key': key },
        cache: 'no-store',
      });
      const body = await res.json().catch(() => null);
      if (!aliveRef.current) return;
      if (!res.ok || !body || typeof body !== 'object') {
        setState((s) => ({ ...s, loading: false, error: `usage unavailable (http ${res.status})` }));
        return;
      }
      setState({ data: body, error: null, updatedAt: Date.now(), loading: false });
    } catch (e) {
      if (!aliveRef.current) return;
      setState((s) => ({ ...s, loading: false, error: `usage unavailable (${(e && e.message) || 'network'})` }));
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    // Nothing is polled until the page is actually open: a usage poll is a
    // measurement, and a session that never shows the page must not pay for it.
    if (!enabled) return undefined;
    load();
    const every = Math.max(0, Number(refreshSeconds) || 0);
    if (timerRef.current) clearInterval(timerRef.current);
    if (every > 0) timerRef.current = setInterval(load, every * 1000);
    return () => {
      aliveRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [load, refreshSeconds, enabled]);

  return { ...state, refresh: load };
}
