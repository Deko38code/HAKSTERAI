import { logger, task } from "@trigger.dev/sdk";

/**
 * A health sweep for the haksterAi server.
 *
 * The server already exposes GET /api/health, which answers
 * `{ status, version, checks, providers }`; the CLI and the agent's ops tools
 * read the same route. Running the check here instead means it happens on a
 * schedule in Trigger.dev rather than only when someone happens to look, and
 * every result lands in the run history.
 *
 * Three deliberate choices:
 *
 * 1. The task does NOT throw when the server is unhealthy. A monitor whose job
 *    is to report state should succeed in reporting "down" — throwing would make
 *    a healthy monitor indistinguishable from a broken one, and the retry would
 *    hammer a server that is already struggling. If you want the run itself to go
 *    red (so Trigger.dev's retries and failure alerts fire), throw inside `run`
 *    when `healthy` is false; the report is shaped so that is a one-line change.
 *
 * 2. `/api/health` answers **503** when it is degraded, and that is still a
 *    response from a live server. `reachable` therefore means "the server
 *    answered at all", and `healthy` is the narrower question of whether it
 *    reported `ok`. Collapsing the two would report a degraded-but-up server as
 *    down and throw away the `checks` detail that says which part failed.
 *    `error` is the reason the sweep is not healthy, so it is populated by a
 *    degraded 503 as well as by a connection failure.
 *
 * 3. `fetch` is the platform's built-in one. Nothing here needs node-fetch.
 */

/** Same convention the agent's ops tooling uses (see server/src/agent/index.js). */
const DEFAULT_SERVER_URL = "http://localhost:3579";

export type ServerHealthPayload = {
  /** Override the target, e.g. to point the sweep at a deployed instance. */
  serverUrl?: string;
};

export const serverHealth = task<"server-health", ServerHealthPayload>({
  id: "server-health",
  description: "Sweep the haksterAi server's /api/health and report reachability, status, checks and providers.",
  maxDuration: 60,
  retry: {
    maxAttempts: 2,
    minTimeoutInMs: 1_000,
    factor: 2,
  },
  run: async (payload, { ctx, signal }) => {
    const base = (payload?.serverUrl || process.env.HAKSTER_HOST || DEFAULT_SERVER_URL).replace(/\/+$/, "");
    const url = `${base}/api/health`;

    logger.info("checking server health", { url, runId: ctx.run.id });

    const startedAt = Date.now();
    let reachable = false;
    let httpStatus: number | null = null;
    let status: string | null = null;
    let version: string | null = null;
    let checks: Record<string, unknown> = {};
    let providers: string[] = [];
    let error: string | null = null;

    try {
      const res = await fetch(url, {
        // Whichever fires first: the run being cancelled, or the request hanging.
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });

      // It answered, whatever it said. A 503 from this route means degraded.
      reachable = true;
      httpStatus = res.status;

      const body = (await res.json().catch(() => null)) as
        | { status?: string; version?: string; checks?: unknown; providers?: unknown }
        | null;

      status = body?.status ?? null;
      version = body?.version ?? null;
      checks = body?.checks && typeof body.checks === "object" ? (body.checks as Record<string, unknown>) : {};
      providers = Array.isArray(body?.providers) ? body.providers.map(String) : [];

      if (!res.ok) {
        // Record why this sweep is not healthy. A structured 503 names its own
        // state; anything else still has a status code worth keeping.
        error = status ? `HTTP ${res.status} ${status}` : `HTTP ${res.status}`;
      }
    } catch (err) {
      // A refused connection, a DNS failure, a cancelled run and a timeout all
      // land here, and all of them mean the same thing to a monitor: unreachable.
      error = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Date.now() - startedAt;
    const healthy = reachable && httpStatus === 200 && status === "ok";
    const report = {
      server: base,
      url,
      reachable,
      healthy,
      httpStatus,
      status,
      version,
      checks,
      providerCount: providers.length,
      providers,
      latencyMs,
      error,
      checkedAt: new Date().toISOString(),
    };

    if (healthy) {
      logger.info("server is healthy", { status, providers: providers.length, latencyMs });
    } else if (reachable) {
      logger.warn("server is degraded", { httpStatus, status, checks, latencyMs });
    } else {
      logger.error("server is unreachable", { url, error, latencyMs });
    }

    return report;
  },
});
