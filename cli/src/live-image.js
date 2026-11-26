/* live-image.js — find and fetch the picture behind a live URL, for the viewer.
 *
 * Owner 2026-11-23: "we need the live image viewer in the output panels when
 * showing live url work". When a tool works a live URL and comes back with a
 * screenshot, an image link or an inline image, the output panel should show
 * the picture itself — not a truncated path.
 *
 * This module only ANSWERS THE QUESTION "is there an image here, and where is
 * it": it scans text for a local image path, an http(s) image URL or a data:
 * image, and materialises the one found into a local file the viewer can
 * transmit. It never invents a source (§10), never fetches anything that is
 * not an image, is bounded in time and size, and writes only into the CLI's
 * own cache directory.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { haksterDir } = require('./home-dir');
const crypto = require('crypto');

const CACHE_DIR = path.join(haksterDir(), 'cache', 'live');
const MAX_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;

const EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};

/** The extension a URL's pathnames carries, ignoring any query/fragment. */
function urlExt(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(EXT);
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : '';
  } catch {
    return '';
  }
}

/**
 * Scan text for the first image reference.
 * Returns { kind: 'file'|'url'|'data', ref, name } or null.
 * `kind: 'file'` ref is an absolute path that exists on disk.
 */
function findImageSource(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  for (const raw of list) {
    const text = String(raw == null ? '' : raw);
    if (!text) continue;

    // data: image (an inline screenshot) — bounded by MAX_BYTES when decoded.
    const data = text.match(/data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,([A-Za-z0-9+/=\s]+)/i);
    if (data) {
      const b64 = data[2].replace(/\s+/g, '');
      if (b64.length * 0.75 <= MAX_BYTES) {
        return { kind: 'data', ref: data[0], name: `inline.${data[1].toLowerCase().replace('jpeg', 'jpg')}` };
      }
    }

    // http(s) image URL.
    const url = text.match(/https?:\/\/[^\s"'<>()\]]+/gi) || [];
    for (const u of url) {
      const ext = urlExt(u);
      if (ext) return { kind: 'url', ref: u.replace(/[.,;]+$/, ''), name: path.basename(new URL(u.replace(/[.,;]+$/, '')).pathname) || `image.${ext}` };
    }

    // local absolute path (optionally prefixed with file://).
    const paths = text.match(/(?:file:\/\/)?\/[^\s"'<>()\]]+\.(?:png|jpe?g|webp|gif|bmp)\b/gi) || [];
    for (const p of paths) {
      const file = p.replace(/^file:\/\//, '');
      try {
        if (fs.existsSync(file) && fs.statSync(file).size <= MAX_BYTES) {
          return { kind: 'file', ref: file, name: path.basename(file) };
        }
      } catch {
        /* unreadable path: keep looking */
      }
    }
  }
  return null;
}

function cacheFile(ext) {
  return path.join(CACHE_DIR, `${crypto.createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 24)}.${ext}`);
}

function writeCache(buffer, ext) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  const file = cacheFile(ext);
  fs.writeFileSync(file, buffer, { mode: 0o600 });
  return file;
}

/**
 * Turn a source from findImageSource() into a local file.
 * Resolves { ok, file, name, reason? } — reason is for the panel when the URL
 * was not actually an image, was too big, or timed out. Never throws.
 */
async function materialize(source) {
  if (!source || !source.ref) return { ok: false, reason: 'no image' };
  if (source.kind === 'file') {
    try {
      const st = fs.statSync(source.ref);
      if (!st.isFile()) return { ok: false, reason: 'not a file' };
      if (st.size > MAX_BYTES) return { ok: false, reason: `too big (${Math.round(st.size / 1048576)} MB)` };
      return { ok: true, file: source.ref, name: source.name };
    } catch {
      return { ok: false, reason: 'file is gone' };
    }
  }
  if (source.kind === 'data') {
    try {
      const m = source.ref.match(/^data:image\/([a-z0-9]+);base64,(.*)$/i);
      if (!m) return { ok: false, reason: 'unreadable inline image' };
      const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      if (buf.length > MAX_BYTES) return { ok: false, reason: 'inline image too big' };
      return { ok: true, file: writeCache(buf, m[1].toLowerCase().replace('jpeg', 'jpg')), name: source.name };
    } catch (e) {
      return { ok: false, reason: (e && e.message) || 'inline image failed' };
    }
  }
  if (source.kind === 'url') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(source.ref, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { accept: 'image/*', 'user-agent': 'haksterai-cli (+https://haksterai.com)' },
      });
      if (!res.ok) return { ok: false, reason: `http ${res.status}` };
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = MIME_EXT[type] || urlExt(source.ref);
      if (!ext) return { ok: false, reason: `not an image (${type || 'unknown type'})` };
      const len = Number(res.headers.get('content-length') || 0);
      if (len && len > MAX_BYTES) return { ok: false, reason: `too big (${Math.round(len / 1048576)} MB)` };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) return { ok: false, reason: 'too big' };
      return { ok: true, file: writeCache(buf, ext), name: source.name || `image.${ext}` };
    } catch (e) {
      const reason = e && e.name === 'AbortError' ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : (e && e.message) || 'fetch failed';
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: 'unknown source' };
}

module.exports = { findImageSource, materialize, MAX_BYTES, CACHE_DIR };
