/* The startup backdrop: installed copies start on the hacker-theme picture.
 *
 * Owner, 2026-11-26: "so what about the backsplash on startup i want that as my
 * backgound in cli when users install our to the hacker theme image on startup
 * use that one dont change my startup".
 *
 * Pinned here:
 *   1. an installed copy paints `assets/haksterai-backdrop.png` — the same
 *      picture the Guake profile puts behind the TUI;
 *   2. a source checkout (the owner's own dev tree, §8) keeps the hero it has
 *      always had — his startup is not changed;
 *   3. a missing backdrop falls back to the hero, so the start screen always
 *      carries artwork and never goes blank;
 *   4. both pictures ship in the package, with a half-block grid each, so a
 *      terminal without Kitty graphics still shows the right one;
 *   5. DecodeSplash uses the chosen file for the image AND for the art grid —
 *      one picture, both paint paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', '..');
const ASSETS = path.join(CLI, 'assets');
const SPLASH = path.join(here, '..', 'src', 'components', 'DecodeSplash.jsx');
const graphics = require(path.join(CLI, 'src', 'kitty-graphics.js'));

test('an installed copy starts on the hacker-theme backdrop', () => {
  const file = graphics.splashPath({ checkout: false });
  assert.equal(path.basename(file), 'haksterai-backdrop.png');
  assert.ok(fs.existsSync(file), 'the backdrop ships with the package');
  // It is the same picture the Guake drop-down paints — not a second artwork.
  assert.equal(path.resolve(file), path.join(ASSETS, 'haksterai-backdrop.png'));
});

test('a source checkout keeps the startup it has always had', () => {
  const file = graphics.splashPath({ checkout: true });
  assert.equal(path.basename(file), 'haksterai-hero.png');
  assert.ok(fs.existsSync(file));
});

test('a missing backdrop falls back to the hero, never to nothing', () => {
  const file = graphics.splashPath({ checkout: false, exists: () => false });
  assert.equal(path.basename(file), 'haksterai-hero.png');
});

test('both pictures carry a half-block grid for terminals without Kitty graphics', () => {
  for (const [png, from] of [
    ['haksterai-hero.png', 'haksterai-hero.png'],
    ['haksterai-backdrop.png', 'haksterai-backdrop.png'],
  ]) {
    const out = path.join(ASSETS, png.replace(/\.png$/i, '.art.json'));
    assert.ok(fs.existsSync(out), `${path.basename(out)} ships`);
    const json = JSON.parse(fs.readFileSync(out, 'utf8'));
    const px = Buffer.from(String(json.rgbBase64 || ''), 'base64');
    assert.equal(px.length, json.width * json.height * 3, `${path.basename(out)} is a complete RGB grid`);
    assert.equal(json.generatedFrom, `assets/${from}`, 'each grid names the picture it came from');
    // Fine enough to never be upscaled on screen (the splash draws at most
    // 120 columns x 90 pixel rows), so a cell always picks a real pixel.
    assert.ok(json.width >= 120 && json.height >= 90,
      `${path.basename(out)} is at least as fine as the box it is drawn in (${json.width}x${json.height})`);
    // The owner's ask is that the artwork reads clear behind the rain. A grid
    // whose blacks have been lifted into grey haze is what looks blurry, so the
    // measurement is pinned: at least a sixth of the picture is true black and
    // the tone keeps real contrast. (Shipped before 2026-11-26: 9.2 % / 0.71.)
    let dark = 0;
    let sum = 0;
    let sum2 = 0;
    const n = json.width * json.height;
    for (let i = 0; i < n; i += 1) {
      const l = 0.2126 * px[i * 3] + 0.7152 * px[i * 3 + 1] + 0.0722 * px[i * 3 + 2];
      if (l < 8) dark += 1;
      sum += l;
      sum2 += l * l;
    }
    const mean = sum / n;
    const contrast = Math.sqrt(Math.max(0, sum2 / n - mean * mean)) / (mean || 1);
    assert.ok(dark / n >= 0.15, `${path.basename(out)} keeps true blacks (${(100 * dark / n).toFixed(1)}%)`);
    assert.ok(contrast >= 0.84, `${path.basename(out)} keeps its contrast (${contrast.toFixed(2)})`);
  }
  // One generator produces both, so they cannot drift in shape or correction.
  const gen = fs.readFileSync(path.join(CLI, 'scripts', 'make-hero-art.mjs'), 'utf8');
  assert.ok(gen.includes("arg('src'") && gen.includes("arg('out'"),
    'the art generator takes the picture and the output path');
});

test('DecodeSplash paints the chosen picture on both paths', () => {
  const src = fs.readFileSync(SPLASH, 'utf8');
  assert.ok(/import \{[^}]*splashPath[^}]*\} from '\.\.\/\.\.\/\.\.\/src\/kitty-graphics\.js'/.test(src),
    'the splash asks kitty-graphics which picture to paint');
  assert.ok(/checkout = isSourceCheckout\(\)/.test(src), 'a checkout is detected, not assumed');
  assert.ok(/return splashPath\(\{ checkout \}\)/.test(src), 'the choice is made by the tested helper');
  assert.ok(/placeImage\(\{ file: imageFile,/.test(src), 'the image is placed from that file');
  assert.ok(/<HeroBackdrop[\s\S]{0,200}imageFile=\{imageFile\}/.test(src), 'the half-block art uses the same file');
  assert.ok(/png\.replace\(\/\\\.png\$\/i, '\.art\.json'\)/.test(src),
    'the grid is derived from the picture, not hardcoded to the hero');
});

test('the package ships the assets directory', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(CLI, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('assets/'), 'npm install -g carries assets/');
  const route = fs.readFileSync(path.join(CLI, '..', 'server', 'src', 'index.js'), 'utf8');
  const at = route.indexOf("app.get('/cli/pkg.tar.gz'");
  assert.ok(at >= 0, 'the package route exists');
  const tarball = route.slice(at).split('tar.on')[0];
  assert.ok(/\n\s*'cli',/.test(tarball), 'the tarball is the whole cli dir');
  for (const bad of ['--exclude=*.png', '--exclude=*.json', '--exclude=assets']) {
    assert.ok(!tarball.includes(bad), `nothing excludes the artwork (${bad})`);
  }
});

test('the artwork is painted clean — the rain never burns through it', () => {
  const src = fs.readFileSync(SPLASH, 'utf8');
  const start = src.indexOf('function HeroBackdrop(');
  const end = src.indexOf('/** Fit the art inside a box');
  assert.ok(start > 0 && end > start, 'the HeroBackdrop renderer was found');
  const body = src.slice(start, end);
  assert.ok(body.includes('const fg = grid.px[r * 2 * cols + c]'), 'every cell is the picture\'s own pixel');
  assert.ok(!/RAIN_GLYPHS|RAIN_COLORS|rainColumns/.test(body),
    'no rain glyph or colour is composited into the artwork');

  // The grid is already an average of the picture; averaging it a second time
  // on screen is exactly what made the artwork look blurry.
  const sampler = src.slice(src.indexOf('function sampleArt('), src.indexOf('function HeroBackdrop('));
  assert.ok(sampler.includes('Math.floor(c * stepX + stepX / 2)'), 'a cell takes the grid pixel at its centre');
  assert.ok(!sampler.includes('wsum'), 'the grid is not averaged a second time — that double blur was the blur');
  assert.ok(sampler.includes('_gridCache'), 'the sample is computed once per size, not on every repaint');
});

test('the Matrix rain runs on every start screen — it is the owner\'s matrix', () => {
  const src = fs.readFileSync(SPLASH, 'utf8');
  assert.ok(/<MatrixRain width=\{width\} height=\{height\} frame=\{frame\} \/>/.test(src),
    'the full-screen rain renders unconditionally');
  assert.ok(!/heroAsset \? null : <MatrixRain/.test(src),
    'no path skips the rain (owner, 2026-11-26: "keep my matrix")');
  // It still paints behind the content and behind the picture.
  const rain = src.indexOf('<MatrixRain');
  const art = src.indexOf('<HeroBackdrop');
  const content = src.indexOf('position: \'absolute\'', rain);
  assert.ok(rain > 0 && art > rain, 'the picture is drawn over the rain, not under it');
  assert.ok(content > rain, 'the decoded lines are drawn last');
});
