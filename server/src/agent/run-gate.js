'use strict';

const os = require('os');

/**
 * Run gate — bounds how many agent turns run at the same time, and how many
 * turns one account may run at once.
 *
 * Why this exists (measured on this Dell, 2026-11-26): one claude-cli turn
 * costs about 635 MB — 247 MB for `claude -p` plus 388 MB for the six core MCP
 * servers it starts (filesystem, phantom, hakster, sqlite, memory,
 * sequential-thinking — ~80 MB each). The box has 7.8 GB with ~2.6 GB already
 * held by the other services and the desktop, so the fifth concurrent turn is
 * what pushes it into swap — and once it swaps, every session lags, not just
 * the extra one. That is the "lagging with multiple users" report.
 *
 * Queuing the excess keeps the turns that ARE running fast, instead of making
 * them all slow. Nothing here decides what a turn does: no model, route,
 * provider, plan or allowance is involved (CLAUDE.md §19.3, §22.4, §26) — the
 * gate only decides *when* a turn may start.
 *
 * Fairness rules:
 *   - FIFO by arrival, so nobody is starved by luck.
 *   - One account may hold at most `maxPerUser` slots; a head-of-line account
 *     already at its cap is skipped so it cannot block other users.
 *   - A waiter that never gets a slot is rejected with `queue-timeout` rather
 *     than hanging forever (§10: a held request is reported, never faked).
 */

/**
 * How many turns this machine can actually hold.
 * Derived from the hardware at boot — literals, not environment variables, so
 * a stray env change cannot quietly raise the ceiling (CLAUDE.md §22.4's
 * spirit: closed values, not tunables).
 */
function deriveLimits(opts = {}) {
  const cores = Number(opts.cpus) > 0 ? Number(opts.cpus) : 2;
  const memMb = Number(opts.totalMemMb) > 0 ? Number(opts.totalMemMb) : 4096;

  // A turn is memory-heavy but only bursty on CPU. Holding roughly one turn
  // per two cores keeps the event loop responsive while MCP children start.
  const byCores = Math.max(1, Math.floor(cores / 2) + 1);
  // ~700 MB per turn, and never spend the last 2 GB the rest of the box needs
  // (PM2 services, desktop, the operator's own session).
  const byMemory = Math.max(1, Math.floor((memMb - 2048) / 700));

  return {
    maxConcurrent: Math.max(1, Math.min(4, byCores, byMemory)),
    // Two surfaces (CLI + a browser tab) is a real workflow; three at once from
    // one account is a runaway loop.
    maxPerUser: 2,
  };
}

function createRunGate(opts = {}) {
  const derived = deriveLimits({ cpus: opts.cpus, totalMemMb: opts.totalMemMb });
  const maxConcurrent = Math.max(1, Number(opts.maxConcurrent) || derived.maxConcurrent);
  const maxPerUser = Math.max(1, Number(opts.maxPerUser) || derived.maxPerUser);
  const maxWaitMs = Number(opts.maxWaitMs) > 0 ? Number(opts.maxWaitMs) : 300000;

  let active = 0;
  const perUser = new Map(); // userId -> slots held
  const queue = [];          // [{ userId, resolve, reject, at, timer }]

  function state() {
    return { active, queued: queue.length, maxConcurrent, maxPerUser, maxWaitMs };
  }

  function canGrant(userId) {
    if (active >= maxConcurrent) return false;
    if (userId && (perUser.get(userId) || 0) >= maxPerUser) return false;
    return true;
  }

  function grant(waiter) {
    if (waiter.timer) clearTimeout(waiter.timer);
    active += 1;
    if (waiter.userId) perUser.set(waiter.userId, (perUser.get(waiter.userId) || 0) + 1);

    let released = false;
    const release = () => {
      // Idempotent: `close` and our own finally can both fire.
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      if (waiter.userId) {
        const left = (perUser.get(waiter.userId) || 1) - 1;
        if (left <= 0) perUser.delete(waiter.userId);
        else perUser.set(waiter.userId, left);
      }
      pump();
    };
    waiter.resolve(release);
  }

  /** Hand out free slots to the earliest waiters that fit. */
  function pump() {
    let granted = true;
    while (granted && active < maxConcurrent) {
      granted = false;
      for (let i = 0; i < queue.length; i += 1) {
        const w = queue[i];
        if (canGrant(w.userId)) {
          queue.splice(i, 1);
          grant(w);
          granted = true;
          break;
        }
      }
    }
  }

  /**
   * Take a slot. Resolves with an idempotent `release`; rejects with
   * `code: 'queue-timeout'` if no slot opened up within `maxWaitMs`.
   * `onQueued` is called once, only when the caller actually has to wait — it
   * is a UI hook and a throw inside it never breaks the gate.
   */
  function acquire(opts2 = {}) {
    const userId = opts2.userId ? String(opts2.userId) : null;
    const onQueued = typeof opts2.onQueued === 'function' ? opts2.onQueued : null;

    return new Promise((resolve, reject) => {
      if (canGrant(userId)) {
        grant({ userId, resolve, reject, timer: null });
        return;
      }

      const waiter = { userId, resolve, reject, at: Date.now(), timer: null };
      waiter.timer = setTimeout(() => {
        const i = queue.indexOf(waiter);
        if (i >= 0) queue.splice(i, 1);
        const err = new Error('All agent slots are busy right now. Please try again in a moment.');
        err.code = 'queue-timeout';
        reject(err);
      }, maxWaitMs);
      if (waiter.timer.unref) waiter.timer.unref();
      queue.push(waiter);

      if (onQueued) {
        try {
          onQueued({
            position: queue.length,
            ahead: queue.length - 1,
            active,
            maxConcurrent,
          });
        } catch { /* the caller's UI hook must never break admission */ }
      }
    });
  }

  return { acquire, state };
}

// ── One shared instance for the whole server ──────────────────────────────
// index.js and providers.js both admit through this, so the ceiling is one
// number for the process: an agent run and a web chat turn compete for the same
// slots instead of each holding its own private budget.
const agentRunGate = createRunGate({
  cpus: os.cpus().length,
  totalMemMb: Math.round(os.totalmem() / 1048576),
});

module.exports = { createRunGate, deriveLimits, agentRunGate };
