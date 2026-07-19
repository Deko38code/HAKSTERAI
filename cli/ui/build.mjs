#!/usr/bin/env node
// Build the haksterAi TUI (Ink/React JSX → ESM .mjs)
import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.jsx'],
  bundle: true,
  format: 'esm',
  outfile: '../ui.mjs',
  jsx: 'automatic',
  platform: 'node',
  target: 'node22',
  external: ['react', 'ink'],
  banner: { js: '// Built by esbuild — do not edit. Run: node build.mjs' },
});

console.log('✓ Built ui.mjs');