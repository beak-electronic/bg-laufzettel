/* BG Laufzettel Generator – offline app shell (generate + fill + scan) */
const CACHE = 'bg-laufzettel-generator-v67';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/parse.js',
  './js/pdf.js',
  './js/fill.js',
  './js/grid.js',
  './js/settings.js',
  './js/scan.js',
  './js/sn.js',
  './js/catalog.js',
  './manifest.webmanifest',
  './vendor/pdf-lib.min.js',
  './vendor/fontkit.umd.min.js',
  './vendor/pdf.min.mjs',
  './vendor/pdf.worker.min.mjs',
  './vendor/zxing-library.min.js',
  './fonts/Calibri.subset.ttf',
  './fonts/Calibri-Bold.subset.ttf',
  './fonts/Aeonis.subset.ttf',
  './fonts/Constantia-Bold.subset.ttf',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './apple-touch-icon-precomposed.png',
  './apple-touch-icon-167.png',
  './apple-touch-icon-152.png',
  './apple-touch-icon-120.png',
  './apple-touch-icon.png',
  './icons/send_btn.png',
  './icons/send_btn_hover.png',
  './icons/settings_btn.png',
  './icons/settings_btn_hover.png',
  './icons/beak-logo.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/bg-home-180.png',
  './icons/bg-home-192.png',
  './icons/bg-home-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const url = new URL(req.url);
          if (res.ok && url.origin === self.location.origin) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
