'use strict';
/**
 * Live applet endpoints for production.
 *
 * The implementation is the same module the isolated preview runs
 * (dev/applet/stream.cjs) so there is exactly one source of truth for the
 * spinner/progress/stability feed. This file only bridges production auth:
 *
 *   GET  /api/applet/stream  text/event-stream, snapshots on change
 *   GET  /api/applet/status  one JSON snapshot (poll fallback / probes)
 *   POST /api/applet/event   applet lifecycle events -> project audit log
 *   GET  /api/applet/events  the audit log, owner scope only
 *
 * Auth is header-only (`x-api-key` / `Authorization: Bearer`), never a query
 * string, so a key cannot land in access logs, history or a Referer. No key
 * means public scope, which is read-only and cannot write audit events.
 */
const { mountAppletStream } = require('../../dev/applet/stream.cjs');

function mountApplet(app, deps) {
  return mountAppletStream(app, {
    getUserByKey: (key) => {
      if (!key || typeof key !== 'string') return null;
      try { return deps.getUserByKey(key) || null; } catch { return null; }
    },
    isOwner: (user) => {
      try { return Boolean(deps.isOwner(user)); } catch { return false; }
    },
  });
}

module.exports = { mountApplet };
