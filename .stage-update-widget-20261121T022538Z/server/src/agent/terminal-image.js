'use strict';

const fs = require('fs');
const path = require('path');

const SCREENSHOT_ROOT = '/tmp/hakster_screenshots';

function safeScreenshotPath(filename) {
  try {
    const root = fs.realpathSync(SCREENSHOT_ROOT);
    const resolved = fs.realpathSync(filename);
    if (!resolved.startsWith(root + path.sep)) return null;
    if (!/\.(png|jpe?g|webp)$/i.test(resolved)) return null;
    return resolved;
  } catch (_) {
    return null;
  }
}

/** Render a small truecolor thumbnail that works in ordinary ANSI terminals. */
async function renderSnapshotRows(filename, { maxWidth = 56, maxRows = 13 } = {}) {
  const safePath = safeScreenshotPath(filename);
  if (!safePath) return null;
  let sharp;
  try { sharp = require('sharp'); } catch (_) { return null; }

  const widthLimit = Math.max(1, Math.min(64, Math.floor(maxWidth)));
  const heightLimit = Math.max(2, Math.min(28, Math.floor(maxRows) * 2));
  try {
    const { data, info } = await sharp(safePath)
      .rotate()
      .flatten({ background: '#080b12' })
      .resize({ width: widthLimit, height: heightLimit, fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height || info.channels < 3) return null;

    const rows = [];
    for (let y = 0; y < info.height; y += 2) {
      let line = '';
      for (let x = 0; x < info.width; x++) {
        const top = (y * info.width + x) * info.channels;
        const bottomY = Math.min(y + 1, info.height - 1);
        const bottom = (bottomY * info.width + x) * info.channels;
        line += `\x1b[38;2;${data[top]};${data[top + 1]};${data[top + 2]}m` +
          `\x1b[48;2;${data[bottom]};${data[bottom + 1]};${data[bottom + 2]}m▀`;
      }
      rows.push(line + '\x1b[0m');
    }
    return { rows, width: info.width, height: info.height, path: safePath };
  } catch (_) {
    return null;
  }
}

module.exports = { renderSnapshotRows, safeScreenshotPath };
