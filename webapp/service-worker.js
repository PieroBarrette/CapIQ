/* ============================================================
   Capiq V0.1 — Service Worker
   Stratégie "cache d'abord" : après la première visite,
   l'application fonctionne intégralement hors ligne.
   Incrémenter CACHE_NAME à chaque déploiement pour forcer
   la mise à jour des fichiers.
   ============================================================ */

const CACHE_NAME = 'capiq-v0.1.10';

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
  './src/gpx_service.js',
  './src/geomag_service.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Ressources souhaitables mais non bloquantes : leur absence ne doit pas
// faire échouer l'installation entière (cache.addAll est tout-ou-rien).
// WMM.COF doit être téléchargé depuis la NOAA — voir data/LISEZMOI.md.
const PRECACHE_OPTIONAL = [
  './data/WMM.COF',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // `cache: 'reload'` court-circuite le cache HTTP du navigateur : sans lui,
      // une nouvelle version du Service Worker pouvait re-mettre en cache les
      // anciens fichiers servis par le cache HTTP.
      .then((cache) => cache.addAll(
        PRECACHE.map((url) => new Request(url, { cache: 'reload' }))
      ).then(() => Promise.all(
        // Chacune est tentée séparément : un fichier absent est ignoré.
        PRECACHE_OPTIONAL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {}))
      )))
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

  // Les pages de développement ne sont jamais mises en cache : sinon toute
  // modification d'un test continue d'afficher l'ancienne version.
  if (url.pathname.includes('/tests/')) return;

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
