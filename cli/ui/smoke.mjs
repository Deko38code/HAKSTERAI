#!/usr/bin/env bun
/* Render smoke test for the TUI — `npm run test:ui`.
 *
 * The TUI needs a real terminal, which a test runner does not have, so this
 * drives OpenTUI's test renderer against mocked server endpoints and asserts on
 * the captured frames. That is the only way to check the parts a unit test
 * cannot see — that the tree mounts, the ad rail actually fills from the ad
 * service, and a submitted prompt comes back through the stream and lands in the
 * transcript.
 *
 * The ad service is the harness's REAL one (server/src/ads.js), mounted on a
 * throwaway HTTP server rather than a stub, so a change that breaks the auction
 * route or the body parsing fails here. It is started before the bundle is
 * imported because src/ads/ad-client.js reads HAKSTER_ADS_URL once, at module
 * load — setting it afterwards would silently point the client at the default
 * port instead.
 *
 * This must run under Bun (not Node) because @opentui/core loads a native Zig
 * binary via Bun's FFI. The package.json script uses `bun ui/smoke.mjs`.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { mountAds } = require(path.join(here, '..', '..', 'server', 'src', 'ads.js'));

/** The smallest express-shaped surface `mountAds` actually uses. */
function makeApp() {
  const routes = [];
  const app = {
    get: (p, h) => routes.push({ method: 'GET', path: p, handler: h }),
    post: (p, h) => routes.push({ method: 'POST', path: p, handler: h }),
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        req.body = raw ? JSON.parse(raw) : null;
      } catch {
        req.body = null;
      }
      res.json = (obj) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      const { pathname } = new URL(req.url, 'http://127.0.0.1');
      const route = routes.find((r) => r.method === req.method && r.path === pathname);
      if (route) {
        route.handler(req, res);
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });

  return { app, server };
}

const { app, server } = makeApp();
mountAds(app);

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
process.env.HAKSTER_ADS_URL = `http://127.0.0.1:${port}`;

const outfile = path.join(here, '__smoke__', '.render.bundle.mjs');

await build({
  entryPoints: [path.join(here, '__smoke__', 'render.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  // Left external so there is one React instance and hooks are not duplicated.
  external: ['@opentui/core', '@opentui/react', 'react', 'react/jsx-runtime'],
  jsx: 'automatic',
  // Don't inherit the project's astro tsconfig — see ui/build.mjs.
  tsconfigRaw: '{}',
  logLevel: 'warning',
});

const { run } = await import(pathToFileURL(outfile).href);

try {
  const failed = await run({ adsPort: port });
  server.close();
  process.exit(failed ? 1 : 0);
} catch (err) {
  server.close();
  console.error(err);
  process.exit(1);
}