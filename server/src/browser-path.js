'use strict';
/* Which Chrome/Chromium this box should drive.
 *
 * Owner, 2026-11-25: "fix the puppeteer". The env carried a single absolute
 * path (/root/.cache/puppeteer-ghost/chrome/linux-151.0.7922.47/...) that did
 * not exist on EITHER box, and /root is not readable by the app's own user.
 * The two boxes also keep their browser somewhere different — the Dell on
 * Mint's /usr/bin/chromium, the Lenovo on Chrome for Testing at
 * /opt/google/chrome/chrome — so no single env value can serve both.
 *
 * So the path is resolved where it is used: the configured value wins only if
 * it is actually executable here, otherwise the first local candidate is used,
 * and if none exists the answer is null so puppeteer resolves its own bundled
 * browser as it normally would. Nothing is installed and no env is rewritten.
 */
const fs = require('node:fs');

const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium',
];

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

let resolved = false;
let resolvedPath = null;

/** Absolute path of the browser to launch, or null to let puppeteer decide. */
function resolveBrowserPath() {
  if (resolved) return resolvedPath;
  resolved = true;

  const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configured && isExecutable(configured)) {
    resolvedPath = configured;
    return resolvedPath;
  }
  if (configured) {
    console.warn(
      `[browser] PUPPETEER_EXECUTABLE_PATH is set but not executable here (${configured}) - resolving a local browser instead`
    );
  }
  for (const p of CANDIDATES) {
    if (isExecutable(p)) {
      resolvedPath = p;
      return resolvedPath;
    }
  }
  resolvedPath = null;
  return resolvedPath;
}

module.exports = { resolveBrowserPath, CANDIDATES };
