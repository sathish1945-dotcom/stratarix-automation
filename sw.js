/**
 * AI Life Manager service worker.
 *
 * Scope of what this file really does:
 *  - Keeps the interface shell available offline (so a dropped connection shows
 *    the app plus an "offline" banner instead of a browser error page).
 *  - Never caches API traffic: tasks, chat and auth always go to the network, so
 *    a stale task list can never be shown as if it were current.
 *  - Handles notification clicks (focus or open the app on the Tasks screen).
 *  - Contains `push` / `pushsubscriptionchange` handlers ready for Web Push.
 *    Web Push delivery is NOT active in this deployment: it needs VAPID keys and
 *    a server-side scheduler, and /api/push/config reports `enabled: false`
 *    until those exist. Nothing here claims otherwise.
 */

const VERSION = 'v1';
const SHELL_CACHE = `stratarix-shell-${VERSION}`;
const ASSET_CACHE = `stratarix-assets-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './offline.html',
  './styles.css',
  './manifest.webmanifest',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './js/main.js',
  './js/api.js',
  './js/state.js',
  './js/ui.js',
  './js/notifications.js',
  './js/views/marketing.js',
  './js/views/auth.js',
  './js/views/tasks.js',
  './js/views/chat.js',
  './js/views/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('stratarix-') && key !== SHELL_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isCacheable(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheable(request)) return;

  // Navigations: always try the network first so a new deployment is picked up
  // immediately; fall back to the shell, then to the offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return response;
        })
        .catch(async () => (await caches.match('./index.html')) || caches.match('./offline.html')),
    );
    return;
  }

  // Static assets: serve from cache immediately, refresh quietly in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

/* ------------------------------------------------- notifications / push */

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = `${self.location.origin}${new URL('./', self.location).pathname}#tasks`;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        client.postMessage({ type: 'reminder-clicked', taskId: event.notification.data?.taskId ?? null });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

/**
 * Web Push entry points. They are wired and correct, but no push will arrive
 * until VAPID keys and a scheduler exist server-side (see /api/push/config).
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Reminder', body: event.data ? event.data.text() : 'You have a task due.' };
  }
  const title = String(payload.title || 'AI Life Manager reminder').slice(0, 120);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(payload.body || 'Tap to open your tasks.').slice(0, 180),
    tag: payload.tag || `task-${payload.taskId ?? 'unknown'}`,
    data: { url: payload.url || './#tasks', taskId: payload.taskId ?? null },
    icon: './icons/icon-192.png',
    badge: './icons/badge-72.png',
  }));
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      await fetch('./api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Stratarix-Request': '1' },
        credentials: 'same-origin',
        body: JSON.stringify({ endpoint: null, reason: 'subscription-expired' }),
      });
    } catch {
      /* The next app visit re-checks the subscription. */
    }
  })());
});
