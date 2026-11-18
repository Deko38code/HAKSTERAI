/* HaksterAI service worker — installability only, no caching.
 *
 * Deliberately minimal:
 *   • No precache, no respondWith, no cache storage. Every request goes straight to
 *     the network exactly as it does without a service worker, so a bad deploy can
 *     never be pinned behind a stale cache.
 *   • The fetch listener exists only because browsers require a registered worker
 *     with a fetch handler before they offer the install prompt.
 *   • skipWaiting + clients.claim so a new version takes over immediately.
 *
 * If offline support is ever wanted, add it deliberately with a versioned cache and
 * a network-first strategy — do not turn this into a blind cache-first worker.
 */
'use strict';

const VERSION = 'haksterai-pwa-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // This worker creates no caches, so it only clears its own older generation and
    // never touches anything else stored on the origin.
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => /^haksterai-pwa-/.test(k) && k !== VERSION).map((k) => caches.delete(k))
      );
    } catch (e) { /* caches may be unavailable on http origins */ }
    try { await self.clients.claim(); } catch (e) {}
  })());
});

// Pass-through: presence of a fetch handler is what makes the app installable.
// Not calling respondWith() leaves the browser's normal network path untouched.
self.addEventListener('fetch', () => {});
