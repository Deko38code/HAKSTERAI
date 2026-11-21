// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

// One build id per `astro build`, evaluated once here and injected into every
// page. The layout used to call `new Date()` while rendering each page, which
// stamped every page with a slightly different id (milliseconds apart) — that
// made the "update ready" toast fire falsely after a deploy. Live testing on
// 2026-11-16 caught it: /plans/ loaded ...05:25:31.320Z while /api/version
// reported ...05:25:31.345Z from the same build.
const BUILD_ID = new Date().toISOString();

// https://astro.build/config
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    define: {
      __HAKSTER_BUILD_ID__: JSON.stringify(BUILD_ID),
    },
  },
});
