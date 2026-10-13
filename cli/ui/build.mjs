#!/usr/bin/env node
/* Build the OpenTUI TUI source in ./src into a single ESM bundle.
 *
 * This is the build script `cli/package.json`'s `build:ui` script points at
 * ("cd ui && node build.mjs"). It was missing, which is why the source tree
 * could not be rebuilt.
 *
 *   node build.mjs              -> ../ui-fb.mjs   (the OpenTUI TUI)
 *   node build.mjs --out ../ui.mjs   # only if you mean to replace the
 *                                    # existing bundle — that file is the
 *                                    # working `hakster ui` TUI, so the
 *                                    # default deliberately does NOT touch it.
 *   node build.mjs --watch
 *
 * @opentui/core, @opentui/react and react are left external: they are resolved
 * from cli/node_modules at run time (under Bun), so the bundle stays small and
 * there is exactly one React instance (two would break hooks).
 */
import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const watch = args.includes('--watch');

function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const outfile = path.resolve(here, argValue('--out', '../ui-fb.mjs'));

const options = {
  entryPoints: [path.join(here, 'src', 'index.jsx')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  // Resolved from cli/node_modules at run time — see the note above.
  external: ['@opentui/core', '@opentui/react', 'react', 'react/jsx-runtime'],
  jsx: 'automatic',
  loader: { '.jsx': 'jsx', '.js': 'jsx' },
  // Don't walk up to the project's astro tsconfig — its `extends` cannot be
  // resolved from here and only produces a warning on every build.
  tsconfigRaw: '{}',
  sourcemap: false,
  minify: false, // keep it readable: this is meant to be edited
  banner: { js: '// Built by esbuild from ui/src — do not edit. Run: node ui/build.mjs' },
  logLevel: 'info',
};

// `hakster ui` loads ui.mjs, so replacing it by accident would break the
// existing TUI. Require the operator to say so explicitly.
if (path.basename(outfile) === 'ui.mjs' && !args.includes('--force')) {
  console.error(
    `\n  Refusing to overwrite ${path.basename(outfile)} without --force.\n` +
      `  That file is the existing \`hakster ui\` TUI and its source was lost,\n` +
      `  so a rebuild replaces it rather than updating it.\n\n` +
      `  To build the new TUI instead (default):  node build.mjs\n` +
      `  To really replace it:                   node build.mjs --out ../ui.mjs --force\n`
  );
  process.exit(1);
}

fs.mkdirSync(path.dirname(outfile), { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`watching ui/src -> ${path.relative(process.cwd(), outfile)}`);
} else {
  await build(options);
  const kb = (fs.statSync(outfile).size / 1024).toFixed(1);
  console.log(`built ${path.relative(path.join(here, '..'), outfile)} (${kb} kB)`);
}
