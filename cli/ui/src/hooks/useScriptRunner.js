import { useCallback, useEffect, useRef, useState } from 'react';
import { spawn } from 'node:child_process';
import { discoverScripts, snapshotBeforeRun } from '../utils/scripts.js';

/* useScriptRunner — run one discovered live script, streaming its output.
 *
 * Only a path `discoverScripts()` returned is ever executed; there is no
 * free-text command path here, so nothing typed into a chat box can reach this
 * runner. The child is bounded (2 min), killed on unmount, and its output is
 * capped — a runaway script must not be able to grow the panel or the process.
 *
 * `status` is one of idle | running | done | failed | stopped, which is exactly
 * what the snapshot window shows. No percentage is invented.
 */
const MAX_LINES = 400;
const TIMEOUT_MS = 120000;

/* Windows runs `npm` as `npm.cmd`, and Node refuses to spawn a `.cmd`/`.bat`
 * without a shell (EINVAL since the 2024 CVE fix). So on Windows the argv goes
 * through cmd.exe — quoted, because a checkout can sit under
 * `C:\Users\De ke\…` and an unquoted space would split the command. Every
 * other platform gets the argv exactly as `discoverScripts()` returned it.
 * Owner, 2026-11-26: "/menu on msi install all need to work on install" — the
 * live-scripts page spawned bare `npm`, which is not a file on Windows. */
function winQuote(a) {
  const s = String(a);
  return /[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function spawnSpec(run) {
  if (process.platform !== 'win32') return { cmd: run[0], args: run.slice(1), shell: false };
  return { cmd: winQuote(run[0]), args: run.slice(1).map(winQuote), shell: true };
}

export function useScriptRunner() {
  const [scripts] = useState(() => {
    try {
      return discoverScripts();
    } catch {
      return [];
    }
  });
  const [run, setRun] = useState({ status: 'idle', script: null, lines: [], startedAt: 0, endedAt: 0, exit: null });
  const procRef = useRef(null);
  const timerRef = useRef(null);
  const seq = useRef(0);

  const stop = useCallback(() => {
    const p = procRef.current;
    if (p) {
      procRef.current = null;
      try { p.kill('SIGTERM'); } catch { /* already gone */ }
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setRun((r) => (r.status === 'running' ? { ...r, status: 'stopped', endedAt: Date.now() } : r));
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const p = procRef.current;
    if (p) { try { p.kill('SIGTERM'); } catch { /* already gone */ } }
  }, []);

  const start = useCallback((entry) => {
    if (!entry || !Array.isArray(entry.run) || !entry.run.length) return false;
    stop();
    const id = ++seq.current;
    const startedAt = Date.now();
    // The source this run is about to execute — kept so the compare window can
    // say what changed since the previous run of the same script.
    snapshotBeforeRun(entry);
    setRun({ status: 'running', script: entry, lines: [], startedAt, endedAt: 0, exit: null });

    let child;
    try {
      const spec = spawnSpec(entry.run);
      child = spawn(spec.cmd, spec.args, { cwd: entry.cwd, env: process.env, shell: spec.shell, windowsHide: true });
    } catch (e) {
      setRun({ status: 'failed', script: entry, lines: [`spawn failed: ${(e && e.message) || e}`], startedAt, endedAt: Date.now(), exit: null });
      return true;
    }
    procRef.current = child;

    const push = (text) => {
      if (seq.current !== id) return; // a newer run owns the panel now
      const lines = String(text).replace(/\r/g, '').split('\n').filter((l, i, a) => l !== '' || i < a.length - 1);
      setRun((r) => (r.status === 'running' || r.status === 'stopped'
        ? { ...r, lines: [...r.lines, ...lines].slice(-MAX_LINES) }
        : r));
    };
    child.stdout?.on('data', (b) => push(b.toString()));
    child.stderr?.on('data', (b) => push(b.toString()));

    timerRef.current = setTimeout(() => {
      if (seq.current !== id) return;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      push(`◔ stopped after ${Math.round(TIMEOUT_MS / 1000)}s (the runner's cap)`);
    }, TIMEOUT_MS);

    child.on('error', (e) => {
      if (seq.current !== id) return;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      procRef.current = null;
      setRun((r) => ({ ...r, status: 'failed', endedAt: Date.now(), lines: [...r.lines, `error: ${(e && e.message) || e}`].slice(-MAX_LINES) }));
    });
    child.on('close', (code) => {
      if (seq.current !== id) return;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      procRef.current = null;
      setRun((r) => ({
        ...r,
        status: code === 0 ? 'done' : 'failed',
        exit: code,
        endedAt: Date.now(),
        lines: [...r.lines, `— exit ${code == null ? '?' : code} —`].slice(-MAX_LINES),
      }));
    });
    return true;
  }, [stop]);

  return { scripts, run, start, stop };
}

export default useScriptRunner;
