/* ============================================================
   Service Worker — FleetOps
   Cache app-shell dasar supaya bisa dibuka offline / lebih cepat.
   Naikkan CACHE_VERSION di SETIAP rilis APP_VERSION (bukan cuma kalau ada
   perubahan teknis di file ini) -- ini yang memicu sistem popup "Versi Baru
   Tersedia" di index.html. Sejak strategi HTML jadi network-first, isi situs
   sendiri sudah otomatis fresh tanpa ini, TAPI popup notifikasi fitur baru
   tetap butuh sw.js berubah supaya terdeteksi sebagai "ada update".
   ============================================================ */
const CACHE_VERSION = "v39";
const CACHE_NAME = "fleetops-cache-" + CACHE_VERSION;
// File same-origin yang wajib ada supaya app bisa dibuka offline.
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png"
];

/* ---------- INSTALL: simpan app-shell ke cache ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Tambahkan satu per satu (bukan addAll) dan abaikan yang gagal,
      // supaya instalasi tidak batal total hanya karena 1 file hilang.
      return Promise.all(
        CORE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.log("SW: gagal cache", url, err);
          })
        )
      );
    })
  );
  // SENGAJA TIDAK panggil self.skipWaiting() di sini. Worker baru akan
  // diam menunggu ("waiting") sampai halaman mengirim pesan SKIP_WAITING
  // — dipicu otomatis (untuk update kecil) atau lewat klik "Perbarui
  // Sekarang" di popup (untuk update besar). Ini yang membuat update
  // tidak memaksa reload tiba-tiba di tengah pengguna sedang input data.
});

/* ---------- MESSAGE: terima sinyal "SKIP_WAITING" dari halaman ---------- */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/* ---------- ACTIVATE: bersihkan cache versi lama ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("fleetops-cache-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

/* ---------- FETCH ----------
   DUA strategi berbeda tergantung jenis file — ini perbaikan penting dari
   versi sebelumnya:

   1) HTML (index.html / navigasi halaman): NETWORK-FIRST. Selalu coba ambil
      versi TERBARU dulu selama online; cache cuma jadi cadangan kalau
      benar-benar offline. Sebelumnya HTML ikut strategi cache-dulu di bawah,
      akibatnya pengguna selalu melihat versi "1 kunjungan ketinggalan" —
      update baru kelihatan di kunjungan BERIKUTNYA, bukan saat itu juga.
      Ini akar masalah kenapa popup update terasa telat/tidak muncul.

   2) File lain (ikon, manifest, dll): tetap stale-while-revalidate (cache
      dulu biar cepat, sambil diam-diam ambil versi baru buat nanti) —
      karena file ini jarang berubah, kecepatan lebih penting di sini. */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin) return; // biarkan lewat langsung (font Google, dll)

  // Request khusus pengecekan update (dari getUpdateInfo()/forceCheckUpdate()
  // di index.html) sengaja DILEWATKAN dari cache sama sekali.
  if (url.searchParams.has("_swbypass") || url.searchParams.has("_forcecheck")) return;

  const isHTML =
    req.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("index.html") ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req)) // offline -> baru pakai cache sebagai cadangan
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return res;
        })
        .catch(() => cached); // offline & tidak ada di cache -> gagal senyap
      return cached || networkFetch;
    })
  );
});
