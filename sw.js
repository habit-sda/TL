/* Service Worker — FleetOps
   Strategi: cache-first untuk file aplikasi (app shell), supaya aplikasi tetap
   bisa dibuka walau sinyal internet lemah/putus (data tetap aman di localStorage,
   bukan di sini — service worker ini HANYA meng-cache file tampilan, bukan data).
   Naikkan CACHE_NAME setiap kali file di bawah berubah, supaya versi lama dibuang. */
const CACHE_NAME = 'fleetops-cache-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.error('SW install: gagal cache app shell', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Defensif: hanya tangani GET same-origin. Request lain (POST, cross-origin)
  // dibiarkan lewat langsung ke jaringan supaya tidak merusak perilaku normal.
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline dan tidak ada di cache: untuk halaman utama, kembalikan index.html
          // dari cache sebagai fallback supaya aplikasi tetap terbuka.
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});
