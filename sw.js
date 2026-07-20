/* ============================================================
   Service Worker — FleetOps
   Cache app-shell dasar supaya bisa dibuka offline / lebih cepat.
   Naikkan CACHE_VERSION setiap kali file HTML/CSS/JS utama diubah,
   supaya pengguna otomatis dapat versi terbaru.
   ============================================================ */
const CACHE_VERSION = "v4";
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

/* ---------- FETCH: stale-while-revalidate untuk same-origin ----------
   Beda dari versi sebelumnya (cache-first murni): sekarang tetap tampilkan
   versi cache dulu (supaya cepat/tetap bisa dibuka offline), TAPI sekaligus
   selalu ambil salinan terbaru dari jaringan di belakang layar dan simpan
   ke cache. Jadi cache tidak pernah "macet" di versi lama selama internet
   masih menyala — beda dengan cache-first yang baru update kalau versi
   Service Worker-nya sendiri berganti. */
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin) return; // biarkan lewat langsung (font Google, dll)

  // Request khusus pengecekan update (dari getUpdateInfo() di index.html)
  // sengaja DILEWATKAN dari cache sama sekali, supaya selalu ambil versi
  // TERBARU dari jaringan — bukan versi lama yang kebetulan sudah tercache.
  if (url.searchParams.has("_swbypass")) return;

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
