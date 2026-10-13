import { defineConfig } from "@trigger.dev/sdk";

/**
 * Trigger.dev configuration for haksterAi.
 *
 * `dirs` names ./src/trigger explicitly rather than relying on the automatic
 * `trigger` directory detection: `src/` is the Astro site's directory, and
 * making the task location load-bearing-but-implicit is how a later rename
 * silently stops shipping tasks.
 *
 * `maxDuration` is the project ceiling in compute seconds, and it is required.
 * It is deliberately high: this project already gives a single agent run five
 * minutes (see lib/rtrvr.ts), so a low ceiling here would silently cap the very
 * work it is being introduced for. Individual tasks should set their own, lower
 * `maxDuration` so the exception is visible next to the task.
 *
 * `retries.enabledInDev` is on so a failing run retries while developing, which
 * is the only place a retry can still be observed before deploy.
 *
 * `build.extensions` is empty on purpose — nothing here needs Prisma, a Python
 * runtime, or esbuild plugins yet. It is left in place because `@trigger.dev/build`
 * is installed and this is the only place its extensions are wired up.
 */
export default defineConfig({
  project: "proj_blejjdbnuczdtfoigoez",
  dirs: ["./src/trigger"],
  maxDuration: 3600,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 1_000,
      factor: 2,
    },
  },
  build: {
    extensions: [],
  },
  runtime: "node",
  logLevel: "info",
});
