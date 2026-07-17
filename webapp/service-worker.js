/* ============================================================
   Capiq V0.1 — Service Worker
   Stratégie "cache d'abord" : après la première visite,
   l'application fonctionne intégralement hors ligne.
   Incrémenter CACHE_NAME à chaque déploiement pour forcer
   la mise à jour des fichiers.
   ============================================================ */

const CACHE_NAME = 'capiq-v0.1.0';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './src/app.js',
  './src/ble_service.js',
  './src/navigation_service.js',
  './src/storage_service.js',
  './models/navigation_model.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // jamais de proxy externe

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Met en cache les nouvelles ressources same-origin au passage
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Hors ligne : toute navigation retombe sur l'app shell
          if (request.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504, statusText: 'Hors ligne' });
        });
    })
  );
});
