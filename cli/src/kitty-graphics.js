/* kitty-graphics.js — real images in the CLI, via the kitty graphics protocol.
 *
 * Owner 2026-11-23: "add kitty graphics to". The kitty protocol (kitty,
 * Ghostty, WezTerm) lets a terminal show a PNG on a grid of cells; plain
 * terminals just paint nothing because every sequence is sent with q=2
 * (suppress errors). Nothing here changes the app when graphics are not
 * supported — the text UI stays exactly as it is.
 *
 * The image is transmitted once (`a=T,f=100,t=d,q=2,C=1`) in 4096-byte base64
 * chunks, placed at the current cursor cell with a negative z-index so text
 * painted over the same cells stays readable, and deleted by id on the way
 * out (`a=d,d=i`). No file is written, no network is used.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CHUNK_BYTES = 4096; // kitty's recommended maximum per escape sequence
const LOGO_ID = 0x484b; // "HK"

/** True when the terminal speaks the kitty graphics protocol. */
function isSupported(env = process.env, out = process.stdout) {
  try {
    if (!out || out.isTTY === false) return false;
    if (String(env.HAKSTER_GRAPHICS || '').toLowerCase() === 'off') return false;
    if (String(env.HAKSTER_GRAPHICS || '') === '1') return true;
    if (env.KITTY_WINDOW_ID) return true;
    if (/kitty/i.test(String(env.TERM || ''))) return true;
    const prog = String(env.TERM_PROGRAM || '').toLowerCase();
    return prog === 'ghostty' || prog === 'wezterm';
  } catch {
    return false;
  }
}

/** PNG dimensions from the IHDR chunk (width, height), or null. */
function pngSize(buffer) {
  try {
    if (buffer.length < 24) return null;
    if (buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/** The logo that ships with the CLI (committed asset, 256×256 PNG). */
function logoPath(explicit) {
  if (explicit) return explicit;
  // Bundled code has no meaningful __dirname; the CLI entry points publish the
  // real directory (HAKSTER_CLI_DIR), the same contract the updater uses.
  const root = process.env.HAKSTER_CLI_DIR || path.join(__dirname, '..');
  return path.join(root, 'assets', 'haksterai-logo.png');
}

/** The splash hero — the owner's neon-green hacker-desk artwork, dimmed so the
 *  decoding lines painted over it stay readable (owner, 2026-11-23). */
function heroPath(explicit) {
  if (explicit) return explicit;
  const root = process.env.HAKSTER_CLI_DIR || path.join(__dirname, '..');
  return path.join(root, 'assets', 'haksterai-hero.png');
}

/** The owner's hacker-theme backdrop (the same PNG his Guake drop-down paints
 *  behind the TUI). Owner, 2026-11-26: "i want that as my background in cli
 *  when users install our ... use that one dont change my startup" — an
 *  installed copy starts on this one; a source checkout keeps the hero. */
function backdropPath(explicit) {
  if (explicit) return explicit;
  const root = process.env.HAKSTER_CLI_DIR || path.join(__dirname, '..');
  return path.join(root, 'assets', 'haksterai-backdrop.png');
}

/** Which picture a start screen paints.
 *
 *  Owner, 2026-11-26: "i want that as my background in cli when users install
 *  our to the hacker theme image on startup use that one dont change my
 *  startup". An installed copy starts on the hacker-theme backdrop (the PNG
 *  the Guake profile paints behind the TUI); a source checkout — the owner's
 *  own dev tree (§8) — keeps the startup it has always had. A missing backdrop
 *  falls back to the hero, so the start screen always has artwork.
 */
function splashPath({ checkout = false, exists = null } = {}) {
  const has = typeof exists === 'function'
    ? exists
    : (f) => { try { return fs.existsSync(f); } catch { return false; } };
  try {
    if (!checkout && has(backdropPath())) return backdropPath();
  } catch {
    /* an unreadable asset dir keeps the hero */
  }
  return heroPath();
}

/**
 * Transmit + place an image at the cursor's current cell.
 * `cols`/`rows` are terminal cells; the terminal scales the image to fit.
 * Returns a summary, or null when the file is missing/unreadable.
 */
function placeImage({ file, cols = 24, rows = 12, id = LOGO_ID, zIndex = -1, write = (s) => process.stdout.write(s) } = {}) {
  let data;
  try {
    data = fs.readFileSync(file || logoPath());
  } catch {
    return null;
  }
  const b64 = data.toString('base64');
  const meta = `a=T,f=100,t=d,c=${cols},r=${rows},i=${id},z=${zIndex},C=1,q=2`;
  let chunks = 0;
  let first = true;
  for (let offset = 0; offset < b64.length; offset += CHUNK_BYTES) {
    const payload = b64.slice(offset, offset + CHUNK_BYTES);
    const more = offset + CHUNK_BYTES < b64.length ? 1 : 0;
    const controls = first ? `${meta},m=${more}` : `m=${more}`;
    write(`\x1b_G${controls};${payload}\x1b\\`);
    first = false;
    chunks += 1;
  }
  return { id, bytes: data.length, chunks, ...(pngSize(data) || {}) };
}

/** Remove one placed image (by id). */
function deleteImage(id = LOGO_ID, write = (s) => process.stdout.write(s)) {
  write(`\x1b_Ga=d,d=i,i=${id},q=2\x1b\\`);
}

/** Remove every image this program placed. */
function deleteAll(write = (s) => process.stdout.write(s)) {
  write('\x1b_Ga=d,d=a,q=2\x1b\\');
}

/** Move the terminal cursor (1-based) so the next placement lands there. */
function moveCursor(row, col, write = (s) => process.stdout.write(s)) {
  write(`\x1b[${Math.max(1, row)};${Math.max(1, col)}H`);
}

/**
 * Re-place an already-transmitted image at the cursor without sending the data
 * again. Repaints erase images from the cells they covered, so a live UI
 * re-places after each frame; this keeps that cheap (two short sequences).
 */
function placeById({ id = LOGO_ID, placementId = 1, zIndex = -1, write = (s) => process.stdout.write(s) } = {}) {
  write(`\x1b_Ga=p,i=${id},p=${placementId},z=${zIndex},C=1,q=2\x1b\\`);
}

/** Delete a placement but keep the transmitted image data (pairs with placeById). */
function deletePlacement({ placementId = 1, write = (s) => process.stdout.write(s) } = {}) {
  write(`\x1b_Ga=d,d=p,p=${placementId},q=2\x1b\\`);
}

module.exports = {
  CHUNK_BYTES,
  LOGO_ID,
  isSupported,
  pngSize,
  logoPath,
  heroPath,
  backdropPath,
  splashPath,
  placeImage,
  deleteImage,
  deleteAll,
  moveCursor,
  placeById,
  deletePlacement,
};
