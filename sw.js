/* Free Player — service worker (red primero; la caché queda para sin conexión) */
const CACHE = 'freeplayer-v20';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/audio-engine.js',
  './js/soundtouch.js',
  './js/db.js',
  './js/id3.js',
  './js/utils.js',
  './js/formats.js',
  './js/decoder.js',
  './js/artwork.js',
  './js/native.js',
  './js/media-bridge.js',
  './js/changelog.js',
  './js/selftest.js',
  './ffmpeg/worker.js',
  './ffmpeg/ffmpeg-core.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // si algún recurso precargado falla, seguimos igual
      .then((c) => Promise.allSettled(ASSETS.map((a) => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;

  // las peticiones de diagnóstico siempre van a la red
  if (url.pathname.startsWith('/__log')) return;

  // RED PRIMERO: en el APK los archivos se sirven desde el propio paquete y
  // responden al instante, así una versión nueva se ve en el acto. Antes era
  // caché primero y, tras actualizar la APK, seguía usando el JavaScript
  // viejo guardado (las miniaturas parecían no funcionar). La caché se
  // conserva solo como respaldo para cuando no hay conexión.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const clone = res.clone();
        const len = Number(res.headers.get('Content-Length')) || 0;
        if (len < 40 * 1024 * 1024) {
          caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
        }
      }
      return res;
    }).catch(() =>
      caches.match(e.request, { ignoreSearch: true })
        .then((cached) => cached || caches.match('./index.html'))
    )
  );
});
