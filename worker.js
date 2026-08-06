/* ============================================================================
   FleetOps — Cloudflare Worker (v2.0)
   ============================================================================
   TIGA fungsi dalam 1 Worker:
   1) Reverse-proxy ke GitHub Contents API (dipakai index.html utk sinkron data)
   2) Resi Perjalanan INSTAN ke Telegram (endpoint /notify-trip-selesai, v1.10 --
      sekarang mendukung tombol inline opsional "buttons" di body, dipakai
      fitur konfirmasi kirim nota otomatis di bawah)
   3) BARU (v2.0): Notifikasi Berkala (dokumen kadaluarsa/servis/BBM
      rendah/saldo E-Toll rendah/booking/trip kelamaan) + balas chat
      Telegram sopir ("tiba" -> tanya-jawab tutup trip) -- PORTING PERSIS
      dari telegram-notify.mjs yang sebelumnya dijalankan GitHub Actions cron.

      Dipindah ke sini supaya jadwalnya jalan lewat Cloudflare Cron Triggers
      (jauh lebih presisi -- GitHub Actions cron bisa meleset beberapa
      menit, apalagi saat runner GitHub sedang padat), TANPA mengubah
      format/struktur data di GitHub repo sama sekali -- masih file JSON
      yang sama (fleetops-data.json & notif-state.json), masih dibaca/ditulis
      lewat GitHub Contents API dengan proteksi SHA-conditional yang sama
      persis. GitHub Actions workflow (telegram-notify.yml) BOLEH tetap ada
      di repo (tidak mengganggu), tapi sebaiknya di-disable di tab Actions
      supaya tidak kirim notif dobel dengan Worker ini.

      CARA AKTIFKAN: tambahkan Cron Trigger di dashboard Cloudflare ->
      Worker ini -> Settings -> Trigger events -> Cron Triggers -> Add ->
      isi ekspresi cron "tiap 5 menit" (lihat instruksi lengkap di chat,
      sama seperti jadwal lama di GitHub Actions -- throttle sesungguhnya
      tetap ikut "Ambang Batas Notifikasi"
      -> "Cek notifikasi berkala setiap" yang diatur di aplikasi, PERSIS
      seperti sebelumnya, jadi tidak akan lebih sering/spam dari sebelumnya).

      SECRET/VARIABLE baru yang dibutuhkan (Settings -> Variables and
      Secrets) -- selebihnya (GITHUB_TOKEN, ALLOWED_OWNER, ALLOWED_REPO,
      TELEGRAM_BOT_TOKEN, NOTIFY_SECRET) SUDAH ADA dari fitur sebelumnya:
        - TELEGRAM_CHAT_ID   (opsional, Plaintext/Secret bebas -- Chat ID
                               admin, penerima TAMBAHAN semua notifikasi.
                               Boleh diisi LEBIH DARI 1 nomor, dipisah koma
                               (mis. "111111111,222222222"). Boleh
                               dikosongkan.)
        - GITHUB_BRANCH      (opsional, Plaintext, default "main" kalau
                               tidak diisi)

      CARA TES MANUAL (pengganti "Run workflow" manual di tab Actions):
      buka di browser / curl:
        GET https://<worker-url>/run-notify-check?secret=<NOTIFY_SECRET>
      Tambahkan &test_chat_id=<chatId> utk kirim 1 pesan tes sederhana ke
      Chat ID itu saja (tidak menyentuh logika alert/anti-spam sama sekali,
      sama seperti mode tes di telegram-notify.mjs dulu).
   ============================================================================ */

/* ---------------- Pengaturan: Auto-isi/Auto-saran Odometer dari GPS.id ----------------
   v3.150.0 -- SATU saklar terpusat, dipakai di alur Telegram "tiba" (dua
   tempat: processTelegramUpdate() untuk webhook real-time, dan versi
   ter-porting di dalam pollTelegramUpdatesFallback/handleRunNotifyCheck --
   cari getGpsIdMileageForImei). HARUS SAMA PERSIS dengan konstanta
   GPS_ODO_AUTOFILL_ENABLED di index.html -- kalau salah satu diubah tanpa
   yang lain, app & bot Telegram jadi tidak konsisten (satu nyaranin
   odometer GPS, satu tidak).
   Sempat dimatikan (false) di v3.150.0 karena odometer GPS.id vs odometer
   asli dashboard mobil selisihnya jauh. v3.154.0 -- dinyalakan lagi (true)
   setelah akurasi GPS.id armada ini dicek ulang & dikonfirmasi sudah OK.
   Bot tetap MENYARANKAN saja (bukan mengunci), sopir masih bisa ketik ulang
   manual di semua step yang memakainya (lihat "convo.step === 'odometer'"
   di bawah, cabang penolakan saran GPS tetap ada). Kalau nanti ternyata
   menyimpang lagi, tinggal balikin ke false DI SINI dan di index.html. */
const GPS_ODO_AUTOFILL_ENABLED = true;

/* ---------------- Kategori Biaya Operasional / Jenis BBM ----------------
   HARUS SAMA PERSIS dengan BIAYA_OP_CATEGORIES & JENIS_BBM_DEFAULT di
   index.html -- dipakai fitur chat Telegram "isi" (Isi BBM/Isi Saldo E-Toll
   luar trip) & "biaya"/"operasional"/"pribadi" (Biaya Operasional/Pribadi
   selama trip berjalan), supaya field yang ditanyakan bot PERSIS sama
   dengan field di form aplikasi. Kalau daftar ini diubah di index.html,
   WAJIB diubah juga di sini. */
const BIAYA_OP_CATEGORIES = ['Isi BBM', 'Isi E-Toll', 'Makan', 'Parkir', 'Tol Tunai', 'Lainnya'];
const JENIS_BBM_DEFAULT = ['Pertalite', 'Pertamax'];
// v3.??? -- HARUS SELALU SAMA PERSIS dengan SERVICE_CATEGORIES di index.html
// (menu Servis & Maintenance) -- dipakai fitur BARU "service" di bot
// Telegram (rekomendasi kategori + 3 data servis terbaru per kategori).
// Kalau daftar kategori di index.html diubah, WAJIB ikut disamakan di sini.
const SERVICE_CATEGORIES = ['Ganti Oli', 'Servis Berkala / Tune Up', 'Rem', 'Ban & Balancing', 'AC', 'Kelistrikan', 'Suspensi/Understel', 'Aki', 'Lainnya'];

export default {
  async fetch(request, env, ctx) {
    // 1. Mengatur header CORS agar browser HP tidak memblokir request (Error CORS)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GitHub-Api-Version, X-Notify-Secret"
    };
    // Tangani preflight request dari browser
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      return await routeRequest(request, env, ctx, corsHeaders);
    } catch (err) {
      // BARU -- pengaman global: SEBELUMNYA kalau ada error tak tertangkap di
      // mana pun dalam routing (mis. bug di runNotifyCheck), Cloudflare
      // mengembalikan halaman error generik TANPA header CORS sama sekali --
      // browser lalu salah melaporkannya sebagai error CORS, menyembunyikan
      // pesan error yang sesungguhnya. Sekarang SEMUA error tak terduga
      // ditangkap di sini, tetap dibalas dengan corsHeaders yang benar
      // + pesan error aslinya, supaya kelihatan jelas dari sisi index.html.
      console.log('Uncaught error di routing Worker:', err && err.stack || err);
      return new Response(
        JSON.stringify({ error: 'Error tak terduga di Worker: ' + (err && err.message ? err.message : String(err)) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  },

  // BARU (v2.0): dipanggil otomatis oleh Cloudflare sesuai Cron Trigger yang
  // diatur di dashboard (Settings -> Trigger events -> Cron Triggers).
  // ctx.waitUntil() supaya Worker tidak "dimatikan" duluan oleh Cloudflare
  // sebelum semua proses (baca data, kirim Telegram, tulis balik state)
  // benar-benar selesai -- durasi normal beberapa detik saja.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotifyCheck(env, { isManualDispatch: false, testChatId: null }));
    // v3.260.0 -- BARU: analisis mingguan Pola Kunjungan Berulang -- fungsi
    // ini sendiri yang menentukan apakah SUDAH waktunya jalan (Senin dini
    // hari, 1x/minggu) atau diam saja di siklus cron lainnya, lihat
    // maybeRunWeeklyPatternAnalysis().
    ctx.waitUntil(maybeRunWeeklyPatternAnalysis(env));
  }
};

// BARU: sisa routing dipindah ke fungsi terpisah routeRequest() supaya bisa
// dibungkus try/catch global di dalam fetch() di atas.
async function routeRequest(request, env, ctx, corsHeaders) {
    const url = new URL(request.url);
    const cleanPath = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;

    // Resi Perjalanan INSTAN (v1.10 -- endpoint sama, sekarang terima "buttons" opsional)
    if (request.method === "POST" && cleanPath === "/notify-trip-selesai") {
      return handleNotifyTripSelesai(request, env, corsHeaders);
    }

    // BARU (v3.186.0): Resi Perjalanan sebagai GAMBAR (bukan teks) -- dipanggil
    // dari sendInstantTripReceipt()/sendInstantAdminTripNotif() di index.html
    // setelah html2canvas() merender resi jadi PNG di sisi BROWSER (gratis,
    // tanpa API key, tanpa CPU Worker, dan TIDAK menyentuh GitHub API sama
    // sekali). Worker ini cuma penyalur bytes (multipart) ke Telegram
    // sendPhoto -- tetap ringan, aman di plan Worker gratis. Endpoint teks
    // lama (/notify-trip-selesai) tetap dipertahankan apa adanya sbg fallback
    // otomatis kalau html2canvas gagal dimuat/di-render di HP sopir.
    if (request.method === "POST" && cleanPath === "/notify-trip-selesai-photo") {
      return handleNotifyTripSelesaiPhoto(request, env, corsHeaders);
    }

    // BARU (v3.187.0): "Kirim ke Finance" dari POPUP Tanda Terima Perjalanan
    // di index.html (tombol baru di dalam openTripReceiptModal), bukan cuma
    // dari Telegram (ketik "kirim" / tap tombol inline). Berguna terutama
    // utk trip LAMA yang tidak pernah dapat tombol inline otomatis itu
    // (tombolnya cuma dikirim SEKALI pas trip baru ditutup, tidak retroaktif)
    // -- lewat popup ini, trip lama sekalipun bisa dipicu ulang.
    if (request.method === "POST" && cleanPath === "/kirim-nota-finance") {
      return handleKirimNotaFinance(request, env, corsHeaders);
    }

    // BARU (v3.166.0): Approval Booking lewat Telegram. Dipanggil per-admin
    // dari index.html begitu booking baru dibuat (sama pola dgn resi/notif
    // admin trip-selesai di atas), TAPI pesannya nempel tombol inline
    // "✅ Setuju" / "❌ Tolak". Tap tombolnya ditangani di
    // processTelegramUpdate() (cari blok "bk:ya:"/"bk:tdk:").
    if (request.method === "POST" && cleanPath === "/notify-booking-approval") {
      return handleNotifyBookingApproval(request, env, corsHeaders);
    }

    // BARU: webhook Telegram real-time (balas chat "tiba" tanpa nunggu cron
    // 5 menit). Lihat handleTelegramWebhook() untuk detail & cara aktifkan.
    if (request.method === "POST" && cleanPath === "/telegram-webhook") {
      return handleTelegramWebhook(request, env, ctx, corsHeaders);
    }

    // BARU (v2.0): trigger manual utk cek notifikasi berkala + jalur Cron
    // Triggers sesungguhnya (lihat export scheduled() di bawah) memanggil
    // runNotifyCheck() yang SAMA -- supaya hasil manual & terjadwal selalu
    // konsisten (1 sumber logika, tidak ada 2 versi berbeda).
    if (request.method === "GET" && cleanPath === "/run-notify-check") {
      return handleRunNotifyCheck(request, env, corsHeaders);
    }

    // BARU -- Log Notifikasi (tombol "Cek log notifikasi" di menu
    // Notifikasi Telegram per Peran, index.html). Baca 50 entri terbaru
    // dari notif-state.json -- DILINDUNGI NOTIFY_SECRET (sama pola dgn
    // /run-notify-check) krn isinya nama & ID Telegram penerima (data
    // pribadi), bukan data publik spt /gpsid/vehicles.
    if (request.method === "GET" && cleanPath === "/notif-log") {
      return handleGetNotifLog(request, env, corsHeaders);
    }

    // BARU (v3.217.0) -- tombol "🔀 Optimalkan Urutan" di form Catat
    // Perjalanan/Booking (index.html), khusus trip dgn Tujuan Tambahan.
    if (request.method === "POST" && cleanPath === "/optimize-route") {
      return handleOptimizeRoute(request, env, corsHeaders);
    }

    // BARU (v3.254.0) -- ikuti redirect link Google Maps PENDEK (hasil
    // tombol "Bagikan" di app, format maps.app.goo.gl/xxxxx) supaya
    // koordinatnya bisa dibaca -- lihat handleResolveMapsLink() di bawah.
    if (request.method === "POST" && cleanPath === "/resolve-maps-link") {
      return handleResolveMapsLink(request, env, corsHeaders);
    }

    // BARU (v3.255.0) -- tombol "🔍 Cari Lokasi" di Data Tujuan (index.html),
    // KHUSUS dipanggil manual oleh admin (BUKAN otomatis diam-diam) --
    // lihat handleGeocodeDestination() di bawah utk alasan kenapa harus
    // selalu dikonfirmasi manual.
    if (request.method === "POST" && cleanPath === "/geocode-destination") {
      return handleGeocodeDestination(request, env, corsHeaders);
    }

    // BARU (v3.140.0): trigger manual laporan bulanan -- utk TES kapan saja
    // (tidak perlu nunggu tanggal 1-7). Dilindungi NOTIFY_SECRET yang sama.
    // ?month=YYYY-MM opsional (default: bulan lalu). Mode tes SENGAJA tidak
    // menandai bulan itu "sudah terkirim" -- supaya kiriman OTOMATIS bulan
    // sungguhan nanti (tgl 1-7) tetap jalan seperti biasa, tidak ke-skip
    // gara-gara sudah pernah dites duluan.
    if (request.method === "GET" && cleanPath === "/run-monthly-report") {
      return handleRunMonthlyReport(request, env, corsHeaders);
    }

    // BARU: Proxy ke API GPS.id (Get Vehicle -- posisi & status kendaraan
    // terkini). Login GPS.id ditangani di dalam handler (lihat
    // getGpsIdToken()/handleGpsIdVehicles() di akhir file), pakai
    // GPSID_USERNAME/GPSID_PASSWORD dari Cloudflare Secrets -- jadi kredensial
    // GPS.id TIDAK PERNAH terkirim ke browser/index.html sama sekali.
    if (request.method === "GET" && cleanPath === "/gpsid/vehicles") {
      return handleGpsIdVehicles(request, env, corsHeaders);
    }

    // BARU: Insight GPS per trip -- proxy ke /report/history GPS.id untuk
    // 1 imei dalam rentang waktu tertentu, dihitung jadi 2 angka: total
    // durasi mesin ON + jarak versi GPS.id. Dipakai badge "🛰️ Insight GPS"
    // tappable di Riwayat Trip (lihat openGpsInsightModal() di index.html).
    // ON-DEMAND saja (tidak dipanggil otomatis massal), lihat handler di
    // akhir file untuk detail & alasannya.
    if (request.method === "GET" && cleanPath === "/gpsid/trip-insight") {
      return handleGpsIdTripInsight(request, env, corsHeaders);
    }

    // BARU -- daftar kode alert bawaan GPS.id, dipakai UI pemilihan
    // watchlist (menu Notifikasi Telegram per Peran, index.html). Read-only
    // & tidak menyingkap kredensial GPS.id, jadi TIDAK diproteksi
    // X-Notify-Secret -- pola SAMA dgn /gpsid/vehicles & /gpsid/trip-insight
    // di atas.
    if (request.method === "GET" && cleanPath === "/gpsid/alert-codes") {
      return handleGpsIdAlertCodes(request, env, corsHeaders);
    }

    // BARU -- penerima Push Data API GPS.id (v3.193.0). GPS.id yang
    // memanggil endpoint INI (bukan aplikasi/browser), tiap ~30 detik per
    // unit, jadi diproteksi via query param ?secret=... (BUKAN header
    // X-Notify-Secret spt endpoint lain -- GPS.id kemungkinan tidak bisa
    // diatur mengirim header custom, cuma URL tujuan). Pakai NOTIFY_SECRET
    // yang SAMA dgn yang sudah ada, tidak perlu secret terpisah.
    if (request.method === "POST" && cleanPath === "/gpsid/push-data") {
      return handleGpsIdPushData(request, env, corsHeaders);
    }

    // BARU -- Verifikasi PIN (Insight / Mode Sopir) dipindah ke SERVER.
    // Sebelumnya index.html menyimpan hash SHA-256 dari PIN langsung di kode
    // sumber -- siapa pun yang buka "View Source" bisa salin hash itu lalu
    // brute-force OFFLINE (PIN cuma 6 digit angka = 1 juta kemungkinan,
    // bisa dijebol dalam hitungan detik di komputer biasa). Sekarang PIN
    // ASLI cuma disimpan sebagai Cloudflare Secret di sini (FLEETOPS_INSIGHT_PIN
    // / FLEETOPS_OPERATOR_PIN), TIDAK PERNAH dikirim ke browser sama sekali --
    // browser cuma kirim PIN yang diketik user, server yang membandingkan.
    // Brute-force sekarang HARUS online (lewat internet, satu-satu ke worker
    // ini) dan dibatasi oleh rate-limit di bawah (pakai GPS_PUSH_KV yang
    // sudah ada), jadi jauh lebih lambat & lebih gampang ketahuan.
    if (request.method === "POST" && cleanPath === "/verify-pin") {
      return handleVerifyPin(request, env, corsHeaders);
    }

    // 2. Mengambil Token yang sudah Anda simpan dengan aman di tab Settings -> Variables
    const ghToken = env.GITHUB_TOKEN;
    if (!ghToken) {
      return new Response(
        JSON.stringify({ error: "Kunci rahasia GITHUB_TOKEN belum diatur atau kosong di dasbor Cloudflare." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // 2b. PENJAGA PINTU #1: hanya izinkan method GET & PUT.
    // Tanpa ini, siapapun yang tahu URL worker bisa kirim DELETE/POST langsung
    // (tidak lewat browser, jadi tidak kena aturan CORS di atas) dan memakai
    // token Anda untuk menghapus/mengubah hal yang tidak seharusnya.
    if (request.method !== "GET" && request.method !== "PUT") {
      return new Response(
        JSON.stringify({ error: "Method tidak diizinkan lewat proxy ini." }),
        { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    // 3. Pembersihan URL yang aman agar rute ke API GitHub 100% akurat
    // 3b. PENJAGA PINTU #2: hanya izinkan path menuju repo Anda sendiri.
    // Ini pertahanan lapis kedua -- kalaupun token Anda ternyata scope-nya
    // lebih luas dari 1 repo, worker ini tetap menolak dipakai untuk repo lain.
    const ALLOWED_OWNER = env.ALLOWED_OWNER || "ganti-dengan-username-github-anda";
    const ALLOWED_REPO = env.ALLOWED_REPO || "fleetops-data";
    const repoMatch = cleanPath.match(/^\/repos\/([^/]+)\/([^/]+)\//);
    if (!repoMatch || repoMatch[1] !== ALLOWED_OWNER || repoMatch[2] !== ALLOWED_REPO) {
      return new Response(
        JSON.stringify({ error: "Repo/endpoint ini tidak diizinkan lewat proxy ini." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const githubTargetUrl = `https://api.github.com${cleanPath}${url.search}`;
    try {
      // 4. Menyusun dokumen perizinan resmi ke GitHub menggunakan Token Rahasia Anda
      const fetchOptions = {
        method: request.method,
        headers: {
          "Authorization": `Bearer ${ghToken.trim()}`, // Menghilangkan spasi tidak sengaja
          "Accept": "application/vnd.github+json",
          "User-Agent": "Cloudflare-Worker-FleetOps-Proxy-v2.0",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      };
      // Jika aplikasi sedang menyimpan/mengunggah data mobil baru (PUT)
      if (request.method === "PUT") {
        const bodyText = await request.text();
        fetchOptions.body = bodyText;
        fetchOptions.headers["Content-Type"] = "application/json";
      }
      // 5. Kirim surat ke Kantor Pusat GitHub
      const ghResponse = await fetch(githubTargetUrl, fetchOptions);
      const resData = await ghResponse.text();
      // 6. Kembalikan jawaban dari GitHub ke HP Anda
      return new Response(resData, {
        status: ghResponse.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    } catch (err) {
      // Jangan bocorkan detail teknis internal (termasuk kemungkinan info token) ke luar.
      return new Response(
        JSON.stringify({ error: "Ada gangguan pada sistem Jembatan Proxy." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
}



/* ----------------------------------------------------------------
   Handler /notify-trip-selesai (v1.10 -- tambah dukungan tombol inline opsional)
   ---------------------------------------------------------------- */
async function handleNotifyTripSelesai(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return new Response(
      JSON.stringify({ error: "Kunci rahasia TELEGRAM_BOT_TOKEN belum diatur di dasbor Cloudflare." }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(
      JSON.stringify({ error: "Kunci rahasia NOTIFY_SECRET belum diatur di dasbor Cloudflare." }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const gotSecret = request.headers.get("X-Notify-Secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Body harus JSON valid." }), { status: 400, headers: jsonHeaders });
  }

  const chatId = String(payload.chatId || "").trim();
  const text = String(payload.text || "").trim();
  // BARU: tombol inline opsional -- dipakai sendInstantNotaConfirmAsk() di
  // index.html utk pesan konfirmasi "Nota sudah lengkap?" dgn tombol
  // "✅ Kirim Sekarang". Format: [{text, callback_data}, ...] (1 baris tombol
  // saja, cukup utk kebutuhan sekarang). Divalidasi longgar & dibatasi
  // panjang supaya tidak disalahgunakan mengirim payload besar ke Telegram.
  let inlineKeyboard;
  if (Array.isArray(payload.buttons) && payload.buttons.length) {
    const row = payload.buttons
      .filter(b => b && typeof b.text === "string" && typeof b.callback_data === "string")
      .slice(0, 3)
      .map(b => ({ text: b.text.slice(0, 64), callback_data: b.callback_data.slice(0, 64) }));
    if (row.length) inlineKeyboard = [row];
  }

  if (!/^-?\d{3,}$/.test(chatId)) {
    return new Response(JSON.stringify({ error: "chatId tidak valid." }), { status: 400, headers: jsonHeaders });
  }
  if (!text) {
    return new Response(JSON.stringify({ error: "text kosong." }), { status: 400, headers: jsonHeaders });
  }
  const safeText = text.length > 4000 ? text.slice(0, 3990) + "\n\n<i>(dipotong)</i>" : text;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken.trim()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, text: safeText, parse_mode: "HTML",
        ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
      })
    });
    const tgBody = await tgRes.json().catch(() => ({}));
    if (!tgRes.ok || !tgBody.ok) {
      return new Response(
        JSON.stringify({ error: "Telegram menolak pesan.", detail: tgBody }),
        { status: 502, headers: jsonHeaders }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Gagal menghubungi Telegram." }), { status: 502, headers: jsonHeaders });
  }
}

/* ----------------------------------------------------------------
   Handler /notify-trip-selesai-photo (BARU, v3.186.0) -- kirim resi
   Perjalanan sbg GAMBAR (bukan teks) ke 1 chat Telegram. Menerima
   multipart/form-data (bukan JSON) berisi field "chatId" & "photo" (Blob
   PNG hasil html2canvas dari browser sopir) + "caption" opsional.

   PENTING soal beban GitHub: gambar PNG ini TIDAK PERNAH ditulis ke repo
   GitHub sama sekali -- cuma lewat browser -> Worker (di sini) -> Telegram,
   lalu selesai. Worker ini murni jadi penyalur bytes, tidak menyentuh
   GITHUB_TOKEN/ghReadJson/pushMainDataUpdate di handler ini.

   Response mengembalikan "fileId" (file_id foto versi Telegram, dari
   tgBody.result.photo) supaya index.html bisa menyimpannya sbg
   trip.resiImageFileId -- dipakai NANTI oleh kirimNotaKeFinance() utk
   meneruskan gambar resi yang SAMA (tanpa upload ulang, cukup modal
   file_id) ke Admin Finance, digabung 1 paket dgn nota sopir (lihat
   kirimNotaKeFinance()) supaya Finance tidak menerima 2 notifikasi
   terpisah utk 1 trip yang sama.
   ---------------------------------------------------------------- */
async function handleNotifyTripSelesaiPhoto(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return new Response(
      JSON.stringify({ error: "Kunci rahasia TELEGRAM_BOT_TOKEN belum diatur di dasbor Cloudflare." }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(
      JSON.stringify({ error: "Kunci rahasia NOTIFY_SECRET belum diatur di dasbor Cloudflare." }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const gotSecret = request.headers.get("X-Notify-Secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Body harus multipart/form-data valid." }), { status: 400, headers: jsonHeaders });
  }

  const chatId = String(form.get("chatId") || "").trim();
  const captionRaw = String(form.get("caption") || "").trim();
  const photo = form.get("photo");

  if (!/^-?\d{3,}$/.test(chatId)) {
    return new Response(JSON.stringify({ error: "chatId tidak valid." }), { status: 400, headers: jsonHeaders });
  }
  if (!photo || typeof photo === "string" || typeof photo.arrayBuffer !== "function") {
    return new Response(JSON.stringify({ error: "File foto (field \"photo\") tidak ditemukan atau tidak valid." }), { status: 400, headers: jsonHeaders });
  }
  // Batas sendPhoto Telegram lewat upload langsung: 10MB -- PNG resi hasil
  // html2canvas (scale:2) normalnya cuma puluhan-ratusan KB, jadi longgar.
  const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
  if (photo.size > MAX_PHOTO_BYTES) {
    return new Response(JSON.stringify({ error: "Ukuran gambar resi terlalu besar (>10MB)." }), { status: 400, headers: jsonHeaders });
  }
  const safeCaption = captionRaw.length > 1024 ? captionRaw.slice(0, 1010) + "\n(dipotong)" : captionRaw;

  try {
    const tgForm = new FormData();
    tgForm.append("chat_id", chatId);
    tgForm.append("photo", photo, "resi.png");
    if (safeCaption) {
      tgForm.append("caption", safeCaption);
      tgForm.append("parse_mode", "HTML");
    }
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken.trim()}/sendPhoto`, {
      method: "POST",
      body: tgForm
    });
    const tgBody = await tgRes.json().catch(() => ({}));
    if (!tgRes.ok || !tgBody.ok) {
      return new Response(
        JSON.stringify({ error: "Telegram menolak gambar.", detail: tgBody }),
        { status: 502, headers: jsonHeaders }
      );
    }
    // Ambil file_id resolusi TERBESAR (elemen terakhir array photo) --
    // dipakai lagi nanti (bukan upload ulang) saat diteruskan ke Finance.
    const photoSizes = (tgBody.result && Array.isArray(tgBody.result.photo)) ? tgBody.result.photo : [];
    const fileId = photoSizes.length ? photoSizes[photoSizes.length - 1].file_id : null;
    return new Response(JSON.stringify({ ok: true, fileId }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Gagal menghubungi Telegram." }), { status: 502, headers: jsonHeaders });
  }
}

/* ----------------------------------------------------------------
   Handler /kirim-nota-finance (BARU, v3.187.0) -- versi HTTP dari fitur
   "kirim ke Finance" yang SEBELUMNYA cuma bisa dipicu lewat Telegram (ketik
   "kirim" / tap tombol inline "kirimnota:<tripId>", lihat kirimNotaKeFinance()
   di dalam processTelegramUpdate()). Dipanggil dari tombol baru di popup
   Tanda Terima Perjalanan (index.html, openTripReceiptModal).

   SENGAJA logikanya DIDUPLIKASI di sini (bukan reuse kirimNotaKeFinance())
   krn fungsi itu ter-nest di dalam processTelegramUpdate() dan bergantung ke
   closure sendTg/carLabel/escapeHtmlTg/chunkMediaGroup di situ -- pola yg
   SAMA dgn carLabel/escapeHtmlTg/sendTg yg memang sudah didefinisikan ulang
   di beberapa tempat berbeda di file ini (lihat processTelegramUpdate() vs
   runNotifyCheck()), supaya tiap handler tetap independen & aman diubah
   sendiri-sendiri tanpa risiko mematahkan handler lain.
   ---------------------------------------------------------------- */
function chunkMediaGroupStandalone(items, maxSize = 10) {
  const chunks = [];
  for (let i = 0; i < items.length; i += maxSize) chunks.push(items.slice(i, i + maxSize));
  if (chunks.length > 1 && chunks[chunks.length - 1].length === 1) {
    const pindahan = chunks[chunks.length - 2].pop();
    chunks[chunks.length - 1].unshift(pindahan);
  }
  return chunks;
}

async function sendTripNotaKeFinance(env, tripId, testChatId) {
  const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  const DATA_PATH = env.FLEETOPS_DATA_PATH || 'data/fleetops-data.json';
  const isTest = !!testChatId;

  async function sendTgStandalone(cid, txt) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cid, text: txt, parse_mode: 'HTML' })
      });
    } catch (e) { console.log(`kirim-nota-finance: gagal kirim pesan ke ${cid}:`, e.message); }
  }
  function escapeHtmlTgStandalone(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  }

  let dataRead;
  try {
    dataRead = await ghReadJson(env, DATA_PATH);
  } catch (e) {
    return { status: 'error', message: 'Gagal membaca data utama dari GitHub.' };
  }
  if (!dataRead.exists) return { status: 'error', message: 'Data utama belum ada di GitHub.' };
  const state = dataRead.json.data || {};
  state.usage = state.usage || [];
  state.drivers = state.drivers || [];
  state.cars = state.cars || [];
  state.financeAdmins = state.financeAdmins || [];

  function carLabelStandalone(carId) {
    const c = state.cars.find(x => x.id === carId);
    return c ? (c.merk + ' ' + c.modelMobil + ' — ' + c.plat) : '(mobil telah dihapus)';
  }

  const trip = state.usage.find(u => u.id === tripId);
  if (!trip) return { status: 'notfound' };
  if (trip.jenisPenggunaan === 'pribadi') return { status: 'pribadi' };
  const driverPengirim = state.drivers.find(d => d.id === trip.driverId);
  if (!driverPengirim) return { status: 'notfound' };

  const notaItems = Array.isArray(trip.buktiPending) ? trip.buktiPending : [];
  if (!notaItems.length && !trip.resiImageFileId) return { status: 'kosong' };

  // BARU -- mode tes: penerima diganti TOTAL jadi 1 Chat ID tes saja (BUKAN
  // ditambahkan ke daftar Finance asli), supaya aman dites kapan saja tanpa
  // mengganggu Finance sungguhan.
  const financeAdminsAktif = isTest
    ? [{ chatId: testChatId, nama: '(tes)' }]
    : (state.financeAdmins || []).filter(a => a.chatId);
  if (!isTest && !financeAdminsAktif.length) return { status: 'nofinance' };

  const notaPhotos = notaItems.filter(b => b.kind === 'photo');
  const docs = notaItems.filter(b => b.kind === 'document');
  const resiItem = trip.resiImageFileId ? { fileId: trip.resiImageFileId } : null;
  const semuaFotoUntukFinance = [...(resiItem ? [resiItem] : []), ...notaPhotos];
  const headerText = (isTest ? '🔬 <b>[TES -- BUKAN trip sungguhan yang baru selesai]</b>\n' : '') +
    `📎 <b>${escapeHtmlTgStandalone(driverPengirim.nama)}</b> — trip selesai\n${escapeHtmlTgStandalone(carLabelStandalone(trip.carId))} — ${escapeHtmlTgStandalone(trip.tujuan || '-')}\n${escapeHtmlTgStandalone(trip.tglKeluar || '-')} s/d ${escapeHtmlTgStandalone(trip.tglKembali || '-')}` +
    (notaItems.length > 0 ? ` · ${notaItems.length} lampiran nota` : '') +
    (resiItem ? `${notaItems.length > 0 ? ' +' : ' ·'} Tanda Terima Perjalanan` : '') +
    (isTest ? '\n<i>(contoh dari trip lama, dikirim khusus utk pengujian menu ini)</i>' : '\n<i>(dikirim ulang lewat aplikasi)</i>');

  for (const fa of financeAdminsAktif) {
    await sendTgStandalone(fa.chatId, headerText);
    if (semuaFotoUntukFinance.length === 1) {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: fa.chatId, photo: semuaFotoUntukFinance[0].fileId }),
        });
      } catch (e) { console.log('kirim-nota-finance: gagal sendPhoto (tunggal) ke', fa.chatId, e.message); }
    } else if (semuaFotoUntukFinance.length > 1) {
      for (const chunk of chunkMediaGroupStandalone(semuaFotoUntukFinance, 10)) {
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: fa.chatId,
              media: chunk.map(b => ({ type: 'photo', media: b.fileId, ...(b.caption ? { caption: b.caption } : {}) })),
            }),
          });
        } catch (e) { console.log('kirim-nota-finance: gagal sendMediaGroup ke', fa.chatId, e.message); }
      }
    }
    for (const d of docs) {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: fa.chatId, document: d.fileId, ...(d.caption ? { caption: d.caption } : {}) }),
        });
      } catch (e) { console.log('kirim-nota-finance: gagal sendDocument ke', fa.chatId, e.message); }
    }
  }

  // BARU -- mode tes TIDAK PERNAH menandai trip asli sbg "sudah terkirim ke
  // Finance" ataupun menghapus buktiPending-nya -- trip contoh itu harus
  // tetap utuh apa adanya utk dipakai lagi kalau perlu tes ulang, dan Finance
  // sungguhan tetap harus menerimanya lewat jalur normal nanti.
  if (isTest) return { status: 'ok' };

  const hasilTandaiKirim = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
    const usageArr = freshRaw.data.usage || [];
    const t = usageArr.find(u => u.id === tripId);
    if (!t) return false;
    t.buktiTerkirimAt = Date.now();
    t.buktiPending = [];
    t.updatedAt = Date.now();
    return true;
  });
  return { status: hasilTandaiKirim.ok ? 'ok' : 'gagaltandai' };
}

async function handleKirimNotaFinance(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return new Response(
      JSON.stringify({ error: "Kunci rahasia TELEGRAM_BOT_TOKEN belum diatur di dasbor Cloudflare." }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(
      JSON.stringify({ error: "Kunci rahasia NOTIFY_SECRET belum diatur di dasbor Cloudflare." }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const gotSecret = request.headers.get("X-Notify-Secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Body harus JSON valid." }), { status: 400, headers: jsonHeaders });
  }
  const tripId = String(payload.tripId || "").trim();
  if (!tripId) {
    return new Response(JSON.stringify({ error: "tripId kosong." }), { status: 400, headers: jsonHeaders });
  }
  // BARU -- testChatId opsional: kalau diisi, kirim HANYA ke 1 Chat ID ini
  // (BUKAN ke Admin Finance sungguhan) dan JANGAN tandai trip contoh sbg
  // "sudah terkirim" -- dipakai tombol "🔬 Test" per baris Admin Finance
  // (menu Pengaturan → Admin Finance).
  const testChatId = payload.testChatId ? String(payload.testChatId).trim() : null;

  const hasil = await sendTripNotaKeFinance(env, tripId, testChatId);
  if (hasil.status === 'ok') {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
  }
  const pesanError = {
    notfound: 'Trip atau sopirnya tidak ditemukan di data server.',
    pribadi: 'Trip Pribadi tidak pernah dikirim ke Admin Finance.',
    kosong: 'Belum ada nota/tanda terima yang bisa dikirim untuk trip ini.',
    nofinance: 'Belum ada Admin Finance terdaftar di aplikasi.',
    gagaltandai: 'Sudah terkirim ke Telegram, tapi gagal menandai selesai di server -- coba kirim ulang.',
    error: hasil.message || 'Gagal memproses permintaan.',
  }[hasil.status] || 'Gagal memproses permintaan.';
  const statusCode = hasil.status === 'notfound' ? 404 : (hasil.status === 'error' ? 500 : 409);
  return new Response(JSON.stringify({ error: pesanError, status: hasil.status }), { status: statusCode, headers: jsonHeaders });
}

/* ----------------------------------------------------------------
   Handler /run-notify-check (BARU, v2.0) -- trigger manual, dilindungi
   NOTIFY_SECRET yang sama dengan resi instan. Menerima secret lewat header
   X-Notify-Secret ATAU query string ?secret=... (query string disediakan
   supaya bisa dites langsung dari address bar browser tanpa tool tambahan).
   ---------------------------------------------------------------- */
// Handler: GET /notif-log -- baca 50 entri Log Notifikasi terbaru dari
// notif-state.json (ditulis oleh pushNotifLog() di runNotifyCheck()).
async function handleGetNotifLog(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(JSON.stringify({ error: "NOTIFY_SECRET belum diatur di dasbor Cloudflare." }), { status: 500, headers: jsonHeaders });
  }
  const url = new URL(request.url);
  const gotSecret = request.headers.get("X-Notify-Secret") || url.searchParams.get("secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }
  try {
    const DATA_PATH = env.FLEETOPS_DATA_PATH || "data/fleetops-data.json";
    const dirOfData = DATA_PATH.includes("/") ? DATA_PATH.slice(0, DATA_PATH.lastIndexOf("/") + 1) : "";
    const STATE_PATH = env.FLEETOPS_NOTIF_STATE_PATH || (dirOfData + "notif-state.json");
    const stateRead = await ghReadJson(env, STATE_PATH);
    const notifLog = (stateRead.exists && Array.isArray(stateRead.json && stateRead.json.notifLog)) ? stateRead.json.notifLog : [];
    return new Response(JSON.stringify({ ok: true, notifLog }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "Gagal membaca log notifikasi." }), { status: 502, headers: jsonHeaders });
  }
}

// v3.217.0 -- BARU: POST /optimize-route -- proxy ke OpenRouteService
// Optimization API (mesin VROOM, gratis sampai kuota harian) utk cari
// URUTAN KUNJUNGAN PALING EFISIEN dari beberapa titik tujuan sekaligus.
// Dipakai tombol "🔀 Optimalkan Urutan" di form Catat Perjalanan/Booking
// (index.html), KHUSUS trip dgn Tujuan Tambahan (>1 tujuan) yang SEMUA
// titiknya sudah punya koordinat tersimpan (index.html yang menolak kalau
// belum lengkap -- endpoint ini TIDAK menebak/geocode nama jadi koordinat,
// supaya tidak pernah kasih saran urutan dari lokasi yang salah tebak).
// DILINDUNGI NOTIFY_SECRET, pola SAMA dgn /notif-log di atas. Titik AWAL
// (mobil berangkat dari kantor/basis) TIDAK dikirim ke sini -- endpoint ini
// cuma mengurutkan titik-titik TUJUAN yg dikirim, mobil "mulai" dari titik
// tujuan PERTAMA yg dikirim (bukan dari kantor, krn koordinat kantor tidak
// diketahui sistem ini) -- KECUALI body.start dikirim (v3.230.0, lihat
// catatan di bawah), yang dipakai fitur sinkron ulang Optimalkan Urutan
// utk trip aktif supaya start-nya posisi GPS.id mobil sekarang.
async function handleOptimizeRoute(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(JSON.stringify({ error: "NOTIFY_SECRET belum diatur di dasbor Cloudflare." }), { status: 500, headers: jsonHeaders });
  }
  const gotSecret = request.headers.get("X-Notify-Secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }
  const orsKey = env.ORS_API_KEY;
  if (!orsKey) {
    return new Response(JSON.stringify({ error: "ORS_API_KEY belum diatur di dasbor Cloudflare -- daftar gratis dulu di openrouteservice.org untuk dapat API key." }), { status: 500, headers: jsonHeaders });
  }
  // v3.217.1 -- BARU: pengaman batas pemakaian harian MILIK FLEETOPS SENDIRI
  // (bukan dari OpenRouteService) -- SENGAJA disetel jauh di bawah kuota
  // gratis ORS (2.000+/hari) sbg marjin aman besar, supaya armada manapun
  // TIDAK PERNAH mendekati batas asli mereka sama sekali, walau dipakai
  // rame-rame. Pakai GPS_PUSH_KV yang SAMA dgn rate-limit PIN (tidak perlu
  // KV baru) -- key per-TANGGAL (bukan per-IP) supaya otomatis reset besok
  // tanpa perlu logika reset manual. Kalau KV belum di-bind, pengecekan ini
  // DILEWATI (fail-open) -- bukan celah keamanan spt PIN, ini cuma lapisan
  // tambahan di atas proteksi kuota ORS sendiri yang SUDAH aman (lihat
  // openrouteservice.org/terms-of-service: kelebihan kuota = error/blokir
  // sementara, BUKAN tagihan otomatis).
  const ORS_DAILY_LIMIT = 100;
  const quotaKey = `orsquota:${new Date().toISOString().slice(0, 10)}`;
  if (env.GPS_PUSH_KV) {
    const quotaState = (await readGpsKvJson(env, quotaKey)) || { count: 0 };
    if (quotaState.count >= ORS_DAILY_LIMIT) {
      return new Response(JSON.stringify({ error: `Batas pemakaian harian internal FleetOps (${ORS_DAILY_LIMIT}x/hari) untuk fitur Optimalkan Urutan sudah tercapai -- ini pengaman TAMBAHAN dari FleetOps sendiri (bukan error dari OpenRouteService), supaya pemakaian tidak pernah mendekati kuota gratis mereka. Coba lagi besok, atau naikkan batas ini di kode kalau memang rutin kepakai sebanyak itu.` }), { status: 429, headers: jsonHeaders });
    }
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: "Body request tidak valid (harus JSON)." }), { status: 400, headers: jsonHeaders });
  }
  const points = Array.isArray(body.points) ? body.points : [];
  if (points.length < 2) {
    return new Response(JSON.stringify({ error: "Minimal 2 titik tujuan diperlukan untuk optimasi urutan." }), { status: 400, headers: jsonHeaders });
  }
  if (points.length > 20) {
    return new Response(JSON.stringify({ error: "Maksimal 20 titik tujuan sekaligus (batasan wajar, belum pernah dibutuhkan lebih dari ini)." }), { status: 400, headers: jsonHeaders });
  }
  for (const p of points) {
    if (typeof p.lat !== "number" || typeof p.lon !== "number") {
      return new Response(JSON.stringify({ error: "Setiap titik wajib punya lat & lon (angka)." }), { status: 400, headers: jsonHeaders });
    }
  }
  // v3.230.0 -- BARU: body.start OPSIONAL {lat,lon} -- dipakai fitur
  // "sinkron ulang Optimalkan Urutan" utk trip AKTIF (index.html, tombol
  // Optimalkan Urutan di Edit Perjalanan) supaya vehicle START di VROOM
  // adalah POSISI GPS.id MOBIL SEKARANG (lebih akurat, krn mobil sudah di
  // jalan), bukan titik tujuan pertama spt sebelumnya. Kalau tidak dikirim
  // (alur lama: trip BARU/Booking yg posisi mobilnya belum diketahui),
  // fallback PERSIS ke perilaku lama (start = titik pertama yg dikirim) --
  // supaya alur yg sudah jalan tidak berubah sama sekali.
  const startValid = body.start && typeof body.start.lat === "number" && typeof body.start.lon === "number";
  const vroomBody = {
    jobs: points.map((p, i) => ({ id: i, location: [p.lon, p.lat] })),
    vehicles: [{ id: 1, profile: "driving-car", start: startValid ? [body.start.lon, body.start.lat] : [points[0].lon, points[0].lat] }],
  };
  if (env.GPS_PUSH_KV) {
    const quotaStateNow = (await readGpsKvJson(env, quotaKey)) || { count: 0 };
    await writeGpsKvJson(env, quotaKey, { count: quotaStateNow.count + 1 }, 90000); // TTL ~25 jam -> otomatis "reset" besok
  }
  try {
    const orsRes = await fetch("https://api.openrouteservice.org/optimization", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": orsKey },
      body: JSON.stringify(vroomBody),
    });
    const orsData = await orsRes.json();
    if (!orsRes.ok) {
      const pesan = (orsData && orsData.error && (orsData.error.message || orsData.error)) || "Gagal memanggil OpenRouteService.";
      return new Response(JSON.stringify({ error: String(pesan) }), { status: 502, headers: jsonHeaders });
    }
    const route = (orsData.routes && orsData.routes[0]) || null;
    if (!route || !Array.isArray(route.steps)) {
      return new Response(JSON.stringify({ error: "OpenRouteService tidak mengembalikan rute yang valid." }), { status: 502, headers: jsonHeaders });
    }
    // Urutan job id sesuai steps bertipe "job" -- ini urutan INDEKS titik
    // (relatif ke array `points` yg dikirim), sesuai urutan kunjungan
    // paling efisien menurut VROOM.
    const order = route.steps.filter(s => s.type === "job").map(s => s.id);
    // v3.255.0 -- BARU: VROOM (mesin di balik optimasi urutan ini) SUDAH
    // menghitung estimasi durasi tempuh sbg bagian dari hasil optimasinya
    // (route.duration, detik) -- sebelumnya dihitung tapi tidak pernah
    // dipakai/dikirim balik. Sekarang diikutkan di response supaya
    // index.html bisa tampilkan estimasi lama perjalanan (ETA) TANPA
    // panggilan ORS tambahan sama sekali -- data ini "gratis", sudah ada di
    // response yang sama dgn yang dipakai utk urutan & jarak.
    return new Response(JSON.stringify({ ok: true, order, jarakMeter: route.distance != null ? route.distance : null, durasiDetik: route.duration != null ? route.duration : null }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "Gagal terhubung ke OpenRouteService." }), { status: 502, headers: jsonHeaders });
  }
}

// v3.254.0 -- BARU: POST /resolve-maps-link -- ikuti redirect link Google
// Maps PENDEK (hasil tombol "Bagikan" di app, format
// maps.app.goo.gl/xxxxx atau goo.gl/maps/xxxxx) yang teks link-nya sendiri
// TIDAK mengandung koordinat sama sekali -- baru "ketahuan" koordinatnya
// kalau link itu di-redirect ke URL panjang Google Maps yang sungguhan.
// Akar masalah ini yang bikin "belum ada link Maps tersimpan" salah
// dilaporkan padahal linknya SUDAH ada (lihat SOP bagian 10, entri
// v3.253.0) -- endpoint ini memperbaiki akarnya, bukan cuma pesan errornya.
// Dipakai index.html (wireMapsLinkAutoResolve()) supaya field "Link Maps"
// di Data Tujuan/Catat Perjalanan/Booking/Servis otomatis dikonversi ke
// versi lengkap begitu user tempel link pendek, tanpa perlu buka manual.
// DILINDUNGI NOTIFY_SECRET, pola SAMA dgn /optimize-route. Domain tujuan
// DIBATASI ke domain resmi Google Maps saja (whitelist) -- endpoint ini
// SENGAJA BUKAN proxy fetch bebas ke URL sembarangan, supaya tidak bisa
// disalahgunakan jadi celah relay/SSRF ke alamat lain.
async function handleResolveMapsLink(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(JSON.stringify({ error: "NOTIFY_SECRET belum diatur di dasbor Cloudflare." }), { status: 500, headers: jsonHeaders });
  }
  const gotSecret = request.headers.get("X-Notify-Secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: "Body request tidak valid (harus JSON)." }), { status: 400, headers: jsonHeaders });
  }
  const rawUrl = (body.url || "").toString().trim();
  if (!rawUrl) {
    return new Response(JSON.stringify({ error: "Link Maps wajib diisi." }), { status: 400, headers: jsonHeaders });
  }
  let parsed;
  try { parsed = new URL(rawUrl); } catch (e) {
    return new Response(JSON.stringify({ error: "Link tidak valid (bukan URL)." }), { status: 400, headers: jsonHeaders });
  }
  const ALLOWED_HOSTS = ["maps.app.goo.gl", "goo.gl", "maps.google.com", "www.google.com", "google.com"];
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return new Response(JSON.stringify({ error: "Cuma link Google Maps (maps.app.goo.gl / google.com/maps / dst) yang bisa diproses di sini." }), { status: 400, headers: jsonHeaders });
  }
  const PIN_RE = /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/;
  const COORD_RE = /(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/;
  // v3.265.0 -- prioritaskan pola !3d<lat>!4d<lon> (titik pin asli) di atas
  // pola umum lat,lng -- lihat catatan panjang di extractLatLng() index.html
  // (URL Maps bisa punya @lat,lng sbg titik TENGAH TAMPILAN peta yang beda
  // dari pin sebenarnya kalau peta sempat digeser/di-zoom).
  function pickCoord(text){
    const pin = text.match(PIN_RE);
    if(pin) return { lat: Number(pin[1]), lon: Number(pin[2]) };
    const m = text.match(COORD_RE);
    if(!m) return null;
    return { lat: Number(m[1]), lon: Number(m[2]) };
  }
  // Kalau linknya SUDAH mengandung koordinat sejak awal (mis. link panjang
  // yang sebetulnya sudah bisa dibaca extractLatLng() di index.html tanpa
  // perlu resolusi apa pun) -- balikin langsung, tidak perlu fetch keluar
  // sama sekali (lebih cepat & tidak makan kuota redirect).
  const directCoord = pickCoord(rawUrl);
  if (directCoord) {
    return new Response(JSON.stringify({ ok: true, url: rawUrl, lat: directCoord.lat, lon: directCoord.lon }), { status: 200, headers: jsonHeaders });
  }
  try {
    const res = await fetch(rawUrl, { method: "GET", redirect: "follow" });
    const finalUrl = res.url || rawUrl;
    const coord = pickCoord(finalUrl);
    if (!coord) {
      return new Response(JSON.stringify({ error: "Link berhasil dibuka tapi tidak ditemukan koordinat di URL hasil akhirnya -- kemungkinan link ini bukan menunjuk 1 titik lokasi spesifik. Coba buka manual di Google Maps, cari lokasinya persis, lalu salin link dari sana." }), { status: 422, headers: jsonHeaders });
    }
    return new Response(JSON.stringify({ ok: true, url: finalUrl, lat: coord.lat, lon: coord.lon }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "Gagal membuka link Maps ini." }), { status: 502, headers: jsonHeaders });
  }
}

// v3.255.0 -- BARU: POST /geocode-destination -- cari kandidat koordinat
// dari NAMA tujuan bebas (mis. "Gudang Surabaya") lewat OpenRouteService
// Geocoding (Pelias, API key SAMA dgn ORS_API_KEY yang sudah ada -- tidak
// perlu daftar layanan baru). Dipakai tombol "🔍 Cari Lokasi" di form Data
// Tujuan (index.html), KHUSUS utk tujuan yang BELUM punya Link Maps sama
// sekali.
// SENGAJA cuma balikin DAFTAR KANDIDAT (maks 5), BUKAN langsung memutuskan
// 1 lokasi & menyimpannya otomatis -- nama tempat itu ambigu (mis. "Toko
// Maju" bisa ada di banyak kota, "Kantor Pusat" bisa apa saja), jadi WAJIB
// admin yang pilih & konfirmasi manual mana yang benar dari daftar itu
// (lihat wiring di index.html) -- keliru pilih di sini bisa bikin
// Optimalkan Urutan/Rute Menyimpang menyarankan rute dari lokasi yang SALAH
// TOTAL tanpa admin sadar, jadi TIDAK BOLEH auto-pilih kandidat pertama
// begitu saja.
// DILINDUNGI NOTIFY_SECRET, pola SAMA dgn /optimize-route &
// /resolve-maps-link. Berbagi kuota harian internal SAMA (`orsquota:...`)
// dgn 2 fitur ORS lain -- lihat catatan kuota gabungan di
// orsRoadDistanceMeters().
async function handleGeocodeDestination(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(JSON.stringify({ error: "NOTIFY_SECRET belum diatur di dasbor Cloudflare." }), { status: 500, headers: jsonHeaders });
  }
  const gotSecret = request.headers.get("X-Notify-Secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }
  const orsKey = env.ORS_API_KEY;
  if (!orsKey) {
    return new Response(JSON.stringify({ error: "ORS_API_KEY belum diatur di dasbor Cloudflare -- daftar gratis dulu di openrouteservice.org untuk dapat API key." }), { status: 500, headers: jsonHeaders });
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return new Response(JSON.stringify({ error: "Body request tidak valid (harus JSON)." }), { status: 400, headers: jsonHeaders });
  }
  const query = (body.query || "").toString().trim();
  if (!query) {
    return new Response(JSON.stringify({ error: "Nama tujuan wajib diisi dulu sebelum bisa dicari." }), { status: 400, headers: jsonHeaders });
  }
  // Anggaran kuota harian SAMA dgn /optimize-route & orsRoadDistanceMeters()
  // -- 1 counter gabungan (`orsquota:<tanggal>`), BUKAN jatah terpisah per
  // fitur (lihat alasan lengkap di orsRoadDistanceMeters()).
  const ORS_DAILY_LIMIT = 100;
  const quotaKey = `orsquota:${new Date().toISOString().slice(0, 10)}`;
  if (env.GPS_PUSH_KV) {
    const quotaState = (await readGpsKvJson(env, quotaKey)) || { count: 0 };
    if (quotaState.count >= ORS_DAILY_LIMIT) {
      return new Response(JSON.stringify({ error: `Batas pemakaian harian internal FleetOps (${ORS_DAILY_LIMIT}x/hari, gabungan semua fitur OpenRouteService) sudah tercapai. Coba lagi besok, atau isi Link Maps-nya manual dulu.` }), { status: 429, headers: jsonHeaders });
    }
  }
  if (env.GPS_PUSH_KV) {
    const quotaStateNow = (await readGpsKvJson(env, quotaKey)) || { count: 0 };
    await writeGpsKvJson(env, quotaKey, { count: quotaStateNow.count + 1 }, 90000);
  }
  try {
    // boundary.country=IDN -- FleetOps beroperasi di Indonesia, membatasi
    // pencarian ke sini mengurangi kandidat yang jelas-jelas salah negara
    // utk nama tempat umum (mis. "Surabaya" tanpa embel-embel lain).
    const geoUrl = `https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(orsKey)}&text=${encodeURIComponent(query)}&size=5&boundary.country=IDN`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();
    if (!geoRes.ok) {
      const pesan = (geoData && geoData.meta && geoData.meta.details) || (geoData && geoData.message) || "Gagal memanggil OpenRouteService Geocoding.";
      return new Response(JSON.stringify({ error: String(pesan) }), { status: 502, headers: jsonHeaders });
    }
    const features = Array.isArray(geoData.features) ? geoData.features : [];
    const kandidat = features
      .filter(f => f.geometry && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length === 2)
      .map(f => ({
        label: (f.properties && f.properties.label) || query,
        lon: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
      }));
    return new Response(JSON.stringify({ ok: true, kandidat }), { status: 200, headers: jsonHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "Gagal terhubung ke OpenRouteService." }), { status: 502, headers: jsonHeaders });
  }
}


async function handleRunNotifyCheck(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(JSON.stringify({ error: "NOTIFY_SECRET belum diatur di dasbor Cloudflare." }), { status: 500, headers: jsonHeaders });
  }
  const url = new URL(request.url);
  const gotSecret = request.headers.get("X-Notify-Secret") || url.searchParams.get("secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }
  const testChatId = (url.searchParams.get("test_chat_id") || "").trim();
  const testCategory = (url.searchParams.get("test_category") || "").trim();
  const result = await runNotifyCheck(env, { isManualDispatch: true, testChatId: testChatId || null, testCategory: testCategory || null });
  return new Response(JSON.stringify(result, null, 2), { status: 200, headers: jsonHeaders });
}

/* ----------------------------------------------------------------
   Handler /run-monthly-report (BARU, v3.140.0) -- trigger manual Laporan
   Bulanan, dilindungi NOTIFY_SECRET yang sama (header X-Notify-Secret ATAU
   ?secret=...). ?month=YYYY-MM opsional utk tes bulan tertentu (default:
   bulan lalu). CATATAN: karena lewat runNotifyCheck() yang sama dgn
   isManualDispatch:true, alert-alert biasa yang lagi aktif (dokumen,
   servis, dll) IKUT diproses/dikirim juga di panggilan ini -- bukan bug,
   memang begitu desainnya /run-notify-check juga (1 sumber logika).
   ---------------------------------------------------------------- */
async function handleRunMonthlyReport(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(JSON.stringify({ error: "NOTIFY_SECRET belum diatur di dasbor Cloudflare." }), { status: 500, headers: jsonHeaders });
  }
  const url = new URL(request.url);
  const gotSecret = request.headers.get("X-Notify-Secret") || url.searchParams.get("secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }
  const monthParam = (url.searchParams.get("month") || "").trim();
  if (monthParam && !/^\d{4}-\d{2}$/.test(monthParam)) {
    return new Response(JSON.stringify({ error: "Format ?month harus YYYY-MM, mis. 2026-07." }), { status: 400, headers: jsonHeaders });
  }
  const result = await runNotifyCheck(env, { isManualDispatch: true, testChatId: null, forceMonthlyReport: true, monthlyReportTargetMonth: monthParam || null });
  return new Response(JSON.stringify(result, null, 2), { status: 200, headers: jsonHeaders });
}

/* ----------------------------------------------------------------
   Handler /telegram-webhook (BARU) -- Telegram akan POST ke sini SETIAP
   KALI ada pesan baru masuk ke bot (real-time), menggantikan cara lama
   (nunggu Cron Trigger jalan tiap 5 menit baru dicek lewat getUpdates).

   Dilindungi header rahasia `X-Telegram-Bot-Api-Secret-Token` yang
   didaftarkan sendiri saat setWebhook (lihat instruksi lengkap di chat) --
   Telegram akan menyertakan header ini di SETIAP request webhook,
   dicocokkan ke SECRET/VARIABLE baru env.TELEGRAM_WEBHOOK_SECRET di sini.

   Selalu balas 200 OK secepatnya (pemrosesan sesungguhnya jalan di
   ctx.waitUntil, setelah response dikirim) -- supaya Telegram tidak
   mengira gagal & coba kirim ulang update yang sama berkali-kali.
   ---------------------------------------------------------------- */
async function handleTelegramWebhook(request, env, ctx, corsHeaders) {
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.log('webhook: TELEGRAM_WEBHOOK_SECRET belum diatur di dasbor Cloudflare -- update diabaikan.');
    return new Response('OK', { status: 200, headers: corsHeaders });
  }
  const gotSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (gotSecret !== webhookSecret) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders });
  }
  let update;
  try {
    update = await request.json();
  } catch (e) {
    return new Response('OK', { status: 200, headers: corsHeaders }); // body aneh -- abaikan diam-diam, jangan bikin Telegram retry terus
  }
  ctx.waitUntil(
    processTelegramUpdate(update, env).catch(e => console.log('webhook: error proses update:', e.message))
  );
  return new Response('OK', { status: 200, headers: corsHeaders });
}

/* ============================================================================
   ---- Helper base64 yang AMAN utk teks UTF-8 (emoji, dsb) ----
   atob()/btoa() bawaan browser/Workers cuma benar utk teks Latin1 murni --
   konten kita penuh emoji (🚨🔴🟡⛽💳📄...) yang butuh multi-byte UTF-8, jadi
   HARUS lewat TextEncoder/TextDecoder dulu, baru di-base64-kan per-byte.
   ============================================================================ */
function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunkSize = 0x8000; // hindari "Maximum call stack size exceeded" utk file besar
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function b64DecodeUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ============================================================================
   ---- Baca/tulis file JSON di repo GitHub lewat Contents API ----
   Pola SAMA PERSIS dengan pushToGithub() di index.html / telegram-notify.mjs
   dulu: GET dulu (ambil sha TERBARU), PUT balik dengan sha itu (proteksi
   SHA-conditional -- kalau ada device lain sinkron duluan di detik yang
   sama, PUT ini otomatis ditolak GitHub, bukan menimpa buta).
   ============================================================================ */
async function ghReadJson(env, path) {
  const owner = env.ALLOWED_OWNER, repo = env.ALLOWED_REPO, branch = env.GITHUB_BRANCH || 'main';
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': `Bearer ${(env.GITHUB_TOKEN || '').trim()}`,
    'User-Agent': 'Cloudflare-Worker-FleetOps-NotifyCron'
  };
  const res = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
  if (res.status === 404) return { exists: false, sha: null, json: null };
  if (!res.ok) throw new Error(`GET ${path} gagal (HTTP ${res.status})`);
  const data = await res.json();
  const json = JSON.parse(b64DecodeUtf8(data.content));
  return { exists: true, sha: data.sha, json };
}
async function ghWriteJson(env, path, obj, sha, message) {
  const owner = env.ALLOWED_OWNER, repo = env.ALLOWED_REPO, branch = env.GITHUB_BRANCH || 'main';
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Authorization': `Bearer ${(env.GITHUB_TOKEN || '').trim()}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Cloudflare-Worker-FleetOps-NotifyCron'
  };
  const body = {
    message,
    content: b64EncodeUtf8(JSON.stringify(obj, null, 2) + '\n'),
    branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(body) });
  const resBody = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: resBody };
}

/* PORTING PERSIS dari pushMainDataUpdate() di telegram-notify.mjs -- dipakai
   fitur "tutup trip lewat chat Telegram" (tulis balik ke fleetops-data.json
   dengan proteksi SHA-conditional + 1x retry kalau bentrok). */
async function pushMainDataUpdate(env, dataPath, mutatorFn) {
  async function attemptOnce() {
    const { exists, sha, json } = await ghReadJson(env, dataPath);
    const freshRaw = exists ? json : { data: {} };
    freshRaw.data = freshRaw.data || {};
    const found = mutatorFn(freshRaw);
    if (!found) return { ok: false, reason: 'not-found' };
    const putRes = await ghWriteJson(env, dataPath, freshRaw, sha, `chore: update via chat Telegram — ${new Date().toISOString()}`);
    if (putRes.ok) return { ok: true };
    return { ok: false, reason: 'put-failed', status: putRes.status };
  }
  let result = await attemptOnce();
  if (!result.ok && (result.status === 409 || result.status === 422)) {
    result = await attemptOnce(); // retry SEKALI dari data terbaru, sama seperti versi GitHub Actions dulu
  }
  return result;
}

// v3.265.0 -- BARU: pasangan fungsi utk fitur "Tingkat 3 mengajari Tingkat
// 1.5" -- begitu NLP Tingkat 3 (AI, lihat nlpWorkersAiFallback() & blok NLP
// bertingkat di processTelegramUpdate()) berhasil menebak DAN sopir
// mengonfirmasi tap "✅ Ya, benar", kata baru yang memicu tebakan itu
// ditulis ke state.commandAliases[kategori] -- JALUR YANG SAMA PERSIS dgn
// Super Admin menambah alias manual lewat menu "✏️ Alias" (index.html),
// dibaca lagi oleh withAliases() di worker.js. SENGAJA numpang mekanisme
// yang sudah ada (bukan bikin skema penyimpanan baru) -- efeknya: kata yang
// "dipelajari" otomatis kelihatan & BISA DIHAPUS MANUAL di menu yang sama
// kalau ternyata AI-nya salah tebak, tidak perlu logika "lupa otomatis"
// terpisah. Ditaruh TOP-LEVEL (bukan nested di dalam processTelegramUpdate)
// SENGAJA -- supaya bisa dipanggil dari dekat AWAL processTelegramUpdate()
// (titik isMenuCmdTap, SEBELUM `const DATA_PATH = ...`/`const state = ...`
// sempat dieksekusi) TANPA kena ReferenceError "Cannot access before
// initialization" (pelajaran yang SAMA persis sudah dicatat di komentar
// dekat deklarasi `const state` soal syncBotCommandsForChat()).
async function hapusNlpPendingKv(env, chatId) {
  if (!env.GPS_PUSH_KV) return;
  try { await env.GPS_PUSH_KV.delete(`nlppending:${chatId}`); } catch (e) { /* diabaikan diam-diam -- sama pola dgn readGpsKvJson/writeGpsKvJson */ }
}
async function commitBelajarAliasDariTapNlp(env, chatId, replayTapped) {
  const key = `nlppending:${chatId}`;
  const pending = await readGpsKvJson(env, key);
  // Cocokkan replay yg dipending dgn replay yg BENAR-BENAR ditap sopir --
  // kalau beda (mis. sopir tap tombol lain sama sekali, tidak ada
  // hubungannya dgn saran NLP sebelumnya), JANGAN belajar apa pun.
  if (!pending || pending.replay !== replayTapped || !pending.kategori || !pending.kataBaru) return;
  await hapusNlpPendingKv(env, chatId); // hapus DULU (sebelum tulis) spy tidak ke-commit dobel kalau ada pesan/tap susulan yg kebetulan sama
  const DATA_PATH = env.FLEETOPS_DATA_PATH || 'data/fleetops-data.json';
  const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
    freshRaw.data.commandAliases = freshRaw.data.commandAliases || {};
    const daftar = Array.isArray(freshRaw.data.commandAliases[pending.kategori]) ? freshRaw.data.commandAliases[pending.kategori] : [];
    if (!daftar.includes(pending.kataBaru)) daftar.push(pending.kataBaru);
    freshRaw.data.commandAliases[pending.kategori] = daftar;
    return true;
  });
  console.log(`webhook: belajar alias otomatis ${hasil.ok ? 'BERHASIL' : 'GAGAL (' + (hasil.reason || '') + ')'} -- "${pending.kataBaru}" -> kategori "${pending.kategori}" (chat ${chatId}, terverifikasi tap Ya).`);
}

// v3.268.0 -- BARU: "Log Interaksi Bot" -- catatan SETIAP pesan MASUK ke bot
// dari SEMUA peran (bukan cuma notifikasi yang bot KIRIM KELUAR spt Log
// Notifikasi/notifLog yang sudah ada) -- dipakai command "log" (gerbang akses
// lihat botLogAccessAktif() dekat isFinanceAdminChat() di atas).
//
// KEPUTUSAN ARSITEKTUR (disepakati eksplisit sebelum dibangun):
// (1) Disimpan di KV (GPS_PUSH_KV), BUKAN file GitHub spt fleetops-data.json.
//     Alasan: ini nulis SETIAP pesan masuk (bisa puluhan/ratusan kali sehari,
//     jauh lebih sering dari data lain) -- ghWriteJson()/pushMainDataUpdate()
//     (baca-modif-tulis SELURUH file + retry-on-409) terlalu berat & berisiko
//     bentrok kalau 2 pesan masuk nyaris bersamaan. KV put per-key jauh lebih
//     murah & tidak ada risiko konflik antar-request. KONSEKUENSI yang
//     disepakati: log ini TIDAK backup permanen spt data GitHub -- bisa
//     hilang kalau KV namespace direset/dihapus. Ini cuma alat bantu
//     debug/pantau operasional, BUKAN catatan resmi yang wajib awet.
// (2) Status "berhasil"/"gagal" HANYA mendeteksi ERROR TEKNIS tak tertangani
//     (exception yang lolos sampai ke wrapper processTelegramUpdate()) --
//     BUKAN validasi bisnis per-command (mis. "booking ditolak krn mobil
//     bentrok" tetap tercatat "berhasil", krn bot-nya sendiri tidak crash,
//     cuma membalas pesan penolakan normal). Disepakati eksplisit -- makna
//     "gagal" di log ini SEMPIT (level infrastruktur), BUKAN "command-nya
//     sukses secara bisnis".
// (3) Dipanggil dari WRAPPER processTelegramUpdate() (BUKAN dari dalam
//     processTelegramUpdateInner() yang isinya command dispatch raksasa) --
//     supaya TIDAK perlu menyentuh RATUSAN titik `return` yang tersebar di
//     seluruh function itu. Wrapper cukup try/catch 1x mengelilingi seluruh
//     panggilan inner -- exception apa pun (dari mana pun titiknya) otomatis
//     ketangkap di 1 tempat.
async function catatInteraksiBot(env, logCtx, status, errorMsg) {
  if (!env.GPS_PUSH_KV) return; // fail-open diam-diam, sama pola dgn KV helper lain -- jangan sampai gagal log ikut menggagalkan balasan bot
  if (!logCtx || !logCtx.chatId) return; // belum sempat teridentifikasi chat-nya sama sekali (mis. update bukan pesan/callback, ditolak sebelum chatId diketahui) -- tidak ada yang berarti utk dicatat
  try {
    const key = 'botlog:recent';
    const existing = (await readGpsKvJson(env, key)) || { entries: [] };
    const entry = {
      waktu: Date.now(),
      chatId: logCtx.chatId,
      nama: logCtx.nama || null,
      peran: logCtx.peran || null, // null = chat tidak terdaftar di peran manapun
      pesan: logCtx.pesan || '',
      status, // 'berhasil' | 'gagal'
    };
    if (status === 'gagal' && errorMsg) entry.error = String(errorMsg).slice(0, 200);
    const entries = [entry, ...(Array.isArray(existing.entries) ? existing.entries : [])].slice(0, 50); // cap 50, sama pola dgn pushNotifLog()
    await writeGpsKvJson(env, key, { entries }, 172800); // TTL 2 hari -- log operasional jangka pendek, bukan arsip permanen
  } catch (e) {
    console.log('webhook: catatInteraksiBot gagal (diabaikan):', e.message);
  }
}
// v3.268.0 -- BARU: format tampilan Log Interaksi Bot utk command "log".
// SENGAJA nested DI DALAM processTelegramUpdateInner() (beda dari
// catatInteraksiBot() di atas yang top-level) -- fungsi ini butuh
// escapeHtmlTg() & fmtDurationMinutes()-style helper yang ada di scope itu,
// sedangkan catatInteraksiBot() murni baca/tulis KV tanpa perlu helper apa
// pun dari scope processTelegramUpdate.

/* ----------------------------------------------------------------
   Handler /notify-booking-approval (BARU, v3.166.0) -- kirim 1 pesan
   instan ke 1 admin (dipanggil per-admin dari index.html, sama pola
   dgn resi/notifikasi admin trip-selesai) TAPI pesannya nempel tombol
   inline "✅ Setuju" / "❌ Tolak" berisi callback_data "bk:ya:<id>" /
   "bk:tdk:<id>". Tap tombolnya ditangani di processTelegramUpdate().
   Proteksi sama persis dgn /notify-trip-selesai (header X-Notify-Secret
   harus cocok NOTIFY_SECRET).
   ---------------------------------------------------------------- */
async function handleNotifyBookingApproval(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return new Response(
      JSON.stringify({ error: "Kunci rahasia TELEGRAM_BOT_TOKEN belum diatur di dasbor Cloudflare." }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(
      JSON.stringify({ error: "Kunci rahasia NOTIFY_SECRET belum diatur di dasbor Cloudflare." }),
      { status: 500, headers: jsonHeaders }
    );
  }
  const gotSecret = request.headers.get("X-Notify-Secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Notify secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Body harus JSON valid." }), { status: 400, headers: jsonHeaders });
  }

  const chatId = String(payload.chatId || "").trim();
  const text = String(payload.text || "").trim();
  const bookingId = String(payload.bookingId || "").trim();

  if (!/^-?\d{3,}$/.test(chatId)) {
    return new Response(JSON.stringify({ error: "chatId tidak valid." }), { status: 400, headers: jsonHeaders });
  }
  if (!text) {
    return new Response(JSON.stringify({ error: "text kosong." }), { status: 400, headers: jsonHeaders });
  }
  // Batasi ke pola yang dihasilkan uid() (base36) supaya callback_data yang
  // dikirim balik nanti tidak bisa disusupi karakter aneh.
  if (!/^[a-z0-9]{3,40}$/.test(bookingId)) {
    return new Response(JSON.stringify({ error: "bookingId tidak valid." }), { status: 400, headers: jsonHeaders });
  }
  const safeText = text.length > 4000 ? text.slice(0, 3990) + "\n\n<i>(dipotong)</i>" : text;
  const keyboard = [[
    { text: "✅ Setuju", callback_data: `bk:ya:${bookingId}` },
    { text: "❌ Tolak", callback_data: `bk:tdk:${bookingId}` }
  ]];

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken.trim()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: safeText, parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } })
    });
    const tgBody = await tgRes.json().catch(() => ({}));
    if (!tgRes.ok || !tgBody.ok) {
      return new Response(
        JSON.stringify({ error: "Telegram menolak pesan.", detail: tgBody.description || null }),
        { status: 502, headers: jsonHeaders }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Ada gangguan menghubungi Telegram." }), { status: 500, headers: jsonHeaders });
  }
}

/* ----------------------------------------------------------------
   BARU (webhook realtime) -- baca+ubah+tulis balik HANYA field
   `pendingConversations` di notif-state.json, dengan proteksi SHA-
   conditional (pola sama seperti pushMainDataUpdate), TANPA menyentuh
   field lain (dedup, history, receiptsSent, adminReceiptsSent,
   lastAlertCheckAt, lastUpdateId) yang masih dikelola jalur cron
   (runNotifyCheck) -- supaya kedua jalur ini tidak saling menimpa data.

   BEDA dari pushMainDataUpdate: SENGAJA TIDAK retry otomatis kalau
   bentrok (409/422), karena mutatorFn di sini py efek samping (kirim
   pesan Telegram, termasuk lewat finalizeTutupTrip yang nutup trip) --
   me-retry mutatorFn berisiko kirim pesan/nutup trip 2x. Kalau memang
   bentrok (2 pesan dari chat berbeda nyaris bersamaan), pesan balasan
   ke sopir tetap terkirim, cuma progres percakapannya yang mungkin
   tidak tersimpan -- sopir tinggal ketik "akhiri trip" lagi kalau macet.
   ---------------------------------------------------------------- */
async function pushNotifStateUpdate(env, mutatorFn) {
  const DATA_PATH = env.FLEETOPS_DATA_PATH || 'data/fleetops-data.json';
  const dirOfData = DATA_PATH.includes('/') ? DATA_PATH.slice(0, DATA_PATH.lastIndexOf('/') + 1) : '';
  const STATE_PATH = env.FLEETOPS_NOTIF_STATE_PATH || (dirOfData + 'notif-state.json');
  const CONVO_EXPIRY_MS = 60 * 60 * 1000;

  const { exists, sha, json } = await ghReadJson(env, STATE_PATH);
  const rawExisting = exists ? (json || {}) : {};
  const isOldFlatFormat = rawExisting && typeof rawExisting === 'object'
    && !('dedup' in rawExisting) && !('history' in rawExisting) && !('pendingConversations' in rawExisting);
  const normalized = isOldFlatFormat ? { dedup: rawExisting } : rawExisting;
  normalized.pendingConversations = normalized.pendingConversations || {};
  Object.keys(normalized.pendingConversations).forEach(cid => {
    if (Date.now() - (normalized.pendingConversations[cid].startedAt || 0) > CONVO_EXPIRY_MS) {
      delete normalized.pendingConversations[cid];
    }
  });

  await mutatorFn(normalized.pendingConversations);

  const putRes = await ghWriteJson(env, STATE_PATH, normalized, sha, `chore: update pendingConversations via webhook — ${new Date().toISOString()}`);
  if (!putRes.ok) {
    console.log(`webhook: gagal simpan pendingConversations (HTTP ${putRes.status}) -- kemungkinan bentrok dgn proses lain di saat nyaris bersamaan.`);
  }
  return { ok: putRes.ok };
}

/* ----------------------------------------------------------------
   BARU (webhook realtime) -- proses SATU update Telegram yang masuk
   lewat webhook. Isinya PORTING PERSIS dari logika "tiba" yang
   sebelumnya jalan di checkIncomingReplies() di dalam runNotifyCheck
   (lihat lebih bawah) -- SENGAJA DISALIN (bukan dipakai bareng),
   supaya jalur webhook & jalur cron tidak bisa diam-diam saling
   memengaruhi. runNotifyCheck TIDAK LAGI memanggil checkIncomingReplies()
   (baris pemanggilannya sudah dihapus) begitu webhook aktif -- Telegram
   menolak getUpdates() dipakai bersamaan webhook.

   PENTING: kalau nanti langkah/pertanyaan percakapan "tiba" ini diubah,
   SALIN ULANG perubahan yang sama persis ke checkIncomingReplies() di
   bawah (masih dipertahankan sebagai kerangka/cadangan, walau tidak
   dipanggil) supaya kalau suatu saat webhook di-nonaktifkan & kembali ke
   mode polling, perilakunya tetap sama.
   ---------------------------------------------------------------- */
// v3.181.0 -- PENGHAPUSAN SENGAJA: fungsi isChatIdTercatatSopirAtauAdmin()
// (dulu di sini) yang mensyaratkan Admin Finance HARUS JUGA terdaftar sbg
// Sopir/Admin baru bisa menerima apa pun, sudah DIHAPUS atas permintaan
// eksplisit -- Admin Finance sekarang independen sepenuhnya (state.financeAdmins
// SENDIRI sudah cukup, tidak perlu syarat tambahan). Fitur "Pengingat 5 Jam"
// (nota belum dikirim) yang dulu ada di sini juga sudah DIHAPUS TOTAL.

// v3.253.0 -- BARU: batas pemakaian HARIAN utk Tingkat 3 (Workers AI), supaya
// TIDAK PERNAH sampai menembus 10.000 neuron/hari gratis dari Cloudflare (lihat
// catatan biaya di SOP-Development-FleetOps.md) -- dengan begitu fitur ini
// dijamin TIDAK PERNAH menimbulkan tagihan, walau volume pesan sopir naik jauh
// dari perkiraan awal. Pola KV counter per-hari ini SAMA PERSIS dgn pola
// rate-limit PIN yang sudah ada (lihat handleVerifyPin() di bawah --
// readGpsKvJson/writeGpsKvJson), key-nya dipatok ke tanggal UTC (BUKAN WIB)
// supaya SEJALAN dgn jam reset kuota neuron Cloudflare yang memang di 00:00 UTC.
// FAIL-CLOSED (bukan fail-open) kalau GPS_PUSH_KV belum di-bind -- BEDA dari
// kebanyakan fitur non-keamanan lain di proyek ini yang fail-open kalau KV
// tidak ada (lihat SOP bagian "Kebiasaan Baik") -- SENGAJA, karena fungsi ini
// sifatnya PROTEKSI BIAYA: tanpa KV, jumlah pemakaian tidak bisa dilacak lintas
// request sama sekali, jadi lebih aman menonaktifkan Tingkat 3 total daripada
// membiarkannya jalan tanpa batas apa pun.
// Batas defaultnya bisa diubah TANPA ubah kode/deploy ulang -- tinggal tambah
// Environment Variable (BUKAN Secret) `NLP_AI_DAILY_LIMIT` di dashboard Worker
// -> Settings -> Variables, isi angka batas panggilan/hari yang diinginkan.
const NLP_AI_DAILY_LIMIT_DEFAULT = 300; // ~300 panggilan x ~1-2 neuron/panggilan =~ 300-600 neuron/hari -- longgar utk pemakaian wajar 1 armada, tapi TETAP ada batas keras, jauh di bawah 10.000 gratis/hari.
async function nlpAiBudgetTersedia(env) {
  if (!env.GPS_PUSH_KV) return false; // fail-closed: tanpa KV, Tingkat 3 dimatikan total demi keamanan biaya
  const limit = Math.max(1, Number(env.NLP_AI_DAILY_LIMIT) || NLP_AI_DAILY_LIMIT_DEFAULT);
  const tanggalUtc = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC -- sejalan dgn jam reset neuron Cloudflare (00:00 UTC), BUKAN tengah malam WIB
  const key = `nlpai:budget:${tanggalUtc}`;
  const budgetState = (await readGpsKvJson(env, key)) || { count: 0 };
  if ((budgetState.count || 0) >= limit) {
    console.log(`webhook: nlpAiBudgetTersedia -- batas harian Tingkat 3 (${limit}/hari) sudah tercapai, sisa pesan hari ini jatuh ke Tingkat 2/unknownCommandMessage() spt biasa.`);
    return false;
  }
  // Naikkan counter DULU (sebelum benar2 memanggil env.AI.run), bukan setelah
  // panggilan sukses -- supaya percobaan yang errornya di tengah jalan (mis.
  // timeout) tetap ikut kehitung, jaga2 kalau neuron-nya sempat terpakai di
  // sisi Cloudflare walau responsnya gagal diterima di sini. TTL 2 hari (bukan
  // 1) sbg jaring pengaman kalau ada selisih jam antara worker & KV.
  await writeGpsKvJson(env, key, { count: (budgetState.count || 0) + 1 }, 172800);
  return true;
}
// v3.252.0 -- BARU: NLP Tingkat 3 (fallback terakhir, cuma dicoba kalau
// Tingkat 1 & 2 sudah gagal). Pakai Cloudflare Workers AI (binding `env.AI`)
// -- BUKAN OpenAI/Anthropic API -- supaya GRATIS (10.000 neuron/hari cuma-cuma,
// lihat SOP) & TIDAK butuh Cloudflare Secret/API key pihak ketiga apa pun,
// beda dari integrasi API luar lain di proyek ini (GPS.id/ORS yg memang butuh
// Secret). Kalau binding `env.AI` belum diaktifkan lewat dashboard Cloudflare
// Worker (Settings -> Bindings -> Workers AI), fungsi ini fail-open diam-diam
// (return null, jatuh ke unknownCommandMessage() spt sebelum fitur ini ada) --
// TIDAK PERNAH melempar error yang bisa menghentikan proses pesan sopir.
// Prompt SENGAJA membatasi jawaban model ke index dari `candidates` yang
// dioper (bukan teks bebas) supaya model tidak bisa "mengarang" command yang
// tidak ada di daftar.
async function nlpWorkersAiFallback(env, textAsli, candidates) {
  if (!env.AI) return null;
  if (!(await nlpAiBudgetTersedia(env))) return null; // batas harian tercapai (atau KV belum di-bind) -> Tingkat 3 dimatikan, jatuh normal ke unknownCommandMessage()
  try {
    const daftar = candidates.map((c, i) => `${i}: ${c.replay} (${c.label})`).join('\n');
    const prompt = `Kamu pengklasifikasi perintah bot armada mobil berbahasa Indonesia. Sopir mengetik kalimat bebas (boleh informal/typo). Cocokkan ke SATU nomor command paling sesuai di bawah, atau -1 kalau tidak ada satu pun yang cocok. Balas HANYA JSON, format persis {"idx": <angka>}, tanpa teks lain apa pun.\n\nDaftar command:\n${daftar}\n\nKalimat sopir: "${textAsli}"`;
    const res = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20,
    });
    const raw = (res && (res.response || (res.result && res.result.response))) || '';
    const m = String(raw).match(/-?\d+/);
    if (!m) return null;
    const idx = parseInt(m[0], 10);
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) return null;
    return candidates[idx];
  } catch (e) {
    console.log('webhook: nlpWorkersAiFallback gagal (diabaikan, fail-open):', e.message);
    return null;
  }
}

// v3.268.0 -- BARU: wrapper TIPIS di luar processTelegramUpdateInner() (nama
// asli function ini SEBELUM v3.268.0) -- SATU-SATUNYA tujuannya membungkus
// seluruh pemrosesan 1 update Telegram dgn try/catch 1x, supaya bisa catat
// "Log Interaksi Bot" (lihat catatInteraksiBot() dekat pushMainDataUpdate())
// TANPA perlu menyentuh RATUSAN titik `return` yang tersebar di dalam
// function raksasa itu. `logCtx` adalah objek KOSONG yang di-passing by
// REFERENCE ke dalam -- processTelegramUpdateInner() sendiri yang mengisi
// logCtx.chatId/pesan (SEGERA setelah keduanya diketahui, dekat awal
// function) & logCtx.nama/peran (BELAKANGAN, setelah `state` siap) begitu
// informasinya tersedia. Exception apa pun dari titik MANA PUN di dalam
// inner otomatis ketangkap di SINI, tercatat "gagal" (rethrow lagi supaya
// `.catch(e=>console.log(...))` yang sudah ada di handleTelegramWebhook()
// TETAP jalan spt sebelumnya -- perilaku existing TIDAK berubah, ini murni
// TAMBAHAN observasi di sekelilingnya).
async function processTelegramUpdate(update, env) {
  const logCtx = {};
  try {
    await processTelegramUpdateInner(update, env, logCtx);
    await catatInteraksiBot(env, logCtx, 'berhasil');
  } catch (e) {
    await catatInteraksiBot(env, logCtx, 'gagal', e && e.message);
    throw e;
  }
}
async function processTelegramUpdateInner(update, env, logCtx) {
  const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) { console.log('webhook: TELEGRAM_BOT_TOKEN belum diatur.'); return; }

  // v3.145.0 -- Dukung tombol tap "Ya/Tidak" (inline keyboard Telegram),
  // bukan cuma ketik manual. Tap tombol datang sebagai update.callback_query
  // (BUKAN update.message) -- data tombol ("ya"/"tidak") "berpura-pura" jadi
  // teks biasa di sini, supaya lewat SELURUH alur percakapan yang sama
  // persis tanpa duplikasi logika. Ketik manual "ya"/"tidak" tetap berfungsi
  // seperti biasa -- tombol cuma jalan pintas, bukan pengganti.
  const cqRaw = update && update.callback_query;
  const msg = (update && update.message) || (cqRaw && cqRaw.message);
  if (!msg) return;
  // BARU: tombol "menu perintah" (lihat menuCommandKeyboard()) -- dipakai
  // supaya orang bisa TAP command (mis. "kecepatan" khusus Administrator)
  // alih-alih ketik manual. Beda dari tombol cq lain (Ya/Tidak, pilih mobil,
  // dst): callback_data-nya SENGAJA diawali "cmd:" dan di sini kita anggap
  // cq-nya "tidak ada" (cq = null) untuk sisa alur di bawah, supaya lolos
  // SEMUA guard `!cq` yang ada di tiap command (guard itu sengaja dipasang
  // supaya tombol cq LAIN tidak nyasar ke-match keyword command). Efeknya:
  // tap tombol "cmd:kecepatan" diperlakukan PERSIS seperti ketik "kecepatan"
  // manual, lewat kode yang sama persis, tanpa duplikasi logika.
  const cqDataRaw = cqRaw ? String(cqRaw.data || '').trim() : '';
  const isMenuCmdTap = !!(cqRaw && cqDataRaw.startsWith('cmd:'));
  const cq = isMenuCmdTap ? null : cqRaw;
  const textRaw = isMenuCmdTap ? cqDataRaw.slice(4) : (cq ? cqDataRaw : (msg.text || '').trim());
  // BARU: foto/dokumen (nota, tanda terima) yang dikirim sopir SERING datang
  // TANPA teks/caption sama sekali -- dulu langsung dibuang di sini sebelum
  // sempat ditangani. Lolos-kan kalau ada lampiran media, walau textRaw
  // kosong (blok penanganannya ada di bawah, setelah state dibaca).
  const isMediaMsg = !cq && (
    (Array.isArray(msg.photo) && msg.photo.length > 0) ||
    (msg.document && msg.document.file_id)
  );
  if (!textRaw && !isMediaMsg) return;
  // v3.173.0 -- Dukungan tap-link "/berangkat" dkk di pesan Rekomendasi
  // Perintah (lihat commandReferenceMessage() di bawah): Telegram otomatis
  // mewarnai kata berawalan "/" jadi link & mengirimkannya PERSIS seperti apa
  // adanya kalau di-tap (termasuk slash-nya) -- jadi di sisi sini kita lucuti
  // awalan "/word" (+ "@namabot" kalau ada, format grup) jadi kata polos
  // SEBELUM dicocokkan ke keyword manapun. Ketik manual TANPA slash (mis.
  // "berangkat") tetap berfungsi seperti biasa, tidak terpengaruh sama sekali
  // -- regex ini cuma match kalau memang diawali "/".
  const text = textRaw.replace(/^\/([a-z0-9_]+)(?:@\w+)?/i, '$1').toLowerCase();
  const chatId = String(msg.chat.id);
  // v3.268.0 -- BARU: isi bagian AWAL logCtx (chatId + pesan mentah) SEGERA
  // di sini -- ini titik PALING AWAL keduanya sudah pasti diketahui. Bagian
  // nama/peran diisi BELAKANGAN (butuh `state` yg baru siap lebih ke bawah,
  // lihat dekat `state.superAdmins`). Dipotong 300 karakter -- log ini utk
  // ditelusuri manusia lewat chat Telegram (ada limit panjang pesan juga),
  // BUKAN penyimpanan lengkap/verbatim tanpa batas.
  if (logCtx) {
    logCtx.pesan = isMediaMsg
      ? (textRaw ? `[foto/dokumen] ${textRaw}`.slice(0, 300) : '[foto/dokumen]')
      : String(textRaw || '').slice(0, 300);
    logCtx.chatId = chatId;
  }

  // v3.265.0 -- lihat commitBelajarAliasDariTapNlp() dekat pushMainDataUpdate()
  // di atas file utk penjelasan lengkap fitur "Tingkat 3 mengajari Tingkat
  // 1.5". Cuma relevan kalau tap ini memang tap tombol "cmd:..." (isMenuCmdTap)
  // -- fungsi di dalamnya sendiri yang memverifikasi apakah tap ini benar
  // cocok dgn 1 saran NLP yg sedang menunggu konfirmasi, jadi aman dipanggil
  // di sini tanpa gerbang tambahan. Fire-and-forget (TIDAK di-`await`) supaya
  // balasan command SEBENARNYA di bawah tidak ikut tertunda oleh proses
  // commit alias ini -- aman krn seluruh processTelegramUpdate() sudah
  // dibungkus ctx.waitUntil() di handleTelegramWebhook(), promise ini tetap
  // sempat selesai di background walau tidak ditunggu di sini.
  if (isMenuCmdTap) {
    commitBelajarAliasDariTapNlp(env, chatId, text).catch(e => console.log('webhook: commitBelajarAliasDariTapNlp gagal (diabaikan):', e.message));
  }

  const ADMIN_CHAT_IDS = (env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

  // Hilangkan "loading" di tombol sopir + copot tombolnya dari pesan lama
  // supaya tidak bisa di-tap dobel (mencegah odometer/step kepilih 2x kalau
  // sopir tap 2x cepat). Kegagalan di sini TIDAK menghentikan proses (mis.
  // pesan sudah lama/dihapus) -- tidak boleh memblokir alur tutup trip.
  if (cqRaw) {
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cqRaw.id })
    }).catch(() => {});
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } })
    }).catch(() => {});
  }

  // Tombol Ya/Tidak dipakai berulang di konfirmasi odometer GPS.id.
  const KB_YA_TIDAK = [[{ text: '✅ Ya, benar', callback_data: 'ya' }, { text: '✏️ Isi manual', callback_data: 'tidak' }]];

  async function sendTg(cid, txt, keyboard) {
    try {
      const body = { chat_id: cid, text: txt, parse_mode: 'HTML' };
      if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (e) { console.log(`webhook: gagal kirim pesan ke ${cid}:`, e.message); }
  }
  // v3.212.1 -- BARU: kirim ulang foto pakai file_id Telegram yang SUDAH
  // tersimpan (bukan upload bytes baru) -- dipakai fitur Barcode MyPertamina
  // per mobil (lihat blok "qrPertaminaFileId" di bawah), sama pola dgn
  // resiImageFileId yang sudah ada (lihat sendPhoto di dekat baris ~4327).
  async function sendTgPhotoById(cid, fileId, caption) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cid, photo: fileId, caption, parse_mode: 'HTML' }),
      });
    } catch (e) { console.log(`webhook: gagal kirim foto ke ${cid}:`, e.message); }
  }
  // v3.??? -- ATURAN ANTI-SPAM (dedup Chat ID): dipakai di SETIAP tempat yang
  // mengirim notifikasi Telegram yang SAMA ke lebih dari satu daftar
  // penerima sekaligus (mis. ADMIN_CHAT_IDS/Secret + Admin Penerima
  // Notifikasi Telegram + Administrator). Kalau 1 Chat ID yang SAMA ternyata
  // terdaftar lebih dari sekali (baik di 1 daftar yang sama maupun tersebar
  // di beberapa daftar berbeda) & sama-sama berhak menerima notifikasi ini,
  // dia HANYA dikirimi SATU kali (kemunculan PERTAMA yang menang, urutan
  // sesuai urutan `recipients` didaftarkan) -- supaya orang itu tidak
  // menerima pesan duplikat/spam untuk 1 kejadian yang sama. Lihat juga
  // catatan lengkap aturan ini di menu "Notifikasi Telegram" (index.html).
  // recipients: array of { chatId, text, keyboard? }
  async function sendTgUnique(recipients) {
    const sudahDikirim = new Set();
    for (const r of recipients) {
      const cid = (r && r.chatId != null) ? r.chatId.toString().trim() : '';
      if (!cid || sudahDikirim.has(cid)) continue;
      sudahDikirim.add(cid);
      await sendTg(cid, r.text, r.keyboard);
    }
  }
  // v3.173.0 -- Daftarkan command Telegram KHUSUS 1 chat ini (scope "chat"),
  // dipanggil sebelum kirim commandReferenceMessage(). Ini BUKAN syarat utama
  // supaya tap link "/berangkat" dkk di pesan itu langsung terkirim -- itu
  // sudah otomatis jalan berkat entity "bot_command" bawaan Telegram begitu
  // teksnya diawali "/", TANPA perlu registrasi ini. Registrasi di sini
  // fungsinya bonus: memunculkan command yang sama di ikon "/" bawaan
  // Telegram (menu & autocomplete saat mengetik "/"), supaya konsisten.
  // Daftarnya beda per chat (role sopir/admin/administrator) & dipanggil ULANG
  // tiap kali Rekomendasi Perintah dibuka, supaya selalu sinkron kalau ada
  // perubahan status chat itu. Kegagalan di sini SENGAJA diam (try/catch
  // kosong) -- tap-link tetap berfungsi walau registrasi ini gagal.
  async function syncBotCommandsForChat(cid) {
    const driverObj = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === cid);
    const notifAdminObj = (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === cid);
    const cmds = [];
    if (driverObj) cmds.push({ command: 'berangkat', description: 'Mulai trip baru' });
    if (driverObj) cmds.push({ command: 'akhiritrip', description: 'Akhiri trip yang sedang jalan' });
    if (driverObj && !isAdminOrSuperAdmin(cid)) cmds.push({ command: 'oli', description: 'Status servis mobil kamu' });
    if (driverObj || notifAdminObj) cmds.push({ command: 'isi', description: 'Isi BBM / Saldo E-Toll' });
    if (driverObj) cmds.push({ command: 'biaya', description: 'Catat biaya operasional/pribadi' });
    if (driverObj) cmds.push({ command: 'kirim', description: 'Teruskan foto nota ke Admin Finance' });
    if (driverObj || notifAdminObj) cmds.push({ command: 'booking', description: 'Pesan mobil baru' });
    if (driverObj || notifAdminObj) cmds.push({ command: 'batalbooking', description: 'Batalkan booking mobil' });
    if (isSaldoAllowedUser(cid)) cmds.push({ command: 'saldo', description: 'Cek saldo/rekap' });
    if (isFinanceAdminChat(cid) && !isSaldoAllowedUser(cid)) cmds.push({ command: 'saldo', description: 'Cek E-Toll/BBM/Dokumen/Budget' }); // BARU -- Finance-only, bukan Admin/Sopir
    if (isAdminNotifUser(cid)) cmds.push({ command: 'cek', description: 'Mobil yang sedang jalan' });
    if (isAdminOrSuperAdmin(cid)) cmds.push({ command: 'lokasi', description: 'Lokasi terkini 1 mobil' });
    if (isAdminOrSuperAdmin(cid) || isFinanceAdminChat(cid)) cmds.push({ command: 'service', description: '3 data servis terbaru' });
    if (isSuperAdminChat(cid)) cmds.push({ command: 'kecepatan', description: 'Ranking kecepatan sopir (Administrator)' });
    if (isSuperAdminChat(cid)) cmds.push({ command: 'lognotif', description: 'Log Notifikasi (bot kirim keluar, Administrator)' });
    if (botLogAccessAktif(cid)) cmds.push({ command: 'log', description: 'Log Interaksi Bot (semua pesan masuk)' });
    if (isSuperAdminChat(cid)) cmds.push({ command: 'update', description: '5 update fitur bot terbaru (Administrator)' });
    if (driverObj || notifAdminObj || isFinanceAdminChat(cid) || isSuperAdminChat(cid)) cmds.push({ command: 'id', description: 'Ringkasan akun & data Anda' });
    cmds.push({ command: 'rekomendasi', description: 'Lihat semua perintah lagi' });
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: cmds, scope: { type: 'chat', chat_id: cid } })
      });
    } catch (e) { console.log(`webhook: gagal setMyCommands utk ${cid}:`, e.message); }
  }

  const DATA_PATH = env.FLEETOPS_DATA_PATH || 'data/fleetops-data.json';
  let dataRead;
  try {
    dataRead = await ghReadJson(env, DATA_PATH);
  } catch (e) {
    console.log('webhook: gagal baca data utama:', e.message);
    return;
  }
  if (!dataRead.exists) return;
  const state = dataRead.json.data || {};
  state.cars = state.cars || [];
  state.usage = state.usage || [];
  state.drivers = state.drivers || [];
  state.etollCards = state.etollCards || [];
  state.notifAdmins = state.notifAdmins || [];
  // BARU -- Alias perintah bot Telegram yang bisa diisi SENDIRI oleh Super
  // Admin lewat menu "🔔 Notifikasi Telegram per Peran" -> "✏️ Alias" di
  // index.html (PIN 009900), TANPA perlu ubah kode/deploy ulang worker.js.
  // Bentuk: { <kategori>: ['alias1','alias2', ...] }. Kata bawaan/default
  // (mis. DRIVER_OLI_KEYWORDS) TETAP ada apa pun isi sini -- alias di sini
  // cuma TAMBAHAN, lihat withAliases() di bawah. Kategori yang dikenal saat
  // ini: 'oli', 'cek', 'lokasi', 'service', 'kecepatan', dan 'saldo:<kode>'
  // (kode kategori Saldo, mis. 'saldo:et' utk E-Toll -- lihat
  // SALDO_KEYWORD_TO_CATEGORY).
  // WAJIB DEV: setiap kali menambah PERINTAH BARU di bot Telegram (kata
  // kunci ketik-bebas maupun /command), sesuaikan juga dengan menu
  // "Notifikasi Telegram per Peran" di index.html -- (1) kalau perintah itu
  // MEMICU notifikasi berkala/kiriman ke suatu peran, tambahkan togel
  // centang izinnya di rolePrefs (lihat getNotifRolePrefs() di index.html);
  // (2) kalau kata-kunci pemicunya masuk akal untuk dikustomisasi user,
  // bungkus daftar keyword-nya dengan withAliases(defaults, 'kategoriBaru')
  // di bawah supaya otomatis bisa ditambah alias lewat UI, bukan cuma lewat
  // kode.
  state.commandAliases = state.commandAliases || {};
  function withAliases(defaults, kategori) {
    const custom = Array.isArray(state.commandAliases[kategori]) ? state.commandAliases[kategori] : [];
    const bersih = custom.map(a => String(a || '').trim().toLowerCase()).filter(Boolean);
    return Array.from(new Set([...defaults, ...bersih]));
  }
  // BARU -- helper serupa withAliases() di atas, tapi dibungkus fungsi
  // supaya bisa dipanggil dari scope callback manapun di dalam
  // processTelegramUpdate (mis. dalam pushNotifStateUpdate) tanpa perlu
  // deklarasi const berulang di tiap scope. Menambah kategori BARU ke sini
  // -> tambahkan juga entrinya di ALIAS_KATEGORI_CATALOG (index.html).
  function menuAliases(){ return withAliases(['menu'], 'menu'); }
  function rekomendasiAliases(){ return withAliases(['rekomendasi'], 'rekomendasi'); }
  function batalAliases(){ return withAliases(['batal'], 'batal'); }
  function tibaAliases(){ return withAliases(['akhiri trip', 'akhiritrip', 'selesai trip', 'selesaitrip'], 'tiba'); }
  function biayaAliases(){ return withAliases(['biaya', 'operasional', 'pribadi'], 'biaya'); }
  function bookingAliases(){ return withAliases(['booking', 'pesan', 'boking', 'keep'], 'booking'); }
  // BARU -- perintah "batalkan booking mobil" via chat. Sengaja beda kategori
  // dari bookingAliases() (bukan sub-kata dari itu) supaya bisa diberi alias
  // sendiri lewat menu "✏️ Alias" tanpa ikut kena alias booking BARU.
  function batalBookingAliases(){ return withAliases(['batalkan booking', 'batal booking', 'batalbooking', 'cancel booking'], 'batalbooking'); }
  function mulaiTripAliases(){ return withAliases(['mulai trip', 'mulai', 'jalan', 'berangkat', 'catat perjalanan'], 'mulaitrip'); }
  // v3.266.0 -- BARU: alias utk command "update"/"bot" (5 update fitur
  // terbaru KHUSUS Bot Telegram, lihat buildBotUpdateText()/BOT_CHANGELOG
  // dekat processTelegramUpdate() di bawah).
  function updateBotAliases(){ return withAliases(['update', 'bot'], 'botupdate'); }
  // v3.267.0 -- BARU: alias utk command "id" -- ringkasan akun UNTUK DIRI
  // SENDIRI (lihat buildIdSummaryText() dekat buildDriverStatsText() di
  // bawah). BEDA dari kecepatan/log/update di atas -- ini BUKAN command
  // rahasia Administrator, terbuka utk SEMUA peran terdaftar (Sopir/Admin
  // Notifikasi/Finance/Administrator), makanya TIDAK diberi togel Fitur
  // Tersembunyi.
  function idAliases(){ return withAliases(['id'], 'id'); }
  // v3.268.0 -- BARU: alias utk command "log" (Log Interaksi Bot -- SEMUA
  // pesan masuk, BEDA dari "lognotif" yang isinya notifikasi keluar). Akses
  // diatur via botLogAccessAktif() (panel Notifikasi Telegram per Peran),
  // BUKAN togel Fitur Tersembunyi -- makanya kategori alias-nya juga 'botlog'
  // TERPISAH dari 'notiflog' (kategori command lama).
  function botLogAliases(){ return withAliases(['log'], 'botlog'); }
  function yaAliases(){ return withAliases(['ya', 'iya', 'y', 'benar', 'betul', 'yes', 'ok', 'oke'], 'ya'); }
  function tidakAliases(){ return withAliases(['tidak', 'gak', 'ga', 'enggak', 'nggak', 'no', 'salah'], 'tidak'); }
  // BARU: Admin Finance -- daftar TERPISAH TOTAL dari notifAdmins, cuma
  // menerima foto nota/tanda terima trip dari sopir (lihat blok "kirim" &
  // pengingat 5 jam di bawah/di runNotifyCheck). Diatur dari menu
  // Pengaturan > Admin Finance di index.html.
  state.financeAdmins = state.financeAdmins || [];
  // Administrator: daftar terpisah dari notifAdmins biasa -- dibuat/dihapus
  // HANYA lewat menu rahasia PIN Kelola Admin di Telegram (Cloudflare Secret
  // FLEETOPS_TELEGRAM_ADMINISTRATOR_PIN, lihat blok "kelolaAdminPin" & "sa:" di
  // bawah), tidak pernah lewat aplikasi web. Sekali chatId
  // terdaftar di sini, aksesnya PERMANEN (tidak perlu PIN lagi tiap pakai
  // fitur "kecepatan"/nama sopir) sampai dihapus lagi lewat menu yang sama.
  state.superAdmins = state.superAdmins || [];
  // v3.268.0 -- BARU: lengkapi logCtx (chatId/pesan sudah diisi jauh di atas,
  // segera setelah `chatId` diketahui) dgn nama & peran, SEKARANG baru bisa --
  // butuh `state` (drivers/notifAdmins/financeAdmins/superAdmins) & fungsi
  // gerbang peran (isSuperAdminChat dkk) yang keduanya baru siap di titik
  // ini. Dipakai catatInteraksiBot() (dipanggil dari wrapper
  // processTelegramUpdate() di luar processTelegramUpdateInner() ini) utk
  // command "log" (log interaksi bot) yang baru -- lihat penjelasan lengkap
  // di dekat definisi catatInteraksiBot()/peranUntukRolePrefs().
  if (logCtx) {
    const driverLog = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
    const notifAdminLog = (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === chatId);
    const financeAdminLog = (state.financeAdmins || []).find(fa => (fa.chatId || '').toString().trim() === chatId);
    logCtx.peran = isSuperAdminChat(chatId) ? 'superadmin' : financeAdminLog ? 'finance' : isAdminNotifUser(chatId) ? 'admin' : driverLog ? 'sopir' : null;
    logCtx.nama = driverLog ? driverLog.nama : notifAdminLog ? (notifAdminLog.nama || 'Admin') : financeAdminLog ? (financeAdminLog.nama || 'Finance') : isSuperAdminChat(chatId) ? 'Administrator' : null;
  }
  state.documents = state.documents || [];
  state.services = state.services || [];
  state.bookings = state.bookings || [];
  // BARU (fitur "mulai perjalanan" via Telegram) -- Data Tujuan belum pernah
  // dibaca dari worker.js sebelumnya (cuma dipakai di index.html). Dibaca di
  // sini utk cari rekomendasi tujuan yang mirip/sudah ada saat sopir mengetik
  // tujuan manual lewat chat, lihat cariSaranTujuan() & alur 'mulai_trip'.
  state.destinations = state.destinations || [];

  // v3.219.0 -- BARU: auto-refresh daftar "/" perintah Telegram (native
  // autocomplete) SEKALI per chat, tiap kali COMMAND_SYNC_VERSION dinaikkan
  // -- supaya perubahan nama perintah (mis. /tiba -> /akhiritrip di v3.216.0)
  // otomatis nyampe ke semua sopir/admin TANPA mereka perlu ketik
  // "rekomendasi" manual dulu (syncBotCommandsForChat() di bawah SEBELUMNYA
  // cuma dipicu manual lewat itu). Ditandai per-chat lewat GPS_PUSH_KV
  // (data ephemeral, BUKAN data utama -- aman kalau KV belum di-bind, cuma
  // berarti auto-sync ini dilewati & balik ke perilaku lama "ketik
  // rekomendasi manual", tidak mempengaruhi fungsi bot lainnya sama sekali).
  // NAIKKAN angka COMMAND_SYNC_VERSION ini tiap kali daftar/makna perintah
  // "/" berubah lagi ke depannya, supaya semua chat otomatis di-sync ulang.
  // PENTING (bug nyata v3.219.0->v3.222.x): blok ini SENGAJA ditaruh DI SINI,
  // SETELAH state diinisialisasi & dinormalisasi di atas -- bukan lagi di
  // dekat awal function (sebelum `const state = ...`). syncBotCommandsForChat()
  // & fungsi yg dipanggilnya (actorNameForChat/isSaldoAllowedUser/
  // isSuperAdminChat) semua baca `state`, jadi manggilnya sebelum baris
  // `const state = ...` bikin ReferenceError "Cannot access 'state' before
  // initialization" (temporal dead zone) -- akibatnya SELURUH proses pesan
  // itu gagal diam-diam (webhook sudah kadung balas 200 OK), sopir/admin
  // sama sekali tidak dapat balasan apa pun. Jangan pindahkan blok ini balik
  // ke atas `const state = ...` lagi.
  // v3.223.0 -- FIX: dikenalUntukSync SEBELUMNYA tidak pernah mengecek
  // isFinanceAdminChat(), jadi chat yang HANYA terdaftar sbg Admin Finance
  // (bukan sekaligus sopir/notifAdmin/superadmin) dianggap "tidak dikenal"
  // dan auto-sync menu "/" (rekomendasi perintah) tidak pernah jalan utk
  // mereka -- satu-satunya cara menu itu muncul adalah kalau mereka ketik
  // "rekomendasi" manual sendiri. Ditambahkan isFinanceAdminChat() di bawah.
  // COMMAND_SYNC_VERSION DINAIKKAN (2 -> 3) supaya semua chat yang KV-nya
  // sudah kadung tersimpan v:2 (termasuk Admin Finance yg selama ini
  // terlewat) ikut di-sync ULANG sekali, bukan cuma chat baru ke depannya.
  const COMMAND_SYNC_VERSION = 3;
  if (!cqRaw && env.GPS_PUSH_KV) {
    const syncKey = `cmdsync:${chatId}`;
    const syncState = await readGpsKvJson(env, syncKey);
    if (!syncState || syncState.v !== COMMAND_SYNC_VERSION) {
      const dikenalUntukSync = actorNameForChat(chatId) !== 'Telegram' || isSaldoAllowedUser(chatId) || isSuperAdminChat(chatId) || isFinanceAdminChat(chatId);
      if (dikenalUntukSync) {
        await syncBotCommandsForChat(chatId);
      }
      await writeGpsKvJson(env, syncKey, { v: COMMAND_SYNC_VERSION }, 15552000); // ~180 hari, cukup lama
    }
  }

  // ---- Helper (PORTING PERSIS dari runNotifyCheck) ----
  function escapeHtmlTg(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  }
  function fmtMoney(n) {
    n = Number(n) || 0;
    return 'Rp ' + n.toLocaleString('id-ID');
  }
  function carLabel(carId) {
    const c = state.cars.find(x => x.id === carId);
    return c ? (c.merk + ' ' + c.modelMobil + ' — ' + c.plat) : '(mobil telah dihapus)';
  }
  function driverLabel(driverId, legacyDriverText) {
    if (driverId) {
      const d = state.drivers.find(x => x.id === driverId);
      if (d) return d.nama;
      return legacyDriverText || '(sopir telah dihapus)';
    }
    return legacyDriverText || '-';
  }
  // Administrator: level akses terpisah & lebih tinggi dari notifAdmins biasa
  // (lihat state.superAdmins di atas) -- dipakai KHUSUS utk fitur rahasia
  // "kecepatan"/nama sopir, tidak berlaku utk fitur admin lain (cek/saldo dst,
  // itu tetap pakai isAdminNotifUser/isSaldoAllowedUser seperti biasa).
  function isSuperAdminChat(cid) {
    return (state.superAdmins || []).some(a => (a.chatId || '').toString().trim() === cid);
  }
  // Rekap 1 sopir: total trip/KM/jam (pola sama dgn computeTotalKmJamForDriver
  // di index.html) + rata-rata kecepatan dari trip.avgSpeedKmh yang tersimpan
  // (diisi sekali saat trip ditutup, lihat finalizeTutupTrip/computeTripAvgSpeedKmh) --
  // BUKAN dihitung ulang live dari GPS.id supaya tidak boros kuota.
  function driverTripStats(driverId) {
    const trips = state.usage.filter(u => u.driverId === driverId && u.odoKeluar != null && u.odoKembali != null && u.odoKembali >= u.odoKeluar);
    const totalKm = trips.reduce((s, u) => s + (u.odoKembali - u.odoKeluar), 0);
    const totalMenit = trips.reduce((s, u) => s + (getTripDurationMinutes(u) || 0), 0);
    const speedTrips = trips.filter(u => u.avgSpeedKmh != null);
    const avgSpeed = speedTrips.length > 0
      ? Math.round((speedTrips.reduce((s, u) => s + u.avgSpeedKmh, 0) / speedTrips.length) * 10) / 10
      : null;
    // BARU (poin 3): trip yg SUDAH selesai tapi GAGAL dihitung kecepatannya
    // (lihat trip.avgSpeedError, diisi computeTripAvgSpeedKmh) -- supaya
    // Administrator tahu ADA masalah (bukan cuma "belum ada data"), dan alasan
    // paling baru sbg contoh cepat didiagnosis.
    const gagalTrips = trips.filter(u => u.avgSpeedKmh == null && u.avgSpeedError);
    const lastError = gagalTrips.length ? gagalTrips[gagalTrips.length - 1].avgSpeedError : null;
    return { jumlahTrip: trips.length, totalKm, totalMenit, avgSpeed, tripsWithSpeedCount: speedTrips.length, gagalCount: gagalTrips.length, lastError };
  }
  function buildDriverStatsText(driver) {
    const t = driverTripStats(driver.id);
    const avgLine = t.avgSpeed != null
      ? `Rata-rata Kecepatan: ${t.avgSpeed} km/j (dari ${t.tripsWithSpeedCount} trip berdata GPS)`
      : 'Rata-rata Kecepatan: belum ada data GPS';
    const gagalLine = t.gagalCount > 0 ? `\n⚠️ ${t.gagalCount} trip gagal dihitung kecepatannya. Contoh alasan terakhir: ${escapeHtmlTg(t.lastError)}` : '';
    return `🧑\u200d✈️ <b>${escapeHtmlTg(driver.nama)}</b>\n\nTotal Trip: ${t.jumlahTrip}\nTotal KM: ${t.totalKm > 0 ? t.totalKm.toLocaleString('id-ID') + ' KM' : '-'}\nTotal Jam Jalan: ${t.totalMenit > 0 ? fmtDurationMinutes(t.totalMenit) : '-'}\n${avgLine}${gagalLine}`;
  }
  // v3.267.0 -- BARU: command "id" -- ringkasan akun UNTUK DIRI SENDIRI,
  // khusus chat yang SUDAH TERDAFTAR (Sopir/Admin Notifikasi/Finance/
  // Administrator). Return null kalau chat ini TIDAK terdaftar di peran
  // manapun -- pemanggil (blok handler "id" di bawah) yang memutuskan diam
  // total, pola SAMA dgn "chat tak dikenal -> diam-diam diabaikan" yang
  // sudah ada di "menu"/"rekomendasi".
  //
  // SENGAJA menampilkan SEMUA peran sekaligus kalau 1 chat ID terdaftar
  // lebih dari 1 peran (mis. Sopir yang juga Admin Notifikasi) -- BUKAN
  // cuma peran "tertinggi" -- supaya orang yang perannya ganda tidak
  // kebingungan kenapa sebagian aksesnya "hilang" dari ringkasan.
  //
  // Untuk Admin Notifikasi/Finance/Administrator: datanya SENGAJA dibuat
  // TIPIS (cuma identitas + nama peran) -- peran ini melihat data ARMADA,
  // bukan data pribadi, jadi tidak ada "punya sendiri" yang bisa
  // diringkas spt Sopir. Daftar akses LENGKAPnya SENGAJA TIDAK dituliskan
  // ulang di sini (tidak enumerasi command satu-satu) -- itu sudah ada &
  // tergerbang rapi per command di commandReferenceMessage(), cukup arahkan
  // ke situ ("ketik rekomendasi"). Menulis ulang daftar akses di 2 tempat
  // berisiko DRIFT tidak sinkron kalau salah satu diubah tapi yang lain
  // lupa diikutkan -- pelajaran yang SAMA dgn catatan "3 tempat WAJIB
  // SINKRON" di atas commandReferenceMessage().
  function buildIdSummaryText(chatId) {
    const driver = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
    const notifAdmin = (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === chatId);
    const financeAdmin = (state.financeAdmins || []).find(fa => (fa.chatId || '').toString().trim() === chatId);
    const isAdministrator = isSuperAdminChat(chatId);
    if (!driver && !notifAdmin && !financeAdmin && !isAdministrator) return null;

    const blok = [`🪪 <b>Ringkasan Akun Anda</b>\nChat ID: <code>${escapeHtmlTg(chatId)}</code>`];

    if (driver) {
      const t = driverTripStats(driver.id);
      const avgLine = t.avgSpeed != null
        ? `Rata-rata Kecepatan: ${t.avgSpeed} km/j (dari ${t.tripsWithSpeedCount} trip berdata GPS)`
        : 'Rata-rata Kecepatan: belum ada data GPS';
      let s = `🧑\u200d✈️ <b>Sopir — ${escapeHtmlTg(driver.nama)}</b>\nTotal Trip: ${t.jumlahTrip}\nTotal KM: ${t.totalKm > 0 ? t.totalKm.toLocaleString('id-ID') + ' KM' : '-'}\nTotal Jam Jalan: ${t.totalMenit > 0 ? fmtDurationMinutes(t.totalMenit) : '-'}\n${avgLine}`;

      // BARU (v3.267.0) -- trip aktif milik sopir ini sekarang, kalau ada
      // (pola cari sama persis dgn dipakai alur "akhiri trip").
      const tripAktif = state.usage.find(u => u.driverId === driver.id && u.status === 'digunakan');
      s += tripAktif
        ? `\n\n🚗 <b>Trip Aktif:</b> ${escapeHtmlTg(carLabel(tripAktif.carId))} — ${escapeHtmlTg(tripAktif.tujuan || '-')}\nBerangkat: ${fmtDate(tripAktif.tglKeluar)} ${tripAktif.jamKeluar || ''}`
        : `\n\n🚗 Trip Aktif: tidak ada`;

      // BARU (v3.267.0) -- booking mendatang milik sopir ini (field
      // `driverId` di objek booking -- cuma terisi kalau sopirnya SUDAH
      // ditentukan saat booking dibuat, bisa null kalau belum/dipesan
      // admin tanpa sopir tertentu). Status 'menunggu'/'dipesan' SAMA
      // dgn yang dipakai command "batalbooking".
      const bookingMendatang = (state.bookings || [])
        .filter(b => b.driverId === driver.id && (b.status === 'menunggu' || b.status === 'dipesan'))
        .sort((a, b2) => (a.tglMulai || '').localeCompare(b2.tglMulai || ''));
      s += bookingMendatang.length > 0
        ? `\n\n📅 <b>Booking Mendatang (${bookingMendatang.length}):</b>\n${bookingMendatang.slice(0, 5).map(b => `• ${escapeHtmlTg(carLabel(b.carId))} — ${escapeHtmlTg(b.tujuan || '-')} (${fmtDate(b.tglMulai)}${b.status === 'menunggu' ? ', menunggu persetujuan' : ''})`).join('\n')}`
        : `\n\n📅 Booking Mendatang: tidak ada`;

      blok.push(s);
    }
    if (notifAdmin) blok.push(`👤 <b>Admin Penerima Notifikasi — ${escapeHtmlTg(notifAdmin.nama || '(tanpa nama)')}</b>`);
    if (financeAdmin) blok.push(`💰 <b>Admin Finance — ${escapeHtmlTg(financeAdmin.nama || '(tanpa nama)')}</b>`);
    if (isAdministrator) blok.push(`👑 <b>Administrator</b>`);

    blok.push(`Ketik <b>rekomendasi</b> untuk lihat daftar lengkap perintah sesuai akses Anda di atas.`);
    return blok.join('\n\n');
  }
  function buildAvgSpeedRankingText() {
    const allStats = state.drivers.map(d => ({ nama: d.nama, ...driverTripStats(d.id) }));
    const rows = allStats.filter(r => r.avgSpeed != null).sort((a, b) => b.avgSpeed - a.avgSpeed);
    const totalGagal = allStats.reduce((s, r) => s + r.gagalCount, 0);
    const gagalFooter = totalGagal > 0
      ? `\n\n⚠️ ${totalGagal} trip (semua sopir) gagal dihitung kecepatannya -- ketik nama sopir ybs utk lihat contoh alasannya. Penyebab umum: IMEI GPS.id belum diisi di Data Mobil, GPS.id sedang rate-limit, atau tidak ada sinyal GPS selama trip itu.`
      : '';
    if (rows.length === 0) return `📊 Belum ada data rata-rata kecepatan sopir. Datanya baru terisi dari trip yang mobilnya terhubung IMEI GPS.id (Data Mobil) DAN ditutup setelah fitur ini aktif.${gagalFooter}`;
    const lines = rows.map((r, i) => `${i + 1}. ${escapeHtmlTg(r.nama)} — ${r.avgSpeed} km/j`);
    return `📊 <b>Rata-rata Kecepatan Sopir</b>\n\n${lines.join('\n')}${gagalFooter}`;
  }
  // BARU -- RAHASIA: khusus Administrator, ringkasan 7 entri Log Notifikasi
  // TERBARU langsung lewat chat (sama datanya dengan modal "📋 Cek log
  // notifikasi" di web, lihat GET /notif-log & pushNotifLog() di
  // runNotifyCheck()) -- tapi notifLog itu hidup di notif-state.json
  // (state TERPISAH dari `state` utama yang dipakai di sini), jadi HARUS
  // dibaca ulang langsung dari GitHub di sini, bukan diambil dari `state`.
  // Format: dikelompokkan GAGAL dulu (kalau ada) baru BERHASIL, dengan
  // ✅/❌ di tiap baris -- supaya masalah langsung kelihatan tanpa harus
  // baca satu-satu (disepakati lewat referensi sebelum dipasang).
  async function buildNotifLogRingkasanText(env) {
    const DATA_PATH = env.FLEETOPS_DATA_PATH || "data/fleetops-data.json";
    const dirOfData = DATA_PATH.includes("/") ? DATA_PATH.slice(0, DATA_PATH.lastIndexOf("/") + 1) : "";
    const STATE_PATH = env.FLEETOPS_NOTIF_STATE_PATH || (dirOfData + "notif-state.json");
    const stateRead = await ghReadJson(env, STATE_PATH);
    const notifLog = (stateRead.exists && Array.isArray(stateRead.json && stateRead.json.notifLog)) ? stateRead.json.notifLog : [];
    if (notifLog.length === 0) {
      return '📋 <b>Log Notifikasi</b>\n\nBelum ada riwayat pengiriman notifikasi tercatat.';
    }
    const entries = notifLog.slice(0, 7);
    const roleLabel = { sopir: 'Sopir', admin: 'Operator', finance: 'Finance', superadmin: 'Administrator' };
    function fmtEntry(e) {
      const jam = new Date(e.waktu).toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
      const peran = roleLabel[e.peran] || e.peran || '-';
      // Kalau `nama` kosong atau kebetulan sama dengan chatId (berarti
      // tidak ada nama asli tercatat, mis. Administrator via Secret
      // ADMIN_CHAT_IDS), tampilkan peran saja tanpa kurung supaya tidak
      // menampilkan "Administrator (216663781)" yang berulang/berantakan.
      const namaTampil = (e.nama && e.nama !== String(e.chatId)) ? `${peran} (${escapeHtmlTg(e.nama)})` : peran;
      const kategori = escapeHtmlTg(e.kategori || '-');
      const ikon = e.status === 'berhasil' ? '✅' : '❌';
      return `${ikon} ${jam} · ${namaTampil} · ${kategori}`;
    }
    const gagalList = entries.filter(e => e.status !== 'berhasil');
    const berhasilList = entries.filter(e => e.status === 'berhasil');
    const lines = [`📋 <b>Log Notifikasi — ${entries.length} Terakhir</b>`, ''];
    if (gagalList.length > 0) {
      lines.push(`⚠️ ${gagalList.length} gagal:`);
      gagalList.forEach(e => lines.push(fmtEntry(e)));
      if (berhasilList.length > 0) lines.push('');
    }
    if (berhasilList.length > 0) {
      lines.push(`✅ ${berhasilList.length} berhasil:`);
      berhasilList.forEach(e => lines.push(fmtEntry(e)));
    }
    return lines.join('\n').trim();
  }
  // v3.268.0 -- BARU: format tampilan Log Interaksi Bot (dipakai command
  // "log", gerbang akses botLogAccessAktif()) -- data mentahnya ditulis
  // catatInteraksiBot() (top-level, dekat pushMainDataUpdate()) ke KV
  // GPS_PUSH_KV key 'botlog:recent', cap 50 entri terbaru. Dikelompokkan
  // GAGAL dulu (kalau ada) baru BERHASIL -- pola SAMA persis dgn
  // buildNotifLogRingkasanText() di atas, supaya kedua log terasa konsisten
  // walau isi datanya beda total (ini pesan MASUK, itu notifikasi KELUAR).
  async function buildInteractionLogText(env) {
    const stored = await readGpsKvJson(env, 'botlog:recent');
    const entries = (stored && Array.isArray(stored.entries)) ? stored.entries.slice(0, 15) : [];
    if (entries.length === 0) {
      return '📋 <b>Log Interaksi Bot</b>\n\nBelum ada interaksi tercatat.';
    }
    const roleLabel = { sopir: 'Sopir', admin: 'Operator', finance: 'Finance', superadmin: 'Administrator' };
    function fmtEntry(e) {
      const jam = new Date(e.waktu).toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
      const peran = e.peran ? (roleLabel[e.peran] || e.peran) : 'Tidak dikenal';
      const namaTampil = e.nama ? `${peran} (${escapeHtmlTg(e.nama)})` : `${peran} (${escapeHtmlTg(e.chatId)})`;
      const ikon = e.status === 'berhasil' ? '✅' : '❌';
      const pesanTampil = escapeHtmlTg(e.pesan || '(kosong)');
      const errLine = e.status !== 'berhasil' && e.error ? `\n   ⚠️ ${escapeHtmlTg(e.error)}` : '';
      return `${ikon} ${jam} · ${namaTampil}\n   "${pesanTampil}"${errLine}`;
    }
    const gagalList = entries.filter(e => e.status !== 'berhasil');
    const berhasilList = entries.filter(e => e.status === 'berhasil');
    const lines = [`📋 <b>Log Interaksi Bot — ${entries.length} Terakhir</b>`, ''];
    if (gagalList.length > 0) {
      lines.push(`⚠️ ${gagalList.length} gagal (error teknis):`);
      gagalList.forEach(e => lines.push(fmtEntry(e)));
      if (berhasilList.length > 0) lines.push('');
    }
    if (berhasilList.length > 0) {
      lines.push(`✅ ${berhasilList.length} berhasil:`);
      berhasilList.forEach(e => lines.push(fmtEntry(e)));
    }
    return lines.join('\n').trim();
  }
  //
  // SENGAJA daftar TERPISAH & DIKURASI MANUAL, BUKAN hasil filter otomatis
  // dari CHANGELOG umum (index.html), utk 2 alasan:
  // (1) index.html/worker.js/sw.js hidup di REPO GITHUB YANG BEDA dari
  //     fleetops-data.json (dikonfirmasi eksplisit sebelum fitur ini
  //     dibangun) -- ghReadJson() yang sudah ada dikonfigurasi khusus utk
  //     repo DATA lewat ALLOWED_OWNER/ALLOWED_REPO, jadi worker.js TIDAK
  //     BISA sekadar "baca CHANGELOG dari index.html" tanpa menambah
  //     Secret/konfigurasi akses repo KEDUA -- terlalu berat utk fitur yg
  //     cuma menampilkan 5 baris teks.
  // (2) SEANDAINYA pun bisa dibaca, CHANGELOG umum bercampur perubahan
  //     web/UI yang TIDAK relevan buat sopir/admin yang cuma pakai bot --
  //     dicoba difilter otomatis (mis. cari teks "worker.js perlu diupload
  //     ulang") TERBUKTI tidak reliabel: ada banyak entri worker.js yang
  //     cuma endpoint utk index.html (mis. /resolve-maps-link,
  //     /geocode-destination), BUKAN fitur yang kelihatan di chat bot sama
  //     sekali. Makanya dikurasi manual di sini, sama spirit-nya dgn
  //     wholeWordCategoryScan()/cariKataBaruUntukDipelajari() di atas:
  //     lebih baik akurat & sedikit drpd otomatis tapi salah.
  //
  // WAJIB DEV: tiap kali menambah/mengubah fitur yang KELIHATAN LANGSUNG di
  // percakapan Telegram (command baru, alur baru, dsb -- BUKAN endpoint
  // backend murni utk index.html), tambahkan 1 entri BARU di URUTAN PALING
  // ATAS array ini (format {v, date, notes:[...]}). Pakai tag HTML yang
  // Telegram Bot API dukung SAJA (<b>, <i>, <code>) -- JANGAN <br>/<span>/
  // <ul>/dst spt di CHANGELOG index.html, krn itu dirender browser sedangkan
  // ini dikirim apa adanya ke Telegram lewat sendTg() (cuma subset HTML
  // terbatas yang didukung).
  const BOT_CHANGELOG = [
    {
      v: '3.282.0',
      date: '06 Agu 2026',
      notes: [
        'Notifikasi alert yang masuk sekarang menyertakan tombol rekomendasi cepat <b>"🔕 Matikan notifikasi ini"</b> langsung di pesannya (KHUSUS Admin/Super Admin, kalau kategori alert-nya cuma 1 dlm pesan itu) -- tap tombolnya lalu konfirmasi "✅ Ya, terapkan" utk langsung mematikan kategori itu, tanpa perlu ketik ulang perintah "matikan notifikasi ... untuk ...".',
      ]
    },
    {
      v: '3.280.0',
      date: '05 Agu 2026',
      notes: [
        'Notifikasi Telegram <b>Mesin Kendaraan Dinyalakan</b> sekarang menyertakan link <b>📍 Lihat lokasi live di peta (OpenStreetMap)</b> kalau posisi GPS.id kendaraan sedang jelas -- diklik langsung menampilkan lokasi mobil saat itu. SENGAJA pakai OpenStreetMap (BUKAN Google Maps), konsisten dgn peta mini Leaflet + OpenStreetMap yang sudah dipakai di aplikasi web (popup "🛰️ Lacak"). Kalau posisi GPS.id sedang tidak jelas, notifikasi tetap terkirim seperti biasa tanpa link.',
      ]
    },
    {
      v: '3.268.0',
      date: '04 Agu 2026',
      notes: [
        'Perintah <code>log</code> sekarang jadi <b>Log Interaksi Bot</b> -- SEMUA pesan masuk dari SEMUA peran (bukan cuma Administrator), lengkap dgn nama/peran pengirim, isi pesan, dan status berhasil/gagal. Akses diatur lewat menu "Notifikasi Telegram per Peran" di aplikasi -- default HANYA Administrator.',
        'Log Notifikasi lama (notifikasi yang bot KIRIM KELUAR) TIDAK hilang -- cuma pindah kata kunci jadi <code>lognotif</code>.',
      ]
    },
    {
      v: '3.267.0',
      date: '04 Agu 2026',
      notes: [
        'Perintah baru <code>id</code> -- ringkasan akun Anda sendiri, terbuka utk SEMUA peran terdaftar (Sopir/Admin/Finance/Administrator). Sopir dapat total trip/KM/kecepatan + trip aktif + booking mendatang; peran lain dapat identitas & arahan ke <code>rekomendasi</code>. Kalau terdaftar lebih dari 1 peran, semuanya ditampilkan sekaligus.',
      ]
    },
    {
      v: '3.266.0',
      date: '04 Agu 2026',
      notes: [
        'Perintah baru <code>update</code> / <code>bot</code> (Administrator) -- lihat 5 update fitur bot Telegram terbaru langsung dari chat, tanpa perlu buka aplikasi.',
      ]
    },
    {
      v: '3.265.0',
      date: '04 Agu 2026',
      notes: [
        'Bot sekarang belajar otomatis: kalau AI berhasil menebak maksud kalimat bebas & Anda tap "✅ Ya, benar", kata itu diingat permanen supaya lain kali dikenali TANPA AI lagi (bisa dihapus manual lewat menu "✏️ Alias" kalau ternyata salah belajar).',
      ]
    },
    {
      v: '3.261.0',
      date: '03 Agu 2026',
      notes: [
        'Perintah baru <code>/pola</code> -- lihat ringkasan Pola Kunjungan Berulang langsung dari chat.',
        'Bot tanya proaktif kalau ada pola kunjungan yang sudah matang (≥3 minggu data): "mau dijadikan Data Tujuan resmi?"',
      ]
    },
    {
      v: '3.259.0',
      date: '03 Agu 2026',
      notes: [
        'Isi BBM (Luar Trip): sekarang bisa kirim FOTO struk SPBU -- nominalnya dibaca otomatis (OCR), lalu selalu ditampilkan dulu utk dikonfirmasi/dikoreksi sebelum tersimpan.',
        'Pintasan 1-baris "bensin 50000" / "isi bensin 50rb" langsung memulai alur Isi BBM dengan nominal sudah terisi.',
      ]
    },
    {
      v: '3.250.0',
      date: '03 Agu 2026',
      notes: [
        'Perintah baru <code>/batalbooking</code> (atau ketik "batalkan booking") -- lihat daftar booking aktif, tap salah satu utk langsung membatalkannya.',
      ]
    },
  ];
  function buildBotUpdateText() {
    const entries = BOT_CHANGELOG.slice(0, 5);
    if (entries.length === 0) return '🤖 <b>Update Bot Telegram</b>\n\nBelum ada catatan update.';
    const blok = entries.map(e => `<b>v${e.v}</b> · ${e.date}\n${e.notes.map(n => '• ' + n).join('\n')}`).join('\n\n');
    return `🤖 <b>5 Update Terbaru — Bot Telegram</b>\n\n${blok}`;
  }
  function getTripDurationMinutes(u) {
    if (!u.tglKeluar || !u.tglKembali) return null;
    const start = new Date(u.tglKeluar + 'T' + (u.jamKeluar || '00:00') + ':00');
    const end = new Date(u.tglKembali + 'T' + (u.jamKembali || '00:00') + ':00');
    if (isNaN(start) || isNaN(end)) return null;
    const diffMin = Math.round((end - start) / 60000);
    return diffMin >= 0 ? diffMin : null;
  }
  function fmtDurationMinutes(mins) {
    if (mins == null || !isFinite(mins) || mins < 0) return '-';
    mins = Math.round(mins);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;
    const parts = [];
    if (days > 0) parts.push(days + ' hari');
    if (hours > 0) parts.push(hours + ' jam');
    if (minutes > 0 || parts.length === 0) parts.push(minutes + ' menit');
    return parts.join(' ');
  }
  function usageBiayaOpItems(u) { return Array.isArray(u.biayaOperasional) ? u.biayaOperasional : []; }
  function usageEtollNetTopupTotal(u) {
    return usageBiayaOpItems(u)
      .filter(it => it.kategori === 'Isi E-Toll')
      .reduce((sum, it) => sum + ((Number(it.nominal) || 0) - (Number(it.biayaAdmin) || 0)), 0);
  }
  function usageEtollTimeKey(u) {
    return (u.tglKembali || u.tglKeluar || '') + (u.jamKembali || u.jamKeluar || '');
  }
  function getBiayaTolTerpakai(u) {
    if (u.status !== 'selesai' || u.saldoEtoll == null) return null;
    let saldoAwal = (u.saldoEtollAwal != null) ? Number(u.saldoEtollAwal) : null;
    if (saldoAwal == null) {
      if (!u.etollCardId) return null;
      const timeKeyU = usageEtollTimeKey(u);
      const kandidat = state.usage
        .filter(x => x.id !== u.id && x.etollCardId === u.etollCardId && x.status === 'selesai' && x.saldoEtoll != null && usageEtollTimeKey(x) <= timeKeyU)
        .sort((a, b) => usageEtollTimeKey(b).localeCompare(usageEtollTimeKey(a)));
      if (kandidat.length === 0) return null;
      saldoAwal = Number(kandidat[0].saldoEtoll);
    }
    const netTopup = usageEtollNetTopupTotal(u);
    const biayaTol = saldoAwal + netTopup - Number(u.saldoEtoll);
    return { biayaTol };
  }
  function buildTripReceiptText(u) {
    const jarak = (u.odoKeluar != null && u.odoKembali != null && u.odoKembali >= u.odoKeluar) ? (u.odoKembali - u.odoKeluar) : null;
    const biayaTolInfo = getBiayaTolTerpakai(u);
    const biayaTol = biayaTolInfo ? biayaTolInfo.biayaTol : 0;
    const biayaOpItems = usageBiayaOpItems(u);
    const biayaOpTotalUntukTotal = biayaOpItems
      .filter(it => it.kategori !== 'Isi BBM' && it.kategori !== 'Isi E-Toll')
      .reduce((sum, it) => sum + (Number(it.nominal) || 0), 0);
    const grandTotal = (Number(u.biayaBensin) || 0) + biayaTol + biayaOpTotalUntukTotal;
    const lines = [
      `🧾 <b>Tanda Terima Perjalanan</b>`, '',
      `<b>Mobil:</b> ${escapeHtmlTg(carLabel(u.carId))}`,
      `<b>Sopir:</b> ${escapeHtmlTg(driverLabel(u.driverId, u.driver))}`,
      `<b>Jenis:</b> ${u.jenisPenggunaan === 'pribadi' ? '🏠 Pribadi' : '🧾 Operasional'}`,
      `<b>Tujuan:</b> ${escapeHtmlTg(u.tujuan || '-')}${(Array.isArray(u.tujuanTambahan) && u.tujuanTambahan.length) ? ' + ' + u.tujuanTambahan.length + ' tujuan lainnya (' + escapeHtmlTg(u.tujuanTambahan.join(', ')) + ')' : ''}`,
      `<b>Berangkat:</b> ${escapeHtmlTg(u.tglKeluar || '-')}${u.jamKeluar ? ', ' + u.jamKeluar : ''}`,
      `<b>Tiba:</b> ${u.tglKembali ? escapeHtmlTg(u.tglKembali) + (u.jamKembali ? ', ' + u.jamKembali : '') : '-'}`,
      `<b>Durasi:</b> ${fmtDurationMinutes(getTripDurationMinutes(u))}`, '',
      `Jarak Tempuh: ${jarak != null ? jarak.toLocaleString('id-ID') + ' KM' : '-'}`,
    ];
    if (u.literBensin) lines.push(`<b>Total BBM Diisi:</b> ${u.literBensin} L`);
    lines.push(`<b>Biaya BBM (total):</b> ${fmtMoney(u.biayaBensin || 0)}`);
    biayaOpItems.filter(it => it.kategori === 'Isi BBM').forEach(it => {
      lines.push(`   ↳ <i>${escapeHtmlTg(it.jenisBbm || 'BBM')}${it.catatan ? ' — ' + escapeHtmlTg(it.catatan) : ''}: ${fmtMoney(it.nominal)}</i>`);
    });
    if (biayaTolInfo) lines.push(`<b>Biaya Tol (total):</b> ${fmtMoney(biayaTol)}`);
    biayaOpItems.filter(it => it.kategori === 'Isi E-Toll').forEach(it => {
      lines.push(`   ↳ <i>${it.catatan ? escapeHtmlTg(it.catatan) : 'Isi E-Toll'}: ${fmtMoney(it.nominal)}</i>`);
    });
    const adaIsiEtollTg = biayaOpItems.some(it => it.kategori === 'Isi E-Toll');
    if (adaIsiEtollTg || u.saldoEtoll != null) {
      const linkedCardTg = u.etollCardId ? state.etollCards.find(c => c.id === u.etollCardId) : null;
      const nomorRingkasTg = linkedCardTg ? (linkedCardTg.nomorKartu.length > 4 ? '•••• ' + linkedCardTg.nomorKartu.slice(-4) : linkedCardTg.nomorKartu) : '';
      lines.push(`<b>Saldo E-Toll${nomorRingkasTg ? ' (' + nomorRingkasTg + ')' : ''}:</b> ${u.saldoEtoll != null ? fmtMoney(u.saldoEtoll) : '-'}`);
    }
    const itemLain = biayaOpItems.filter(it => it.kategori !== 'Isi BBM' && it.kategori !== 'Isi E-Toll');
    if (itemLain.length > 0) {
      lines.push('');
      lines.push('<b>Biaya Lain-lain:</b>');
      itemLain.forEach(it => {
        lines.push(`<b>${escapeHtmlTg(it.kategori)}</b>${it.catatan ? ' (' + escapeHtmlTg(it.catatan) + ')' : ''}: ${fmtMoney(it.nominal)}`);
      });
    }
    lines.push('');
    lines.push(`<b>TOTAL BIAYA: ${fmtMoney(grandTotal)}</b>`);
    lines.push('');
    lines.push(`<i>Dikirim otomatis begitu perjalanan ditandai selesai. Detail lengkap (termasuk Efisiensi BBM) ada di aplikasi FleetOps.</i>`);
    return lines.join('\n');
  }
  function convertBarToPercent(barCount, maxBar) {
    if (barCount == null || barCount === '' || !maxBar) return null;
    return (Number(barCount) / Number(maxBar)) * 100;
  }
  function pertanyaanBbm(car) {
    if (car.tipeIndikatorBbm === 'bar') {
      const maxBar = car.maxBarBbm || 8;
      return `⛽ Level BBM sekarang (0-${maxBar} Bar)? Contoh: 5`;
    }
    return `⛽ Level BBM sekarang (0-100%)? Contoh: 65`;
  }
  // v3.154.0 (poin G) -- Estimasi rasio KM/L rata-rata mobil ini dari riwayat
  // trip yang datanya lengkap (odometer + indikator BBM keluar & kembali),
  // dipakai SEKADAR pembanding kasar real-time saat sopir mengetik level BBM
  // di bot. SENGAJA versi ringan -- rumus neraca tangki polos per trip lalu
  // dirata-rata, BUKAN port penuh buildFuelChain/kalibrasi Bar/EWMA yang
  // dipakai dashboard (index.html: getCarFuelStats) -- itu logika UI yang
  // tidak ada di worker ini. Cukup untuk mendeteksi salah ketik yang jelas
  // (mis. 5 padahal maksud 50), BUKAN pengganti angka resmi di dashboard.
  function simpleCarAvgRatio(state, car) {
    if (!car || car.kapasitasTangkiLiter == null) return null;
    let totalKm = 0, totalLiter = 0;
    state.usage.filter(u => u.carId === car.id && u.odoKeluar != null && u.odoKembali != null && u.odoKembali > u.odoKeluar).forEach(u => {
      const keluar = u.bensinKeluar != null ? Number(u.bensinKeluar) : (u.sisaBensin != null ? Number(u.sisaBensin) : null);
      const kembali = u.bensinKembali != null ? Number(u.bensinKembali) : null;
      if (keluar == null || kembali == null) return;
      const literBeli = u.literBensin ? Number(u.literBensin) : 0;
      const liter = ((keluar - kembali) / 100) * Number(car.kapasitasTangkiLiter) + literBeli;
      if (liter <= 0) return;
      totalKm += (u.odoKembali - u.odoKeluar);
      totalLiter += liter;
    });
    return (totalKm > 0 && totalLiter > 0) ? totalKm / totalLiter : null;
  }
  function findSaldoAkhirEtollJikaTidakLewatTol(usageArr, convo) {
    const tripIni = usageArr.find(u => u.id === convo.tripId);
    let saldoAwal = (tripIni && tripIni.saldoEtollAwal != null) ? Number(tripIni.saldoEtollAwal) : null;
    if (saldoAwal == null) {
      if (!convo.etollCardId) return null;
      const timeKeyU = usageEtollTimeKey(tripIni || {});
      const kandidat = usageArr
        .filter(x => x.id !== convo.tripId && x.etollCardId === convo.etollCardId && x.status === 'selesai' && x.saldoEtoll != null && usageEtollTimeKey(x) <= timeKeyU)
        .sort((a, b) => usageEtollTimeKey(b).localeCompare(usageEtollTimeKey(a)));
      if (kandidat.length === 0) return null;
      saldoAwal = Number(kandidat[0].saldoEtoll);
    }
    const netTopup = tripIni ? usageEtollNetTopupTotal(tripIni) : 0;
    return saldoAwal + netTopup;
  }

  // ============================================================================
  // BARU -- fitur chat Telegram "isi" (Isi BBM / Isi Saldo E-Toll luar trip,
  // PORTING PERSIS dari openBbmStandaloneModal()/openEtollTopupStandaloneModal()
  // di index.html -- lihat komentar v3.107.0 di sana) & "biaya"/"operasional"/
  // "pribadi" (Biaya Operasional/Pribadi selama trip berjalan, PORTING PERSIS
  // dari openBiayaOperasionalModal()). Field yang ditanyakan bot di sini
  // SENGAJA disamakan urutan & wajib/opsionalnya dengan form aplikasi -- kalau
  // salah satu form di index.html diubah, blok ini WAJIB ikut disesuaikan.
  // ============================================================================
  function uidTg() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function actorNameForChat(cid) {
    const driver = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === cid);
    if (driver) return driver.nama;
    const admin = (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === cid);
    if (admin) return admin.nama || 'Admin';
    return 'Telegram';
  }
  // v3.??? -- SETIAP baris rekomendasi di sini sekarang digerbang per peran
  // chat ini, persis predikat yang dipakai handler perintah aslinya di atas
  // (bukan cuma "saldo"/"cek" seperti versi sebelumnya) -- supaya orang tidak
  // pernah disodori perintah yang sebenarnya diam/tidak berfungsi kalau dia
  // ketik. PIN Kelola Admin tetap SENGAJA tidak pernah disebut di sini sama
  // sekali (lihat catatan RAHASIA di atas) -- fungsi ini bukan tempatnya, dan itu
  // BERLAKU UNTUK SEMUA ORANG termasuk Administrator yang sudah terdaftar
  // (mereka tidak butuh PIN lagi, jadi tidak ada alasan PIN pernah muncul di
  // sini). Baris "kecepatan"/nama sopir DI BAWAH ini beda kasus -- itu HANYA
  // ditambahkan kalau isSuperAdminChat(cid) sudah TRUE, jadi cuma jadi
  // pengingat utk Administrator yang sudah resmi terdaftar, bukan bocoran ke
  // sembarang orang yang belum terdaftar.
  // v3.173.0 -- DIRINGKAS drastis (dulu daftar panjang per kategori, lihat
  // commandReferenceMessage() di bawah utk versi lengkapnya yang baru).
  // Sekarang cuma 1 baris pembuka -- daftar perintahnya sepenuhnya
  // dipindahkan ke tombol grid (menuCommandKeyboard()) + tombol baru
  // "📋 Rekomendasi Perintah" kalau mau lihat versi teks lengkap dgn
  // deskripsi. cid tidak lagi dipakai isinya (pesan sama utk semua chat yg
  // sudah "dikenal" -- gate aksesnya tetap di pemanggil, bukan di sini),
  // TAPI parameter tetap dipertahankan supaya pemanggil yang sudah ada tidak
  // perlu diubah.
  function unknownCommandMessage(cid) {
    return '🤔 Belum paham nih. Pilih lewat tombol di bawah, ketik <b>batal</b>, atau tap <b>📋 Rekomendasi Perintah</b> buat lihat daftar lengkapnya.';
  }
  // BARU (v3.173.0) -- versi LENGKAP dgn deskripsi, dipisah dari pesan
  // fallback singkat di atas supaya tidak menyodorkan wall-of-text di
  // percobaan pertama. Dibuka lewat tombol "📋 Rekomendasi Perintah" (selalu
  // ada di menuCommandKeyboard()) atau ketik manual "rekomendasi". Tiap nama
  // perintah SENGAJA ditulis berawalan "/" (mis. "/berangkat") -- Telegram
  // otomatis mewarnainya jadi link & mengirimkannya kalau di-tap, PERSIS
  // seperti ketik manual (lihat pelucutan awalan "/" di normalisasi `text`
  // di awal processTelegramUpdate()). Predikat akses per baris TETAP SAMA
  // PERSIS dengan menuCommandKeyboard()/syncBotCommandsForChat() -- kalau
  // nambah/ubah baris di salah satu, cek juga 2 lainnya.
  function commandReferenceMessage(cid) {
    const driverObj = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === cid);
    const notifAdminObj = (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === cid);
    const baris = ['📋 <b>Rekomendasi Perintah</b>', 'Tap link di bawah buat langsung kirim, atau ketik manual tanpa garis miring.', ''];
    // v3.267.0 -- BARU: "id" -- ringkasan akun sendiri, berlaku utk SEMUA
    // peran terdaftar (bukan cuma 1 peran spt bucket TRIP/KEUANGAN/ADMIN di
    // bawah) -- makanya SENGAJA ditaruh sbg baris tersendiri di sini, BUKAN
    // masuk ke salah satu bucket (kalau dimasukkan ke bucket ADMIN mis., Sopir
    // biasa yang bukan admin apa pun akan salah lihat header "ADMIN" padahal
    // dia cuma boleh command ini).
    if (driverObj || notifAdminObj || isFinanceAdminChat(cid) || isSuperAdminChat(cid)) {
      baris.push('🪪 /id — ringkasan akun & data Anda sendiri', '');
    }
    // v3.268.0 -- BARU: "log" (Log Interaksi Bot) -- SAMA alasannya dgn "id"
    // di atas, TIDAK masuk bucket ADMIN krn aksesnya BISA diatur ke peran
    // manapun lewat panel Notifikasi Telegram per Peran (botLogAccessAktif()
    // BUKAN hardcode isSuperAdminChat), jadi gatingnya DINAMIS -- bukan union
    // 4 role tetap spt "id".
    if (botLogAccessAktif(cid)) {
      baris.push('📋 /log — Log Interaksi Bot, semua pesan masuk (siapa saja, apa saja, berhasil/gagal)', '');
    }

    const trip = [];
    if (driverObj) trip.push('🚗 /berangkat — mulai trip baru');
    if (driverObj) trip.push('🏁 /akhiritrip (atau ketik "akhiri trip") — akhiri trip yang sedang jalan');
    if (driverObj && !isAdminOrSuperAdmin(cid)) trip.push('🔧 /oli — status servis mobil kamu');
    if (trip.length) { baris.push('<b>TRIP</b>'); baris.push(...trip); baris.push(''); }

    const keuangan = [];
    if (driverObj || notifAdminObj) keuangan.push('⛽ /isi — Isi BBM / Saldo E-Toll');
    if (driverObj) keuangan.push('🧾 /biaya — biaya operasional/pribadi');
    if (driverObj) keuangan.push('📎 Kirim foto nota, lalu /kirim — teruskan ke Admin Finance');
    if (driverObj || notifAdminObj) keuangan.push('📅 /booking — pesan mobil baru');
    if (driverObj || notifAdminObj) keuangan.push('❌ /batalbooking — batalkan booking mobil (punya sendiri, admin bisa semua)');
    if (isSaldoAllowedUser(cid)) keuangan.push('💳 /saldo — cek saldo/rekap');
    if (isFinanceAdminChat(cid) && !isSaldoAllowedUser(cid)) keuangan.push('💳 /saldo — cek E-Toll / Biaya BBM Bulan Ini / Dokumen / Budget'); // BARU -- Finance-only, bukan Admin/Sopir
    if (driverObj || isAdminOrSuperAdmin(cid)) keuangan.push('⛽ /barcode — lihat lagi barcode MyPertamina mobil');
    if (driverObj || isAdminOrSuperAdmin(cid) || isFinanceAdminChat(cid)) keuangan.push('📎 cek [kode trip] — status kirim & foto nota/tanda terima 1 trip, cth: cek PJL-00007');
    if (keuangan.length) { baris.push('<b>KEUANGAN</b>'); baris.push(...keuangan); baris.push(''); }

    const admin = [];
    if (isAdminNotifUser(cid)) admin.push('🚘 /cek — mobil yang sedang jalan');
    if (isAdminOrSuperAdmin(cid)) admin.push('📍 /lokasi — lokasi terkini 1 mobil');
    if (isAdminOrSuperAdmin(cid) || isFinanceAdminChat(cid)) admin.push('🔧 /service — 3 data servis terbaru');
    if (isAdminOrSuperAdmin(cid)) admin.push('🔧 /atur — atur (tambah/ganti) barcode MyPertamina per mobil');
    if (isAdminOrSuperAdmin(cid)) admin.push('🛰️ /kalibrasi — tandai 1 mobil baru saja dikalibrasi odometer GPS.id-nya (reset pengingat)');
    if (isAdminOrSuperAdmin(cid)) admin.push('📍 /pola — Pola Kunjungan Berulang (opsional: /pola <nama mobil>)');
    if (isAdminOrSuperAdmin(cid)) admin.push('🔔 "nyalakan/matikan notifikasi &lt;kategori&gt; untuk &lt;peran&gt;" — atur Notifikasi Telegram per Peran langsung dari chat (perlu konfirmasi tap)');
    // "odometer jam sekian" -- Admin/Administrator (mobil manapun) ATAU sopir
    // dgn trip AKTIF (mobil trip aktifnya sendiri saja). Bukan keyword tetap
    // (kalimat bebas mengandung "jam"/"pukul"), jadi TIDAK bisa jadi link
    // "/xxx" tunggal -- tetap ditulis polos sebagai catatan.
    if (isAdminOrSuperAdmin(cid) || (driverObj && state.usage.some(u => u.driverId === driverObj.id && u.status === 'digunakan'))) {
      admin.push('🕒 Kalimat bebas mengandung <b>jam</b>/<b>pukul</b> (mis. "jam 10 tadi odonya berapa?") — odometer historis GPS.id');
    }
    // Pengingat KHUSUS Administrator yang sudah terdaftar -- TIDAK menyebut
    // PIN Kelola Admin sama sekali (lihat catatan RAHASIA di atas), cuma
    // pengingat kata kunci supaya tidak lupa.
    if (isSuperAdminChat(cid)) admin.push('⚡ /kecepatan — ranking kecepatan sopir (Administrator)');
    if (isSuperAdminChat(cid)) admin.push('📋 /lognotif — 7 log notifikasi terakhir, yang bot KIRIM KELUAR (Administrator)');
    if (isSuperAdminChat(cid)) admin.push('🤖 /update (atau ketik "bot") — 5 update fitur bot Telegram terbaru (Administrator)');
    if (admin.length) { baris.push('<b>ADMIN</b>'); baris.push(...admin); }

    while (baris.length && baris[baris.length - 1] === '') baris.pop();
    return baris.join('\n');
  }
  // BARU: versi TOMBOL dari unknownCommandMessage() di atas -- supaya bisa
  // di-TAP, tidak perlu ketik manual. Baris & syarat akses SENGAJA dibuat
  // 1:1 sama persis dengan unknownCommandMessage() (predikat yang sama,
  // urutan yang sama) supaya dua-duanya tidak pernah "kelewat sinkron" satu
  // sama lain -- kalau nambah/ubah baris di sana, cek juga di sini.
  // callback_data-nya "cmd:<keyword>" -- lihat blok isMenuCmdTap di awal
  // processTelegramUpdate() utk gimana ini "menyamar" jadi ketikan biasa.
  function menuCommandKeyboard(cid) {
    const driverObj = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === cid);
    const notifAdminObj = (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === cid);
    // v3.??? -- SIMPLIFIKASI TAMPILAN: tombol dikelompokkan per kategori
    // (TRIP / KEUANGAN / ADMIN, urutan sama persis dgn unknownCommandMessage()
    // di atas) dan disusun 2 kolom per baris (dulu 1 tombol per baris) supaya
    // daftar tidak terlalu panjang ke bawah.
    // v3.??? -- SET IKON BARU (atas permintaan user, "ubah semua icon telegram
    // menjadi seperti ini"): Berangkat ➤->▶️, Tiba 🚗->🏁, Cek Mobil 🚙->🚘,
    // Lokasi 📍 Mobil->📍 Lokasi, Booking 📅 Mobil->📅 Booking, Saldo 💰->💳,
    // label "Isi BBM / Saldo E-Toll" & "Biaya Operasional/Pribadi" dipersingkat
    // jadi "Isi BBM" & "Biaya" (ikonnya sendiri ⛽/🧾 tidak berubah), Service 🔧
    // & Kecepatan ⚡ tidak berubah (tidak ada di daftar baru).
    const trip = [];
    if (driverObj) trip.push({ text: '▶️ Berangkat', callback_data: 'cmd:berangkat' });
    if (driverObj) trip.push({ text: '🏁 Akhiri Trip', callback_data: 'cmd:akhiritrip' });
    if (driverObj && !isAdminOrSuperAdmin(cid)) trip.push({ text: '🔧 Servis Mobil Saya', callback_data: 'cmd:oli' });

    const keuangan = [];
    if (driverObj || notifAdminObj) keuangan.push({ text: '⛽ Isi BBM', callback_data: 'cmd:isi' });
    if (driverObj) keuangan.push({ text: '🧾 Biaya', callback_data: 'cmd:biaya' });
    if (driverObj || notifAdminObj) keuangan.push({ text: '📅 Booking', callback_data: 'cmd:booking' });
    if (driverObj || notifAdminObj) keuangan.push({ text: '❌ Batalkan Booking', callback_data: 'cmd:batalbooking' });
    if (isSaldoAllowedUser(cid)) keuangan.push({ text: '💳 Saldo', callback_data: 'cmd:saldo' });
    if (isFinanceAdminChat(cid) && !isSaldoAllowedUser(cid)) keuangan.push({ text: '💳 Cek Saldo (Finance)', callback_data: 'cmd:saldo' }); // BARU -- Finance-only, bukan Admin/Sopir

    const admin = [];
    if (isAdminNotifUser(cid)) admin.push({ text: '🚘 Cek Mobil', callback_data: 'cmd:cek' });
    if (isAdminOrSuperAdmin(cid)) admin.push({ text: '📍 Lokasi', callback_data: 'cmd:lokasi' });
    if (isAdminOrSuperAdmin(cid) || isFinanceAdminChat(cid)) admin.push({ text: '🔧 Service', callback_data: 'cmd:service' });
    if (isSuperAdminChat(cid)) admin.push({ text: '⚡ Kecepatan (Administrator)', callback_data: 'cmd:kecepatan' });
    if (isSuperAdminChat(cid)) admin.push({ text: '📋 Log Notifikasi Keluar (Administrator)', callback_data: 'cmd:lognotif' });
    if (isSuperAdminChat(cid)) admin.push({ text: '🤖 Update Bot (Administrator)', callback_data: 'cmd:update' });

    function toRows(items) {
      const out = [];
      for (let i = 0; i < items.length; i += 2) out.push(items.slice(i, i + 2));
      return out;
    }
    const rows = [...toRows(trip), ...toRows(keuangan), ...toRows(admin)];
    // v3.267.0 -- BARU: "🪪 ID Saya", SAMA alasannya dgn baris "id" tersendiri
    // di commandReferenceMessage() -- berlaku lintas SEMUA peran (bukan cuma
    // 1 bucket trip/keuangan/admin), jadi ditaruh sbg row TERSENDIRI (full-
    // width, persis pola "📋 Rekomendasi Perintah" di bawah), BUKAN masuk ke
    // salah satu grid 2-kolom di atas.
    if (driverObj || notifAdminObj || isFinanceAdminChat(cid) || isSuperAdminChat(cid)) {
      rows.push([{ text: '🪪 ID Saya', callback_data: 'cmd:id' }]);
    }
    // v3.268.0 -- BARU: "📋 Log Interaksi Bot" -- SAMA alasannya dgn "ID Saya"
    // di atas (gating DINAMIS via botLogAccessAktif(), bukan union role
    // tetap), row tersendiri sama persis.
    if (botLogAccessAktif(cid)) {
      rows.push([{ text: '📋 Log Interaksi Bot', callback_data: 'cmd:log' }]);
    }
    // v3.173.0 -- Tombol baru "Rekomendasi Perintah", SELALU ditaruh di baris
    // terakhir sendiri (full-width, bukan ikut digabung 2-kolom) -- ini
    // navigasi ke pesan lengkap (commandReferenceMessage()), bukan perintah
    // aktual, jadi sengaja dibedakan posisinya dari grid command di atasnya.
    rows.push([{ text: '📋 Rekomendasi Perintah', callback_data: 'cmd:rekomendasi' }]);
    return rows;
  }
  function isSkip(t) { return ['lewati', 'skip', '-', 'tidak', 'gak', 'ga', 'nggak', 'enggak'].includes(t.trim().toLowerCase()); }
  function carPickerRows(prefix) {
    return state.cars.map(c => [{ text: carLabel(c.id), callback_data: `${prefix}${c.id}` }]);
  }
  // BARU (fitur "mulai perjalanan" via Telegram) -- daftar tombol mobil,
  // TAPI cuma yang belum berstatus 'digunakan' (beda dari carPickerRows()
  // biasa yang menampilkan SEMUA mobil termasuk yang lagi dipakai -- di web,
  // mobil yang sedang dipakai tetap tampil di dropdown tapi disabled;
  // di Telegram lebih simpel & aman langsung tidak ditampilkan sama sekali).
  function availableCarPickerRows(prefix) {
    return state.cars
      .filter(c => !state.usage.some(u => u.carId === c.id && u.status === 'digunakan'))
      .map(c => [{ text: carLabel(c.id), callback_data: `${prefix}${c.id}` }]);
  }
  // BARU -- tambahkan 1 baris tombol "↩️ Batal" di bawah keyboard manapun,
  // dipakai konsisten di SEMUA menu rekomendasi/pilihan pada alur "mulai
  // perjalanan" (mobil, jenis, saran tujuan, konfirmasi odometer GPS,
  // pilih/konfirmasi E-Toll) -- supaya sopir tidak wajib ketik "batal"
  // manual, cukup tap. Ketik "batal" manual tetap tetap berfungsi seperti
  // biasa (ditangani terpusat di titik "convo && text === 'batal'" di atas).
  function withBatal(rows) {
    const r = (Array.isArray(rows) ? rows : []).map(row => row.slice());
    r.push([{ text: '↩️ Batal', callback_data: 'batal' }]);
    return r;
  }
  // BARU -- jarak edit Levenshtein sederhana, dipakai cariSaranTujuan() utk
  // toleransi typo/kemiripan ejaan nama tujuan (mis. "Gudang Surabya" mirip
  // "Gudang Surabaya"). Tidak ada dependency luar, murni JS biasa.
  function levenshteinDistance(a, b) {
    a = String(a); b = String(b);
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[n];
  }
  // v3.255.0 -- BARU: NLP Tingkat 1.5 -- pindai kalimat KATA PER KATA, cek
  // apakah ada kata yang PERSIS sama dgn salah satu alias command (bukan
  // membandingkan SELURUH kalimat spt bestFuzzyCommandMatch() di bawah).
  // Menangkap kalimat berisi kata kunci di antara kata basa-basi (mis.
  // "tolong cek dong", "mau booking mobil ya") TANPA perlu Tingkat 3 (AI) --
  // gratis & instan spt Tingkat 2, tapi cara kerjanya beda (per-kata, bukan
  // toleransi-typo per-kalimat).
  // PENGAMAN WAJIB (kenapa fungsi ini TIDAK cuma "cari kata pertama yang
  // cocok"): kalau 1 kalimat kebetulan mengandung kata kunci dari LEBIH DARI
  // 1 kategori berbeda sekaligus (mis. "cek saldo saya" -> kata "cek" itu
  // sendiri alias kategori "Cek Mobil", SEKALIGUS kata "saldo" alias kategori
  // "Cek Saldo" -- 2 kategori beda dalam 1 kalimat), fungsi ini SENGAJA
  // menyerah (return null) alih-alih asal pilih kategori yang ketemu duluan --
  // itu rawan salah tebak. Kasus ambigu begini diteruskan ke Tingkat 3 (AI)
  // yang memang membaca maksud SELURUH kalimat, bukan cuma kata lepas.
  function wholeWordCategoryScan(teksInput, candidates) {
    const words = (teksInput || '').split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const kategoriKetemu = new Set();
    let hasilTunggal = null;
    for (const cand of candidates) {
      const cocok = cand.keywords.some(kw => kw && !kw.includes(' ') && words.includes(kw));
      if (cocok) { kategoriKetemu.add(cand); hasilTunggal = cand; }
    }
    return kategoriKetemu.size === 1 ? hasilTunggal : null;
  }
  // v3.252.0 -- BARU: pakai ulang levenshteinDistance() persis di atas (sudah
  // ada, dipakai cariSaranTujuan()) utk NLP ringan Tingkat 2 di bot Telegram --
  // cari 1 kandidat command PALING MIRIP dari daftar { label, replay, keywords }
  // thd 1 kata pendek yg diketik sopir. Ambang toleransi typo PROPORSIONAL ke
  // panjang kata (~25%, minimal 1) -- bukan angka tetap -- supaya kata pendek
  // (mis. "cek"/"oli") tidak gampang salah-tebak jadi kata pendek lain yang
  // kebetulan mirip, sementara kata panjang (mis. "berangkat") tetap toleran
  // ke beberapa huruf typo. Frasa multi-kata (mis. "akhiri trip") SENGAJA
  // dilewati di sini (susah diukur adil pakai jarak edit per-karakter) --
  // biar jadi bagian Tingkat 3 (LLM) saja. Kembalikan null kalau tidak ada
  // kandidat yang cukup dekat -- pemanggil lanjut ke Tingkat 3 atau menyerah
  // ke unknownCommandMessage(). Lihat titik pemanggilan & penjelasan lengkap
  // 3 tingkat NLP ini di dekat unknownCommandMessage() di bawah.
  function bestFuzzyCommandMatch(teksInput, candidates) {
    if (!teksInput || teksInput.length < 3) return null; // kata terlalu pendek, rawan salah-tebak
    let best = null;
    for (const cand of candidates) {
      for (const kw of cand.keywords) {
        if (!kw || kw.length < 3 || kw.includes(' ')) continue;
        const dist = levenshteinDistance(teksInput, kw);
        if (dist === 0) continue; // exact match harusnya sudah ketangkap Tingkat 1 di atas
        const toleransi = Math.max(1, Math.floor(kw.length / 4));
        if (dist <= toleransi && (!best || dist < best.dist)) best = { dist, cand };
      }
    }
    return best ? best.cand : null;
  }
  // v3.265.0 -- BARU: cari 1 kata "baru" dari kalimat sopir yang BELUM
  // dikenal keyword manapun di nlpCandidates -- dipakai fitur belajar
  // otomatis "Tingkat 3 mengajari Tingkat 1.5" (lihat titik pemanggilan &
  // penjelasan lengkap di blok NLP bertingkat, dekat unknownCommandMessage()
  // di bawah). SENGAJA konservatif: kalau kata "baru" yang ditemukan LEBIH
  // DARI 1 (atau TIDAK ADA sama sekali), fungsi ini menyerah (return null) --
  // SAMA semangatnya dgn wholeWordCategoryScan() di atas (menyerah kalau
  // ambigu, drpd asal tebak). AI Tingkat 3 cuma mengembalikan INDEX kandidat
  // yang cocok (bukan kata mana persisnya yang memicu), jadi kalau ada
  // beberapa kata baru sekaligus dalam 1 kalimat, kita tidak tahu pasti kata
  // MANA yang sebenarnya relevan -- lebih aman tidak belajar apa pun drpd
  // salah belajar kata yang keliru (mis. nama tempat/kata basa-basi baru yg
  // kebetulan ada di kalimat yang sama).
  const STOPWORDS_NLP_BELAJAR = new Set([
    'yang', 'untuk', 'dengan', 'dari', 'saya', 'aku', 'kamu', 'anda', 'tolong',
    'mau', 'ingin', 'bisa', 'boleh', 'dong', 'nya', 'ini', 'itu', 'kalau',
    'apakah', 'apa', 'gimana', 'bagaimana', 'sekarang', 'tadi', 'nanti',
    'udah', 'sudah', 'belum', 'lagi', 'juga', 'saja', 'aja', 'kok', 'sih',
    'deh', 'pak', 'bu', 'min', 'admin', 'gan', 'bang', 'kak', 'plis', 'please',
  ]);
  function cariKataBaruUntukDipelajari(teksInput, candidates) {
    const words = (teksInput || '').split(/\s+/).filter(w => w && w.length >= 4);
    if (words.length === 0) return null;
    const semuaKeywordDikenal = new Set();
    for (const cand of candidates) {
      for (const kw of cand.keywords) {
        if (kw && !kw.includes(' ')) semuaKeywordDikenal.add(kw);
      }
    }
    const kandidatBaru = Array.from(new Set(
      words.filter(w => !semuaKeywordDikenal.has(w) && !STOPWORDS_NLP_BELAJAR.has(w))
    ));
    return kandidatBaru.length === 1 ? kandidatBaru[0] : null;
  }
  // BARU -- cari rekomendasi tujuan dari Data Tujuan yang sudah ada,
  // berdasarkan apa yang diketik manual sopir lewat chat, supaya nama tujuan
  // tetap konsisten/akurat (tidak numpuk "Gudang Surabaya" vs "gudang
  // surabaya 1" vs "Gdg Surabaya" sbg tujuan berbeda-beda).
  // Mengembalikan salah satu dari 3 kemungkinan (SATU saja yang terisi):
  // - exact: nama Data Tujuan yang PERSIS sama (case-insensitive) -> langsung
  //   dipakai tanpa tanya-tanya lagi.
  // - close: 1 nama yang mirip secara EJAAN (typo-tolerant, jarak edit kecil
  //   relatif thd panjang teks) -> ditanya konfirmasi ya/tidak.
  // - partial: daftar nama (maks 8) yang mengandung kata yang sama (mis.
  //   ketik "surabaya" -> semua tujuan yang ada kata "surabaya"-nya) --
  //   dipakai jadi pilihan tombol kalau sopir cuma ingat sebagian/daerahnya
  //   saja, bukan nama lengkapnya.
  function cariSaranTujuan(inputRaw) {
    const input = (inputRaw || '').trim().toLowerCase();
    const hasil = { exact: null, close: null, partial: [] };
    if (!input) return hasil;
    const names = Array.from(new Set(
      (state.destinations || []).map(d => (d.nama || '').trim()).filter(Boolean)
    ));
    if (names.length === 0) return hasil;

    const exact = names.find(n => n.toLowerCase() === input);
    if (exact) { hasil.exact = exact; return hasil; }

    let best = null, bestDist = Infinity;
    for (const n of names) {
      const nl = n.toLowerCase();
      const dist = levenshteinDistance(input, nl);
      const maxLen = Math.max(input.length, nl.length);
      // Ambang toleransi: teks pendek boleh beda 1 huruf, makin panjang
      // makin longgar (~30% dari panjang teks), supaya tetap "longgar" tapi
      // tidak asal nyambung ke nama yang jauh berbeda.
      const threshold = maxLen <= 5 ? 1 : Math.ceil(maxLen * 0.3);
      if (dist <= threshold && dist < bestDist) { best = n; bestDist = dist; }
    }
    if (best) { hasil.close = best; return hasil; }

    const partial = names.filter(n => {
      const nl = n.toLowerCase();
      return nl.includes(input) || input.includes(nl);
    });
    hasil.partial = partial.slice(0, 8);
    return hasil;
  }
  function etollCardPickerRows() {
    return state.etollCards.map(c => [{ text: `${c.nomorKartu} (${fmtMoney(c.saldo)})`, callback_data: `setl:card:${c.id}` }]);
  }
  function jenisBbmRows() {
    const customUsed = Array.from(new Set(
      state.usage.flatMap(u => usageBiayaOpItems(u).map(it => it.jenisBbm)).concat(
        state.usage.filter(u => u.jenisPenggunaan === 'isi-bbm-saja').map(u => u.jenisBbm)
      ).filter(k => k && !JENIS_BBM_DEFAULT.includes(k))
    )).sort((a, b) => a.localeCompare(b));
    const all = [...JENIS_BBM_DEFAULT, ...customUsed];
    const rows = [];
    for (let i = 0; i < all.length; i += 2) rows.push(all.slice(i, i + 2).map(j => ({ text: j, callback_data: `jbbm:${j}` })));
    rows.push([{ text: '+ Jenis lain (ketik manual)', callback_data: 'jbbm:__lainnya__' }]);
    return rows;
  }
  function biayaOpMenuText(isPribadi) {
    return `${isPribadi ? '🏠 <b>Biaya Pribadi</b>' : '🧾 <b>Biaya Operasional</b>'}\nPilih kategori biaya yang mau dicatat:`;
  }
  function biayaOpMenuKeyboard() {
    const rows = [];
    for (let i = 0; i < BIAYA_OP_CATEGORIES.length; i += 2) {
      rows.push(BIAYA_OP_CATEGORIES.slice(i, i + 2).map(k => ({ text: k, callback_data: `bop:kat:${k}` })));
    }
    return rows;
  }
  function levelSebelumMaxFor(car) {
    return (car && car.tipeIndikatorBbm === 'bar') ? (car.maxBarBbm || 8) : 100;
  }
  function pertanyaanBbmLevel(car, label) {
    const batasAtas = levelSebelumMaxFor(car);
    const satuan = (car && car.tipeIndikatorBbm === 'bar') ? 'Bar' : '%';
    return `⛽ ${label} (0-${batasAtas} ${satuan})? Contoh: ${Math.round(batasAtas / 2)}`;
  }

  async function finalizeIsiBbm(chatId, convo) {
    const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      freshRaw.data.usage = freshRaw.data.usage || [];
      freshRaw.data.usageCodeSeq = (freshRaw.data.usageCodeSeq || 0) + 1;
      const kode = 'PJL-' + String(freshRaw.data.usageCodeSeq).padStart(5, '0');
      const car = (freshRaw.data.cars || []).find(c => c.id === convo.carId);
      if (!car) return false;
      const jam = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
      freshRaw.data.usage.push({
        id: uidTg(), kode, carId: convo.carId, driverId: null,
        jenisPenggunaan: 'isi-bbm-saja', // penanda "bukan trip sungguhan" -- PERSIS spt index.html
        tujuan: 'Isi BBM (Luar Trip)', status: 'selesai',
        tglKeluar: convo.tanggal, jamKeluar: jam, tglKembali: convo.tanggal, jamKembali: jam,
        odoKeluar: car.odometerSaatIni, odoKembali: car.odometerSaatIni,
        bensinKeluar: convo.bensinSebelum != null ? convo.bensinSebelum : null,
        bensinKembali: convo.bensinSesudah != null ? convo.bensinSesudah : null,
        jenisBbm: convo.jenisBbm,
        literBensin: convo.liter != null ? convo.liter : null,
        biayaBensin: convo.nominal,
        catatan: convo.catatan || undefined,
        petugas: `${convo.petugas} (via Telegram)`,
        updatedAt: Date.now(),
      });
      freshRaw.data.activityLog = freshRaw.data.activityLog || [];
      freshRaw.data.activityLog.unshift({ id: uidTg(), tipe: 'penggunaan', judul: 'Isi BBM (luar trip)', keterangan: `${carLabel(convo.carId)} — ${fmtMoney(convo.nominal)}`, waktu: Date.now(), petugas: `${convo.petugas} (via Telegram)` });
      if (freshRaw.data.activityLog.length > 200) freshRaw.data.activityLog = freshRaw.data.activityLog.slice(0, 200);
      return true;
    });
    if (hasil.ok) {
      await sendTg(chatId, `✅ <b>Pembelian BBM dicatat!</b>\n\n${escapeHtmlTg(carLabel(convo.carId))}\nJenis: ${escapeHtmlTg(convo.jenisBbm)}\nNominal: ${fmtMoney(convo.nominal)}${convo.liter != null ? '\nLiter: ' + convo.liter : ''}${convo.catatan ? '\nCatatan: ' + escapeHtmlTg(convo.catatan) : ''}\n\nTerima kasih! 🙏`);
    } else {
      await sendTg(chatId, '❌ Gagal menyimpan ke server -- coba lagi beberapa saat lagi, atau catat manual lewat aplikasi.');
    }
  }

  async function finalizeIsiEtoll(chatId, convo) {
    let saldoSesudah = null;
    const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      freshRaw.data.etollCards = freshRaw.data.etollCards || [];
      const card = freshRaw.data.etollCards.find(c => c.id === convo.cardId);
      if (!card) return false;
      const saldoSebelum = Number(card.saldo) || 0;
      saldoSesudah = saldoSebelum + convo.nominal;
      card.saldo = saldoSesudah;
      card.updatedAt = Date.now();
      freshRaw.data.etollTransactions = freshRaw.data.etollTransactions || [];
      freshRaw.data.etollTransactions.push({
        id: uidTg(), cardId: convo.cardId, jenis: 'topup', nominal: convo.nominal,
        saldoSebelum, saldoSesudah,
        tanggal: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }),
        keterangan: convo.keterangan || 'Top up manual (luar trip, via Telegram)',
        petugas: `${convo.petugas} (via Telegram)`, updatedAt: Date.now(),
      });
      freshRaw.data.activityLog = freshRaw.data.activityLog || [];
      freshRaw.data.activityLog.unshift({ id: uidTg(), tipe: 'etoll', judul: 'Top up E-Toll (luar trip)', keterangan: `${card.nomorKartu} — ${fmtMoney(convo.nominal)}`, waktu: Date.now(), petugas: `${convo.petugas} (via Telegram)` });
      if (freshRaw.data.activityLog.length > 200) freshRaw.data.activityLog = freshRaw.data.activityLog.slice(0, 200);
      return true;
    });
    if (hasil.ok) {
      await sendTg(chatId, `✅ <b>Top up E-Toll dicatat!</b>\n\nNominal: ${fmtMoney(convo.nominal)}\nSaldo sekarang: ${saldoSesudah != null ? fmtMoney(saldoSesudah) : '-'}${convo.keterangan ? '\nKeterangan: ' + escapeHtmlTg(convo.keterangan) : ''}\n\nTerima kasih! 🙏`);
    } else {
      await sendTg(chatId, '❌ Gagal menyimpan ke server -- coba lagi beberapa saat lagi, atau catat manual lewat aplikasi.');
    }
  }

  async function finalizeBiayaOp(chatId, convo) {
    const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      freshRaw.data.usage = freshRaw.data.usage || [];
      const trip = freshRaw.data.usage.find(u => u.id === convo.tripId);
      if (!trip || trip.status !== 'digunakan') return false;
      trip.biayaOperasional = Array.isArray(trip.biayaOperasional) ? trip.biayaOperasional : [];
      convo.items.forEach(it => {
        trip.biayaOperasional.push({
          id: uidTg(),
          kategori: it.kategori,
          nominal: it.nominal,
          biayaAdmin: it.kategori === 'Isi E-Toll' ? (it.biayaAdmin || 0) : undefined,
          jenisBbm: it.kategori === 'Isi BBM' ? it.jenisBbm : undefined,
          literValidasi: (convo.isPribadi && it.kategori === 'Isi BBM' && it.liter != null) ? it.liter : undefined,
          literIsi: (!convo.isPribadi && it.kategori === 'Isi BBM' && it.liter != null) ? it.liter : undefined,
          bensinSebelumIsi: (it.kategori === 'Isi BBM' && it.bensinSebelumIsi != null) ? it.bensinSebelumIsi : undefined,
          catatan: it.catatan || undefined,
        });
      });

      // Auto-akumulasi Biaya BBM/Liter -- PERSIS spt openBiayaOperasionalModal() di index.html
      const semuaItemBbm = trip.biayaOperasional.filter(x => x.kategori === 'Isi BBM');
      const totalBbm = semuaItemBbm.reduce((s, x) => s + (Number(x.nominal) || 0), 0);
      if (totalBbm > 0) trip.biayaBensin = totalBbm;
      const totalLiter = semuaItemBbm.reduce((s, x) => s + (Number(x.literIsi) || 0), 0);
      if (totalLiter > 0) trip.literBensin = totalLiter;
      if (!convo.isPribadi) {
        const itemKalibrasi = [...semuaItemBbm].reverse().find(x => x.bensinSebelumIsi != null);
        if (itemKalibrasi) trip.bensinSebelumIsi = itemKalibrasi.bensinSebelumIsi;
      }

      // Update saldo Kartu E-Toll langsung -- idempotent (lepas kontribusi
      // lama, pasang kontribusi baru), sama pola dgn aplikasi.
      const linkedCard = trip.etollCardId ? (freshRaw.data.etollCards || []).find(c => c.id === trip.etollCardId) : null;
      if (linkedCard) {
        const netTopupBaru = trip.biayaOperasional.filter(x => x.kategori === 'Isi E-Toll').reduce((s, x) => s + ((Number(x.nominal) || 0) - (Number(x.biayaAdmin) || 0)), 0);
        const kontribusiLama = Number(trip.etollTopupAppliedToCard) || 0;
        if (netTopupBaru !== kontribusiLama) {
          const saldoSebelum = Number(linkedCard.saldo) || 0;
          linkedCard.saldo = saldoSebelum - kontribusiLama + netTopupBaru;
          linkedCard.updatedAt = Date.now();
          trip.etollTopupAppliedToCard = netTopupBaru;
        }
      }

      trip.updatedAt = Date.now();
      return true;
    });

    if (hasil.ok) {
      const totalBaru = convo.items.reduce((s, it) => s + it.nominal, 0);
      const ringkasan = convo.items.map(it => `• ${escapeHtmlTg(it.kategori)}${it.jenisBbm ? ' (' + escapeHtmlTg(it.jenisBbm) + ')' : ''}: ${fmtMoney(it.nominal)}`).join('\n');
      await sendTg(chatId, `✅ <b>${convo.isPribadi ? 'Biaya Pribadi' : 'Biaya Operasional'} dicatat!</b>\n\n${ringkasan}\n\nTotal item baru: ${fmtMoney(totalBaru)}\n\nTerima kasih! 🙏`);
    } else if (hasil.reason === 'not-found') {
      await sendTg(chatId, '⚠️ Trip ini sepertinya sudah ditutup/diubah lewat aplikasi duluan -- tidak jadi diproses, supaya data tidak bentrok. Cek aplikasi.');
    } else {
      await sendTg(chatId, '❌ Gagal menyimpan ke server -- coba lagi beberapa saat lagi, atau catat manual lewat aplikasi.');
    }
  }

  const KB_TAMBAH_LAGI = [[{ text: '➕ Ya, tambah lagi', callback_data: 'ya' }, { text: '✅ Selesai', callback_data: 'tidak' }]];
  function isJawabanYa(t) { return ['ya', 'iya', 'y', 'benar', 'betul', 'yes', 'ok', 'oke'].includes(t.trim().toLowerCase()); }
  function isJawabanTidak(t) { return ['tidak', 'gak', 'ga', 'enggak', 'nggak', 'no', 'selesai'].includes(t.trim().toLowerCase()); }

  // v3.170.0 -- parser durasi bebas ("4 hari 5 jam", "1/2 hari", "3 jam",
  // "2.5 jam", "90 menit", boleh kombinasi & pakai koma sbg desimal) dipakai
  // fitur "booking"/"pesan"/"boking"/"keep" supaya sopir tidak perlu isi
  // tanggal+jam selesai secara presisi, cukup bilang berapa lama.
  function parseDurasiMenit(teksRaw) {
    const t = teksRaw.toLowerCase().replace(/,/g, '.').trim();
    const re = /(\d+(?:\.\d+)?(?:\/\d+)?)\s*(hari|jam|menit)/g;
    let match, totalMenit = 0, ada = false;
    while ((match = re.exec(t))) {
      ada = true;
      const angkaStr = match[1];
      let nilai;
      if (angkaStr.includes('/')) {
        const [a, b] = angkaStr.split('/').map(Number);
        nilai = b ? a / b : NaN;
      } else {
        nilai = Number(angkaStr);
      }
      if (!isFinite(nilai)) continue;
      if (match[2] === 'hari') totalMenit += nilai * 24 * 60;
      else if (match[2] === 'jam') totalMenit += nilai * 60;
      else totalMenit += nilai;
    }
    if (!ada || totalMenit <= 0) return null;
    return Math.round(totalMenit);
  }
  function tambahMenitKeJadwal(tgl, jam, menit) {
    const d = new Date(`${tgl}T${jam}:00Z`); // "Z" cuma dipakai sbg jangkar aritmetika, bukan zona waktu sungguhan -- aman krn cuma dipakai tambah & baca lagi komponen kalender/jamnya
    d.setUTCMinutes(d.getUTCMinutes() + menit);
    return { tgl: d.toISOString().slice(0, 10), jam: d.toISOString().slice(11, 16) };
  }
  async function sendBookingApprovalToAdminsTg(chatId, convo, bookingId) {
    let admins = (state.notifAdmins || []).filter(a => a.chatId);
    let dikecualikan = null;
    if (convo.excludeApproverChatId) {
      dikecualikan = admins.find(a => (a.chatId || '').toString().trim() === convo.excludeApproverChatId) || null;
      const sisaAdmin = admins.filter(a => (a.chatId || '').toString().trim() !== convo.excludeApproverChatId);
      if (sisaAdmin.length > 0) {
        admins = sisaAdmin; // ADA admin lain -> dia (sopir yg kebetulan admin) dicoret, tidak boleh approve booking sendiri
      } else {
        // v3.171.0 -- TIDAK ADA admin lain sama sekali selain dia sendiri --
        // daripada booking nyangkut selamanya di "menunggu" tanpa siapa pun
        // yang bisa approve, tetap kirim ke dia sbg jalan darurat, TAPI kasih
        // tahu dia (& log) supaya jelas ini kondisi darurat, bukan normal.
        await sendTg(chatId, '⚠️ Catatan: Anda terdaftar sbg satu-satunya Admin Penerima Notifikasi Telegram, jadi permintaan approval booking ini tetap dikirim ke Anda juga (idealnya di-approve admin lain -- tambahkan admin lain di menu "Admin Penerima Notifikasi Telegram" kalau memungkinkan).');
      }
    }
    // v3.184.0 -- Administrator yang eligible (rolePrefs.superadmin.bookingApproval
    // === true, opt-in, default OFF) juga ikut dikirimi tombol approval ini,
    // TAMBAHAN dari daftar admins di atas (bukan pengganti).
    const notifRolePrefsRawSBA = (state.notifRolePrefs && typeof state.notifRolePrefs === 'object') ? state.notifRolePrefs : {};
    const superAdminBookingApprovalOnSBA = !!(notifRolePrefsRawSBA.superadmin && notifRolePrefsRawSBA.superadmin.bookingApproval === true);
    const superAdminsUntukApproval = superAdminBookingApprovalOnSBA ? (state.superAdmins || []).filter(sa => sa.chatId && sa.chatId !== convo.excludeApproverChatId) : [];
    if (!admins.length && !superAdminsUntukApproval.length) return;
    const text = [
      '📋 <b>Booking Baru — Perlu Persetujuan</b>',
      '',
      `<b>Mobil:</b> ${escapeHtmlTg(carLabel(convo.carId))}`,
      convo.driverId ? `<b>Sopir:</b> ${escapeHtmlTg(convo.driverNama)}` : '',
      `<b>Jenis:</b> ${convo.jenisPenggunaan === 'pribadi' ? 'Pribadi' : 'Pengiriman'}`,
      `<b>Tujuan:</b> ${escapeHtmlTg(convo.tujuan)}`,
      `<b>Mulai:</b> ${convo.tglMulai} ${convo.jamMulai}`,
      `<b>Selesai:</b> ${convo.tglSelesai} ${convo.jamSelesai}`,
      `<b>Diajukan oleh:</b> ${escapeHtmlTg(convo.petugas)} (via Telegram)${dikecualikan ? '\n\n<i>ℹ️ Diajukan oleh sopir yang kebetulan juga admin -- dia dikecualikan dari daftar approval booking ini.</i>' : ''}`,
    ].filter(Boolean).join('\n');
    const keyboard = [[
      { text: '✅ Setuju', callback_data: `bk:ya:${bookingId}` },
      { text: '❌ Tolak', callback_data: `bk:tdk:${bookingId}` },
    ]];
    // Anti-spam: `admins` (Admin Penerima Notifikasi Telegram) &
    // `superAdminsUntukApproval` (Administrator opt-in) bisa saja memuat Chat
    // ID yang SAMA (mis. 1 orang terdaftar di kedua daftar) -- sendTgUnique
    // memastikan dia cuma dapat SATU pesan approval ini, bukan dua.
    await sendTgUnique([
      ...admins.map(a => ({ chatId: a.chatId, text, keyboard })),
      ...superAdminsUntukApproval.map(sa => ({ chatId: sa.chatId, text, keyboard })),
    ]);
  }
  async function finalizeBooking(chatId, convo) {
    let conflictList = null;
    let savedBookingId = null;
    let savedKode = null;
    const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      freshRaw.data.bookings = freshRaw.data.bookings || [];
      const start = `${convo.tglMulai}T${convo.jamMulai}`;
      const end = `${convo.tglSelesai}T${convo.jamSelesai}`;
      const bentrok = freshRaw.data.bookings.filter(b =>
        b.carId === convo.carId && (b.status === 'dipesan' || b.status === 'menunggu') &&
        start < `${b.tglSelesai}T${b.jamSelesai}` && `${b.tglMulai}T${b.jamMulai}` < end
      );
      if (bentrok.length > 0) { conflictList = bentrok; return false; }
      freshRaw.data.bookingCodeSeq = (freshRaw.data.bookingCodeSeq || 0) + 1;
      savedKode = 'BKG-' + String(freshRaw.data.bookingCodeSeq).padStart(4, '0');
      savedBookingId = uidTg();
      freshRaw.data.bookings.push({
        id: savedBookingId, kode: savedKode, carId: convo.carId, driverId: convo.driverId || null,
        jenisPenggunaan: convo.jenisPenggunaan, tujuan: convo.tujuan,
        mapsLink: convo.mapsLink || null,
        tglMulai: convo.tglMulai, jamMulai: convo.jamMulai,
        tglSelesai: convo.tglSelesai, jamSelesai: convo.jamSelesai,
        // v3.170.0 -- booking dari Telegram TETAP mulai dari 'menunggu' persis
        // spt booking dari aplikasi (approval admin lewat tombol Telegram,
        // logikanya TIDAK diubah -- lihat "bk:ya:"/"bk:tdk:" di bawah).
        status: 'menunggu', catatan: convo.catatan || '',
        notifDriverIds: null,
        petugas: `${convo.petugas} (via Telegram)`,
        approvedBy: null, approvedAt: null, rejectedBy: null, rejectedAt: null,
        telegramApprovalSentAdminIds: [], telegramDriverNotifSent: !!convo.driverId, // sopir (kalau ada) sudah dikonfirmasi langsung di chat ini, tidak perlu notif terpisah lagi
        updatedAt: Date.now(),
      });
      freshRaw.data.activityLog = freshRaw.data.activityLog || [];
      freshRaw.data.activityLog.unshift({ id: uidTg(), tipe: 'booking', judul: 'Buat booking baru (via Telegram, menunggu persetujuan)', keterangan: `${carLabel(convo.carId)} — ${convo.tujuan}`, waktu: Date.now(), petugas: `${convo.petugas} (via Telegram)` });
      if (freshRaw.data.activityLog.length > 200) freshRaw.data.activityLog = freshRaw.data.activityLog.slice(0, 200);
      return true;
    });

    if (conflictList) {
      const daftar = conflictList.map(c => `• ${escapeHtmlTg(c.tujuan)} (${c.tglMulai} ${c.jamMulai} — ${c.tglSelesai} ${c.jamSelesai})`).join('\n');
      await sendTg(chatId, `⚠️ Jadwal ini BENTROK dengan booking lain untuk mobil yang sama:\n\n${daftar}\n\nSilakan pilih mobil lain, atau ketik "batal" untuk membatalkan.`, carPickerRows('bkg:car:'));
      convo.step = 'bkg_car_retry'; // convo TETAP ada -- data lain (tujuan/jadwal/dst) tidak perlu diulang
      return;
    }
    if (hasil.ok) {
      await sendTg(chatId, [
        `✅ <b>Booking berhasil dibuat!</b> (${savedKode})`,
        '',
        `🚗 ${escapeHtmlTg(carLabel(convo.carId))}`,
        `📍 ${escapeHtmlTg(convo.tujuan)}`,
        `🕐 ${convo.tglMulai} ${convo.jamMulai} — ${convo.tglSelesai} ${convo.jamSelesai}`,
        '',
        'Booking ini masih perlu disetujui admin dulu sebelum aktif. Nanti dikabari lagi begitu sudah diproses. 🙏',
      ].join('\n'));
      await sendBookingApprovalToAdminsTg(chatId, convo, savedBookingId);
    } else {
      await sendTg(chatId, '❌ Gagal menyimpan ke server -- coba lagi beberapa saat lagi, atau buat manual lewat aplikasi.');
    }
  }

  // Dispatcher untuk convo.kind selain 'tutup_trip' -- lihat titik panggil di
  // alur "tiba" (cabang "convo.kind && convo.kind !== 'tutup_trip'") di atas.
  async function handleNonTripConvo(chatId, convo, text, textRaw, pendingConversations) {
    // ================= Pola Kunjungan Berulang -> Jadikan Data Tujuan =====
    // v3.261.0 -- BARU: dipicu setelah admin tap "✅ Ya, jadikan tujuan"
    // (lihat callback "polatjn:ya:" di atas) -- tinggal 1 langkah (nama
    // lokasi), krn koordinatnya SUDAH ada dari hasil clustering pola.
    if (convo.kind === 'pola_tujuan_nama') {
      const nama = textRaw.trim();
      if (!nama) { await sendTg(chatId, '⚠️ Nama tujuan tidak boleh kosong. Ketik nama lokasinya, atau "batal".'); return; }
      const patternsPolaTjn = (state.recurringStopPatterns && state.recurringStopPatterns[convo.carId]) || [];
      const pPolaTjn = patternsPolaTjn.find(x => x.id === convo.patternId);
      if (!pPolaTjn) {
        delete pendingConversations[chatId];
        await sendTg(chatId, '⚠️ Pola ini sudah tidak ditemukan (mungkin kadaluarsa) -- dibatalkan.');
        return;
      }
      // Format link Maps SAMA dgn yang bisa dibaca extractLatLng()/
      // extractLatLngFromMapsLinkServerSide() (pola "lat,lon" di teks link).
      const mapsLinkPolaTjn = `https://www.google.com/maps/dir/?api=1&destination=${pPolaTjn.lat},${pPolaTjn.lon}`;
      const hasilSimpanTujuan = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
        freshRaw.data.destinations = freshRaw.data.destinations || [];
        freshRaw.data.destinationCodeSeq = (freshRaw.data.destinationCodeSeq || 0) + 1;
        const kodeTujuanBaru = 'TJN-' + String(freshRaw.data.destinationCodeSeq).padStart(4, '0');
        freshRaw.data.destinations.push({
          id: uidTg(), kode: kodeTujuanBaru, nama,
          jarakKm: pPolaTjn.jarakRataRataKm != null ? Math.round(pPolaTjn.jarakRataRataKm) : null,
          bbmLiter: null, mapsLink: mapsLinkPolaTjn,
          createdAt: Date.now(), petugas: `${actorNameForChat(chatId)} (via Telegram, Pola Kunjungan)`,
        });
        return true;
      });
      delete pendingConversations[chatId];
      if (hasilSimpanTujuan.ok) {
        await sendTg(chatId, `✅ <b>${escapeHtmlTg(nama)}</b> tersimpan sebagai Data Tujuan baru!\n\nKe depannya trip ke sini bisa mulai dicatat manual seperti biasa lewat Catat Perjalanan/Booking.`);
      } else {
        await sendTg(chatId, '❌ Gagal menyimpan ke server -- coba lagi ya (ulangi dari "Pola Kunjungan Berulang" di aplikasi).');
      }
      return;
    }
    // ================= RAHASIA: Daftarkan Chat ID lain sbg Administrator =====
    if (convo.kind === 'sa_add') {
      if (convo.step === 'sa_add_chatid') {
        const targetChatId = textRaw.trim();
        if (!/^-?\d+$/.test(targetChatId)) {
          await sendTg(chatId, '⚠️ Chat ID harus berupa angka. Coba kirim lagi, atau ketik "batal".');
          return;
        }
        // BARU -- cek duplikat DULU, supaya kalau Chat ID ini ternyata sudah
        // terdaftar, respon bilang itu dengan jelas (bukan pesan "sekarang
        // terdaftar" yang generik & bisa membingungkan).
        const existingSa = (state.superAdmins || []).find(a => (a.chatId || '').toString().trim() === targetChatId);
        if (existingSa) {
          delete pendingConversations[chatId];
          await sendTg(chatId, `ℹ️ Chat ID ${targetChatId} sudah terdaftar sebagai Administrator sebelumnya -- tidak didaftarkan ulang.`);
          return;
        }
        const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
          freshRaw.data.superAdmins = freshRaw.data.superAdmins || [];
          if (!freshRaw.data.superAdmins.some(a => (a.chatId || '').toString().trim() === targetChatId)) {
            freshRaw.data.superAdmins.push({ id: 'SA-' + Date.now(), chatId: targetChatId, addedAt: Date.now() });
          }
          return true;
        });
        delete pendingConversations[chatId];
        await sendTg(chatId, hasil.ok ? `✅ Chat ID ${targetChatId} sekarang terdaftar sebagai Administrator.` : '❌ Gagal menyimpan, coba lagi.');
        return;
      }
      return;
    }
    // ================= RAHASIA: Daftarkan Admin Finance (via PIN Kelola Admin) ===
    // Field WAJIB ditanya berurutan -- nama dulu, baru Chat ID -- tidak bisa
    // melompat satu pun, sama pola dengan 'sa_add' di atas. Nama sendiri
    // opsional (boleh "lewati", sama seperti field opsional lain di alur
    // Telegram -- lihat isSkip()), tapi tetap DITANYAKAN, tidak diam-diam
    // dikosongkan.
    if (convo.kind === 'fa_add') {
      if (convo.step === 'fa_nama') {
        convo.nama = isSkip(textRaw) ? '' : textRaw.trim();
        convo.step = 'fa_chatid';
        await sendTg(chatId, '🔢 Chat ID Telegram Admin Finance ini (angka):');
        return;
      }
      if (convo.step === 'fa_chatid') {
        const targetChatId = textRaw.trim();
        if (!/^-?\d+$/.test(targetChatId)) {
          await sendTg(chatId, '⚠️ Chat ID harus berupa angka. Coba kirim lagi, atau ketik "batal".');
          return;
        }
        // BARU -- kalau Chat ID ini SUDAH terdaftar sbg Admin Finance, kasih
        // tahu jelas (nama yang sudah ada) supaya tidak bingung apakah baru
        // ditambahkan atau memang sudah lama ada -- TIDAK didaftarkan dobel.
        const existingFa = (state.financeAdmins || []).find(a => (a.chatId || '').toString().trim() === targetChatId);
        if (existingFa) {
          delete pendingConversations[chatId];
          await sendTg(chatId, `ℹ️ Chat ID ${targetChatId} sudah terdaftar sebagai Admin Finance dengan nama "${escapeHtmlTg(existingFa.nama || '(tanpa nama)')}" -- tidak didaftarkan ulang.\n\nKalau mau ubah namanya, buka menu Admin Finance di aplikasi.`);
          return;
        }
        const namaBaru = convo.nama || '';
        const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
          freshRaw.data.financeAdmins = freshRaw.data.financeAdmins || [];
          if (freshRaw.data.financeAdmins.some(a => (a.chatId || '').toString().trim() === targetChatId)) return true; // sudah masuk barusan (race)
          freshRaw.data.financeAdmins.push({ id: 'FA-' + Date.now(), nama: namaBaru, chatId: targetChatId, addedAt: Date.now() });
          return true;
        });
        delete pendingConversations[chatId];
        await sendTg(chatId, hasil.ok
          ? `✅ Admin Finance baru terdaftar!\n\nNama: ${escapeHtmlTg(namaBaru || '(tanpa nama)')}\nChat ID: ${targetChatId}`
          : '❌ Gagal menyimpan, coba lagi.');
        return;
      }
      return;
    }
    // ================= RAHASIA: Daftarkan Admin Notifikasi (via PIN Kelola Admin) =
    // 3 field WAJIB berurutan: nama (opsional isinya, tetap ditanya) -> Chat
    // ID -> jenis notifikasi trip (dipilih lewat tombol, bukan ketik bebas,
    // supaya nilainya selalu salah satu dari 3 pilihan valid sama seperti
    // yang dijaga di aplikasi web -- lihat index.html baris ~4593).
    if (convo.kind === 'na_add') {
      if (convo.step === 'na_nama') {
        convo.nama = isSkip(textRaw) ? '' : textRaw.trim();
        convo.step = 'na_chatid';
        await sendTg(chatId, '🔢 Chat ID Telegram Admin Notifikasi ini (angka):');
        return;
      }
      if (convo.step === 'na_chatid') {
        const targetChatId = textRaw.trim();
        if (!/^-?\d+$/.test(targetChatId)) {
          await sendTg(chatId, '⚠️ Chat ID harus berupa angka. Coba kirim lagi, atau ketik "batal".');
          return;
        }
        const existingNa = (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === targetChatId);
        if (existingNa) {
          delete pendingConversations[chatId];
          await sendTg(chatId, `ℹ️ Chat ID ${targetChatId} sudah terdaftar sebagai Admin Notifikasi dengan nama "${escapeHtmlTg(existingNa.nama || '(tanpa nama)')}" -- tidak didaftarkan ulang.\n\nKalau mau ubah, buka menu Admin Penerima Notifikasi di aplikasi.`);
          return;
        }
        convo.chatId = targetChatId;
        convo.step = 'na_tripnotif';
        await sendTg(chatId, '🧾 Jenis notifikasi trip untuk Admin ini?', withBatal([
          [{ text: 'Ringkas', callback_data: 'na:trip:ringkas' }],
          [{ text: 'Kirim Resi Lengkap', callback_data: 'na:trip:resi' }],
          [{ text: 'Nonaktif', callback_data: 'na:trip:off' }],
        ]));
        return;
      }
      if (convo.step === 'na_tripnotif') {
        if (!textRaw.startsWith('na:trip:')) {
          await sendTg(chatId, 'Belum jelas 🙏 Silakan pilih salah satu tombol di atas ya.');
          return;
        }
        const tripNotif = textRaw.slice('na:trip:'.length);
        const namaBaru = convo.nama || '';
        const targetChatId = convo.chatId;
        // Cek ulang duplikat (jaga-jaga kalau Chat ID sempat didaftarkan dari
        // tempat lain di antara step Chat ID & step ini).
        const existingNaLagi = (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === targetChatId);
        if (existingNaLagi) {
          delete pendingConversations[chatId];
          await sendTg(chatId, `ℹ️ Chat ID ${targetChatId} ternyata sudah terdaftar sebagai Admin Notifikasi dengan nama "${escapeHtmlTg(existingNaLagi.nama || '(tanpa nama)')}" -- tidak didaftarkan ulang.`);
          return;
        }
        const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
          freshRaw.data.notifAdmins = freshRaw.data.notifAdmins || [];
          if (freshRaw.data.notifAdmins.some(a => (a.chatId || '').toString().trim() === targetChatId)) return true; // race
          freshRaw.data.notifAdmins.push({ id: 'NA-' + Date.now(), nama: namaBaru, chatId: targetChatId, tripNotif, addedAt: Date.now() });
          return true;
        });
        delete pendingConversations[chatId];
        const tripNotifLabel = { ringkas: 'Ringkas', resi: 'Kirim Resi Lengkap', off: 'Nonaktif' }[tripNotif] || tripNotif;
        await sendTg(chatId, hasil.ok
          ? `✅ Admin Notifikasi baru terdaftar!\n\nNama: ${escapeHtmlTg(namaBaru || '(tanpa nama)')}\nChat ID: ${targetChatId}\nNotifikasi Trip: ${tripNotifLabel}`
          : '❌ Gagal menyimpan, coba lagi.');
        return;
      }
      return;
    }
    // ================= ISI BBM (Luar Trip) =================
    if (convo.kind === 'isi_bbm') {
      if (convo.step === 'sbbm_car') {
        if (!textRaw.startsWith('sbbm:car:')) { await sendTg(chatId, 'Silakan pilih mobil dari daftar tombol di atas ya.'); return; }
        const carId = textRaw.slice('sbbm:car:'.length);
        const car = state.cars.find(c => c.id === carId);
        if (!car) { delete pendingConversations[chatId]; await sendTg(chatId, '⚠️ Mobil tidak ditemukan -- ketik "isi" lagi ya.'); return; }
        convo.carId = carId;
        convo.step = 'sbbm_tanggal';
        await sendTg(chatId, '📅 Tanggal pengisian? Ketik <b>hari ini</b>, atau tanggal (mis. 2026-07-30, 30/7/2026, 30 Juli 2026).', [[{ text: '📅 Hari ini', callback_data: 'sbbm:tgl:hari_ini' }]]);
        return;
      }
      if (convo.step === 'sbbm_tanggal') {
        let tanggal;
        if (text === 'sbbm:tgl:hari_ini' || ['hari ini', 'hariini', 'today'].includes(text)) {
          tanggal = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
        } else {
          const hasilTgl = parseTanggalBebas(textRaw);
          if (!hasilTgl) {
            await sendTg(chatId, '⚠️ Tanggal belum dikenali. Contoh: "hari ini", "2026-07-30", "30/7/2026", atau "30 Juli 2026".');
            return;
          }
          tanggal = hasilTgl;
        }
        convo.tanggal = tanggal;
        convo.step = 'sbbm_jenis';
        await sendTg(chatId, '⛽ Jenis BBM apa? (wajib)', jenisBbmRows());
        return;
      }
      if (convo.step === 'sbbm_jenis') {
        if (!textRaw.startsWith('jbbm:')) { await sendTg(chatId, 'Silakan pilih dari tombol jenis BBM di atas ya.'); return; }
        const val = textRaw.slice('jbbm:'.length);
        if (val === '__lainnya__') {
          convo.step = 'sbbm_jenis_custom';
          await sendTg(chatId, '✏️ Ketik nama jenis BBM-nya (contoh: Dexlite).');
          return;
        }
        convo.jenisBbm = val;
        // v3.259.0 -- BARU: kalau nominal sudah dipintas dari pesan 1-baris
        // (mis. "bensin 50000", lihat shortcutBbmMatch di atas), lewati
        // pertanyaan nominal -- langsung pakai angka itu & lanjut ke step
        // berikutnya.
        if (convo.prefilledNominal != null) {
          convo.nominal = convo.prefilledNominal;
          delete convo.prefilledNominal;
          const carShortcut = state.cars.find(c => c.id === convo.carId);
          convo.step = 'sbbm_sebelum';
          await sendTg(chatId, pertanyaanBbmLevel(carShortcut, 'Bensin Sebelum Isi'));
          return;
        }
        convo.step = 'sbbm_nominal';
        await sendTg(chatId, '💰 Nominal (Rp)? (wajib) Ketik angkanya (contoh: 150000), atau kirim FOTO struk-nya -- nanti dibacakan otomatis.');
        return;
      }
      if (convo.step === 'sbbm_jenis_custom') {
        const val = textRaw.trim();
        if (!val) { await sendTg(chatId, '⚠️ Nama jenis BBM tidak boleh kosong.'); return; }
        convo.jenisBbm = val;
        // v3.259.0 -- BARU: sama pola dgn step 'sbbm_jenis' di atas.
        if (convo.prefilledNominal != null) {
          convo.nominal = convo.prefilledNominal;
          delete convo.prefilledNominal;
          const carShortcut = state.cars.find(c => c.id === convo.carId);
          convo.step = 'sbbm_sebelum';
          await sendTg(chatId, pertanyaanBbmLevel(carShortcut, 'Bensin Sebelum Isi'));
          return;
        }
        convo.step = 'sbbm_nominal';
        await sendTg(chatId, '💰 Nominal (Rp)? (wajib) Ketik angkanya (contoh: 150000), atau kirim FOTO struk-nya -- nanti dibacakan otomatis.');
        return;
      }
      if (convo.step === 'sbbm_nominal') {
        const angka = Number(textRaw.replace(/[^\d]/g, ''));
        if (!isFinite(angka) || angka <= 0) { await sendTg(chatId, '⚠️ Nominal wajib diisi, lebih dari 0. Ketik angkanya (contoh: 150000), atau kirim FOTO struk-nya.'); return; }
        convo.nominal = angka;
        const car = state.cars.find(c => c.id === convo.carId);
        convo.step = 'sbbm_sebelum';
        await sendTg(chatId, pertanyaanBbmLevel(car, 'Bensin Sebelum Isi'));
        return;
      }
      // v3.259.0 -- BARU: konfirmasi hasil OCR foto struk (lihat
      // ocrReceiptNominal() & interception foto di blok isMediaMsg, dekat
      // qr_upload). SENGAJA selalu minta konfirmasi manual -- OCR foto itu
      // pada dasarnya tebakan, jangan pernah dianggap pasti benar tanpa
      // diverifikasi sopir.
      if (convo.step === 'sbbm_nominal_ocr_confirm') {
        if (text === 'sbbm:ocrok' || yaAliases().includes(text)) {
          convo.nominal = convo.ocrNominalGuess;
          delete convo.ocrNominalGuess;
          const car = state.cars.find(c => c.id === convo.carId);
          convo.step = 'sbbm_sebelum';
          await sendTg(chatId, pertanyaanBbmLevel(car, 'Bensin Sebelum Isi'));
          return;
        }
        // Bukan konfirmasi "ya" -- anggap sopir mengetik angka koreksi manual
        // (pola validasi SAMA dgn step 'sbbm_nominal' biasa).
        const angkaKoreksi = Number(textRaw.replace(/[^\d]/g, ''));
        if (!isFinite(angkaKoreksi) || angkaKoreksi <= 0) {
          await sendTg(chatId, '⚠️ Ketik "ya" kalau nominal di atas sudah benar, atau ketik angka yang benar (contoh: 150000).');
          return;
        }
        convo.nominal = angkaKoreksi;
        delete convo.ocrNominalGuess;
        const car = state.cars.find(c => c.id === convo.carId);
        convo.step = 'sbbm_sebelum';
        await sendTg(chatId, pertanyaanBbmLevel(car, 'Bensin Sebelum Isi'));
        return;
      }
      if (convo.step === 'sbbm_sebelum') {
        const car = state.cars.find(c => c.id === convo.carId);
        const batasAtas = levelSebelumMaxFor(car);
        const angka = Number(textRaw.replace(',', '.'));
        if (!isFinite(angka) || textRaw.trim() === '' || angka < 0 || angka > batasAtas) {
          await sendTg(chatId, `⚠️ Harus angka 0-${batasAtas}. ` + pertanyaanBbmLevel(car, 'Bensin Sebelum Isi'));
          return;
        }
        convo.bensinSebelum = car.tipeIndikatorBbm === 'bar' ? convertBarToPercent(angka, car.maxBarBbm || 8) : angka;
        convo.step = 'sbbm_sesudah';
        await sendTg(chatId, pertanyaanBbmLevel(car, 'Bensin Sesudah Isi'));
        return;
      }
      if (convo.step === 'sbbm_sesudah') {
        const car = state.cars.find(c => c.id === convo.carId);
        const batasAtas = levelSebelumMaxFor(car);
        const angka = Number(textRaw.replace(',', '.'));
        if (!isFinite(angka) || textRaw.trim() === '' || angka < 0 || angka > batasAtas) {
          await sendTg(chatId, `⚠️ Harus angka 0-${batasAtas}. ` + pertanyaanBbmLevel(car, 'Bensin Sesudah Isi'));
          return;
        }
        convo.bensinSesudah = car.tipeIndikatorBbm === 'bar' ? convertBarToPercent(angka, car.maxBarBbm || 8) : angka;
        convo.step = 'sbbm_liter';
        await sendTg(chatId, '🧴 Liter yang diisi/dibeli? (opsional -- ketik "lewati" kalau tidak diisi). Contoh: 15');
        return;
      }
      if (convo.step === 'sbbm_liter') {
        if (isSkip(textRaw)) { convo.liter = null; } else {
          const angka = Number(textRaw.replace(',', '.'));
          if (!isFinite(angka) || angka < 0) { await sendTg(chatId, '⚠️ Belum berupa angka yang valid. Ketik liternya, atau "lewati" kalau tidak diisi.'); return; }
          convo.liter = angka;
        }
        convo.step = 'sbbm_catatan';
        await sendTg(chatId, '📝 Catatan? (opsional -- ketik "lewati" kalau tidak diisi)');
        return;
      }
      if (convo.step === 'sbbm_catatan') {
        convo.catatan = isSkip(textRaw) ? '' : textRaw.trim();
        await finalizeIsiBbm(chatId, convo);
        delete pendingConversations[chatId];
        return;
      }
      return;
    }

    // ================= ISI SALDO E-TOLL (Luar Trip) =================
    if (convo.kind === 'isi_etoll') {
      if (convo.step === 'setl_card') {
        if (!textRaw.startsWith('setl:card:')) { await sendTg(chatId, 'Silakan pilih kartu dari tombol di atas ya.'); return; }
        const cardId = textRaw.slice('setl:card:'.length);
        const card = state.etollCards.find(c => c.id === cardId);
        if (!card) { delete pendingConversations[chatId]; await sendTg(chatId, '⚠️ Kartu tidak ditemukan -- ketik "isi" lagi ya.'); return; }
        convo.cardId = cardId;
        convo.step = 'setl_nominal';
        await sendTg(chatId, '💰 Nominal Top Up (Rp)? (wajib) Contoh: 100000');
        return;
      }
      if (convo.step === 'setl_nominal') {
        const angka = Number(textRaw.replace(/[^\d]/g, ''));
        if (!isFinite(angka) || angka <= 0) { await sendTg(chatId, '⚠️ Nominal wajib diisi, lebih dari 0. Contoh: 100000'); return; }
        convo.nominal = angka;
        convo.step = 'setl_ket';
        await sendTg(chatId, '📝 Keterangan? (opsional -- ketik "lewati" kalau tidak diisi). Contoh: Top up di Indomaret');
        return;
      }
      if (convo.step === 'setl_ket') {
        convo.keterangan = isSkip(textRaw) ? '' : textRaw.trim();
        await finalizeIsiEtoll(chatId, convo);
        delete pendingConversations[chatId];
        return;
      }
      return;
    }

    // ================= BIAYA OPERASIONAL / PRIBADI (selama trip berjalan) =================
    if (convo.kind === 'biaya_op') {
      const car = state.cars.find(c => c.id === convo.carId);

      if (convo.step === 'bop_menu') {
        if (!textRaw.startsWith('bop:kat:')) { await sendTg(chatId, 'Silakan pilih kategori dari tombol di atas ya.', biayaOpMenuKeyboard()); return; }
        const kategori = textRaw.slice('bop:kat:'.length);
        if (!BIAYA_OP_CATEGORIES.includes(kategori)) { await sendTg(chatId, '⚠️ Kategori tidak dikenali, coba pilih lagi.', biayaOpMenuKeyboard()); return; }
        convo.current = { kategori };
        if (kategori === 'Isi BBM') {
          convo.step = 'bop_jenis';
          await sendTg(chatId, '⛽ Jenis BBM apa? (wajib)', jenisBbmRows());
        } else if (kategori === 'Lainnya') {
          convo.step = 'bop_kategori_custom';
          await sendTg(chatId, '✏️ Nama kategori lain apa? (contoh: Tiket tol darurat)');
        } else {
          convo.step = 'bop_nominal';
          await sendTg(chatId, `💰 Nominal (Rp) untuk "${kategori}"? Contoh: 25000`);
        }
        return;
      }
      if (convo.step === 'bop_kategori_custom') {
        const val = textRaw.trim();
        if (!val) { await sendTg(chatId, '⚠️ Nama kategori tidak boleh kosong.'); return; }
        convo.current.kategori = val;
        convo.step = 'bop_nominal';
        await sendTg(chatId, `💰 Nominal (Rp) untuk "${val}"? Contoh: 25000`);
        return;
      }
      if (convo.step === 'bop_jenis') {
        if (!textRaw.startsWith('jbbm:')) { await sendTg(chatId, 'Silakan pilih dari tombol jenis BBM di atas ya.'); return; }
        const val = textRaw.slice('jbbm:'.length);
        if (val === '__lainnya__') {
          convo.step = 'bop_jenis_custom';
          await sendTg(chatId, '✏️ Ketik nama jenis BBM-nya (contoh: Dexlite).');
          return;
        }
        convo.current.jenisBbm = val;
        convo.step = 'bop_nominal';
        await sendTg(chatId, '💰 Nominal (Rp)? Contoh: 150000');
        return;
      }
      if (convo.step === 'bop_jenis_custom') {
        const val = textRaw.trim();
        if (!val) { await sendTg(chatId, '⚠️ Nama jenis BBM tidak boleh kosong.'); return; }
        convo.current.jenisBbm = val;
        convo.step = 'bop_nominal';
        await sendTg(chatId, '💰 Nominal (Rp)? Contoh: 150000');
        return;
      }
      if (convo.step === 'bop_nominal') {
        const angka = Number(textRaw.replace(/[^\d]/g, ''));
        if (!isFinite(angka) || angka <= 0) { await sendTg(chatId, '⚠️ Nominal wajib diisi, lebih dari 0.'); return; }
        convo.current.nominal = angka;
        if (convo.current.kategori === 'Isi BBM') {
          convo.step = 'bop_liter';
          await sendTg(chatId, '🧴 Liter? (opsional -- ketik "lewati" kalau tidak diisi). Contoh: 15');
        } else if (convo.current.kategori === 'Isi E-Toll') {
          convo.step = 'bop_admin';
          await sendTg(chatId, '💸 Biaya Admin? (opsional -- ketik "lewati" kalau tidak diisi). Contoh: 1500');
        } else {
          convo.step = 'bop_catatan';
          await sendTg(chatId, '📝 Catatan? (opsional -- ketik "lewati" kalau tidak diisi)');
        }
        return;
      }
      if (convo.step === 'bop_liter') {
        if (isSkip(textRaw)) { convo.current.liter = null; } else {
          const angka = Number(textRaw.replace(',', '.'));
          if (!isFinite(angka) || angka < 0) { await sendTg(chatId, '⚠️ Belum berupa angka yang valid. Ketik liternya, atau "lewati" kalau tidak diisi.'); return; }
          convo.current.liter = angka;
        }
        convo.step = 'bop_level';
        await sendTg(chatId, pertanyaanBbmLevel(car, 'Level Sebelum') + ' (opsional -- ketik "lewati" kalau tidak diisi)');
        return;
      }
      if (convo.step === 'bop_level') {
        if (isSkip(textRaw)) { convo.current.bensinSebelumIsi = null; } else {
          const batasAtas = levelSebelumMaxFor(car);
          const angka = Number(textRaw.replace(',', '.'));
          if (!isFinite(angka) || angka < 0 || angka > batasAtas) { await sendTg(chatId, `⚠️ Harus angka 0-${batasAtas}, atau "lewati" kalau tidak diisi.`); return; }
          convo.current.bensinSebelumIsi = angka;
        }
        convo.step = 'bop_catatan';
        await sendTg(chatId, '📝 Catatan? (opsional -- ketik "lewati" kalau tidak diisi)');
        return;
      }
      if (convo.step === 'bop_admin') {
        if (isSkip(textRaw)) { convo.current.biayaAdmin = null; } else {
          const angka = Number(textRaw.replace(/[^\d]/g, ''));
          if (!isFinite(angka) || angka < 0) { await sendTg(chatId, '⚠️ Belum berupa angka yang valid. Ketik nominal biaya admin, atau "lewati" kalau tidak diisi.'); return; }
          convo.current.biayaAdmin = angka;
        }
        convo.step = 'bop_catatan';
        await sendTg(chatId, '📝 Catatan? (opsional -- ketik "lewati" kalau tidak diisi)');
        return;
      }
      if (convo.step === 'bop_catatan') {
        convo.current.catatan = isSkip(textRaw) ? '' : textRaw.trim();
        convo.items.push(convo.current);
        convo.current = {};
        convo.step = 'bop_tambah';
        await sendTg(chatId, '➕ Tambah item biaya lagi, atau sudah selesai?', KB_TAMBAH_LAGI);
        return;
      }
      if (convo.step === 'bop_tambah') {
        if (isJawabanYa(textRaw)) {
          convo.step = 'bop_menu';
          await sendTg(chatId, biayaOpMenuText(convo.isPribadi), biayaOpMenuKeyboard());
          return;
        }
        if (isJawabanTidak(textRaw)) {
          await finalizeBiayaOp(chatId, convo);
          delete pendingConversations[chatId];
          return;
        }
        await sendTg(chatId, 'Belum jelas 🙏 Ketik/tap "Ya, tambah lagi" atau "Selesai".', KB_TAMBAH_LAGI);
        return;
      }
      return;
    }

    // ================= BOOKING MOBIL (via chat) =================
    if (convo.kind === 'booking') {
      if (convo.step === 'bkg_car' || convo.step === 'bkg_car_retry') {
        if (!textRaw.startsWith('bkg:car:')) { await sendTg(chatId, 'Silakan pilih mobil dari daftar tombol di atas ya.'); return; }
        const carId = textRaw.slice('bkg:car:'.length);
        const car = state.cars.find(c => c.id === carId);
        if (!car) { delete pendingConversations[chatId]; await sendTg(chatId, '⚠️ Mobil tidak ditemukan -- ketik "booking" lagi ya.'); return; }
        convo.carId = carId;
        if (convo.step === 'bkg_car_retry') {
          // Data lain (jenis/tujuan/jadwal/dst) sudah ada dari sebelumnya --
          // langsung cek konflik & simpan lagi dgn mobil yang baru dipilih.
          await finalizeBooking(chatId, convo);
          if (convo.step !== 'bkg_car_retry') delete pendingConversations[chatId]; // finalizeBooking sendiri yg set 'bkg_car_retry' lagi kalau masih bentrok
          return;
        }
        convo.step = 'bkg_jenis';
        await sendTg(chatId, '📦 Keperluannya apa?', [[
          { text: '📦 Pengiriman (operasional)', callback_data: 'bkg:jenis:pengiriman' },
          { text: '🏠 Pribadi', callback_data: 'bkg:jenis:pribadi' },
        ]]);
        return;
      }
      if (convo.step === 'bkg_jenis') {
        if (!textRaw.startsWith('bkg:jenis:')) { await sendTg(chatId, 'Silakan pilih dari tombol di atas ya.'); return; }
        convo.jenisPenggunaan = textRaw.slice('bkg:jenis:'.length);
        convo.step = 'bkg_tujuan';
        await sendTg(chatId, '📍 Tujuan / keperluannya apa? (wajib) Contoh: Antar barang ke Gudang B');
        return;
      }
      if (convo.step === 'bkg_tujuan') {
        const val = textRaw.trim();
        if (!val) { await sendTg(chatId, '⚠️ Tujuan wajib diisi.'); return; }
        convo.tujuan = val;
        convo.step = 'bkg_maps';
        await sendTg(chatId, '🔗 Link Google Maps tujuan? (opsional -- ketik "lewati" kalau tidak ada)');
        return;
      }
      if (convo.step === 'bkg_maps') {
        convo.mapsLink = isSkip(textRaw) ? null : textRaw.trim();
        convo.step = 'bkg_mulai';
        await sendTg(chatId, '🕐 Kapan mobil mulai dipakai? Ketik <b>sekarang</b>, atau tanggal & jam (mis. 2026-08-02 08:00, 2/8/2026 08:00, 2 Agustus 2026 08:00).', [[{ text: '🕐 Sekarang', callback_data: 'bkg:mulai:sekarang' }]]);
        return;
      }
      if (convo.step === 'bkg_mulai') {
        let tglMulai, jamMulai;
        if (text === 'bkg:mulai:sekarang' || ['sekarang', 'now'].includes(text)) {
          tglMulai = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
          jamMulai = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
        } else {
          const hasil = parseTanggalJamBebas(textRaw);
          if (!hasil) { await sendTg(chatId, '⚠️ Tanggal & jam belum dikenali. Ketik "sekarang", atau contoh: "2026-08-02 08:00", "2/8/2026 08:00", "2 Agustus 2026 08:00".'); return; }
          tglMulai = hasil.tanggal; jamMulai = hasil.jam;
        }
        convo.tglMulai = tglMulai;
        convo.jamMulai = jamMulai;
        convo.step = 'bkg_durasi';
        await sendTg(chatId, '⏳ Mau dipakai berapa lama? Contoh: <b>3 jam</b>, <b>4 hari 5 jam</b>, <b>1/2 hari</b>.');
        return;
      }
      if (convo.step === 'bkg_durasi') {
        const menit = parseDurasiMenit(textRaw);
        if (menit == null) { await sendTg(chatId, '⚠️ Belum saya mengerti durasinya. Contoh yang benar: "3 jam", "4 hari 5 jam", "1/2 hari", "90 menit".'); return; }
        const selesai = tambahMenitKeJadwal(convo.tglMulai, convo.jamMulai, menit);
        convo.tglSelesai = selesai.tgl;
        convo.jamSelesai = selesai.jam;
        convo.step = 'bkg_catatan';
        await sendTg(chatId, `📅 Oke, ${convo.tglMulai} ${convo.jamMulai} — ${convo.tglSelesai} ${convo.jamSelesai}.\n\n📝 Catatan? (opsional -- ketik "lewati" kalau tidak diisi)`);
        return;
      }
      if (convo.step === 'bkg_catatan') {
        convo.catatan = isSkip(textRaw) ? '' : textRaw.trim();
        await finalizeBooking(chatId, convo);
        if (convo.step !== 'bkg_car_retry') delete pendingConversations[chatId]; // kalau bentrok, finalizeBooking sudah set convo.step='bkg_car_retry' & convo TETAP disimpan
        return;
      }
      return;
    }

    // ================= MULAI PERJALANAN / "BERANGKAT" (via chat) =================
    // Pasangan dari alur "tiba" (tutup trip) -- bikin 1 baris state.usage
    // BARU berstatus 'digunakan', identik dgn tombol "Berangkat" di form
    // Catat Perjalanan (openUsageModal() di index.html). Urutan langkah:
    // pilih mobil (tersedia saja) -> jenis perjalanan -> tujuan (dicek
    // rekomendasi ke Data Tujuan) -> link maps (kalau tujuan baru) ->
    // odometer (tanya-konfirmasi GPS.id dulu kalau ada) -> level BBM ->
    // pilih kartu E-Toll (tanya-konfirmasi saldo dulu) -> simpan.
    if (convo.kind === 'mulai_trip') {
      const carMt = state.cars.find(c => c.id === convo.carId);

      // ---- pilih mobil ----
      if (convo.step === 'mt_car') {
        if (!textRaw.startsWith('mt:car:')) { await sendTg(chatId, 'Silakan pilih mobil dari daftar tombol di atas ya.'); return; }
        const carId = textRaw.slice('mt:car:'.length);
        const carPilihan = state.cars.find(c => c.id === carId);
        if (!carPilihan) { delete pendingConversations[chatId]; await sendTg(chatId, '⚠️ Mobil tidak ditemukan -- ketik "berangkat" lagi ya.'); return; }
        const sudahDipakai = state.usage.some(u => u.carId === carId && u.status === 'digunakan');
        if (sudahDipakai) {
          await sendTg(chatId, '⚠️ Mobil ini baru saja mulai dipakai (lewat aplikasi/sopir lain). Silakan pilih mobil lain:', withBatal(availableCarPickerRows('mt:car:')));
          return;
        }
        convo.carId = carId;
        convo.step = 'mt_jenis';
        await sendTg(chatId, '📦 Jenis perjalanannya apa?', withBatal([[
          { text: '📦 Pengiriman (operasional)', callback_data: 'mt:jenis:pengiriman' },
          { text: '🏠 Pribadi', callback_data: 'mt:jenis:pribadi' },
        ]]));
        return;
      }

      if (!carMt) {
        delete pendingConversations[chatId];
        await sendTg(chatId, '⚠️ Data mobil untuk trip ini sudah tidak ditemukan -- percakapan dibatalkan otomatis. Cek langsung di aplikasi.');
        return;
      }

      // ---- jenis perjalanan ----
      if (convo.step === 'mt_jenis') {
        if (!textRaw.startsWith('mt:jenis:')) { await sendTg(chatId, 'Silakan pilih dari tombol di atas ya.'); return; }
        convo.jenisPenggunaan = textRaw.slice('mt:jenis:'.length);
        convo.step = 'mt_tujuan';
        await sendTg(chatId, '📍 Tujuan / keperluan perjalanan ini apa? Ketik manual ya, nanti saya cek dulu ke Data Tujuan.\n\nContoh: Gudang Surabaya');
        return;
      }

      // ---- tujuan (freetext -> dicek rekomendasi ke Data Tujuan) ----
      if (convo.step === 'mt_tujuan') {
        const val = textRaw.trim();
        if (!val) { await sendTg(chatId, '⚠️ Tujuan wajib diisi.'); return; }
        convo.tujuanInput = val;
        const saran = cariSaranTujuan(val);
        if (saran.exact) {
          convo.tujuan = saran.exact;
          const destObj = (state.destinations || []).find(d => (d.nama || '').trim().toLowerCase() === saran.exact.toLowerCase());
          convo.mapsLink = destObj ? (destObj.mapsLink || null) : null;
          await lanjutSetelahTujuanMt(chatId, convo, carMt);
          return;
        }
        if (saran.close) {
          convo.tujuanCandidate = saran.close;
          convo.step = 'mt_tujuan_confirm_close';
          await sendTg(chatId, `🔎 Tujuan yang Anda ketik ("${escapeHtmlTg(val)}") mirip dengan yang sudah ada di Data Tujuan: <b>${escapeHtmlTg(saran.close)}</b>.\n\nPakai nama yang sudah ada ini supaya data tetap akurat & tidak dobel?`, withBatal([[
            { text: `✅ Ya, pakai "${saran.close}"`, callback_data: 'ya' },
            { text: '✏️ Tidak, pakai punya saya', callback_data: 'tidak' },
          ]]));
          return;
        }
        if (saran.partial.length > 0) {
          convo.tujuanPartialList = saran.partial;
          convo.step = 'mt_tujuan_pilih';
          const rows = saran.partial.map((n, i) => [{ text: '📍 ' + n, callback_data: 'mt:tujuan:idx:' + i }]);
          rows.push([{ text: `✏️ Pakai tulisan saya: "${val}"`, callback_data: 'mt:tujuan:sendiri' }]);
          await sendTg(chatId, `🔎 Ditemukan beberapa tujuan yang mirip/searah di Data Tujuan untuk "${escapeHtmlTg(val)}":`, withBatal(rows));
          return;
        }
        // Tidak ada kecocokan sama sekali -> anggap tujuan baru.
        convo.tujuan = val;
        convo.mapsLink = null;
        convo.step = 'mt_maps';
        await sendTg(chatId, `🔗 Tujuan "${escapeHtmlTg(val)}" belum ada di Data Tujuan -- nanti otomatis ditambahkan. Ada link Google Maps-nya? (opsional, ketik "lewati" kalau tidak ada)`);
        return;
      }

      // ---- konfirmasi tujuan yang MIRIP (typo-tolerant) ----
      if (convo.step === 'mt_tujuan_confirm_close') {
        if (isJawabanYa(textRaw)) {
          convo.tujuan = convo.tujuanCandidate;
          const destObj = (state.destinations || []).find(d => (d.nama || '').trim().toLowerCase() === convo.tujuanCandidate.toLowerCase());
          convo.mapsLink = destObj ? (destObj.mapsLink || null) : null;
          delete convo.tujuanCandidate;
          await lanjutSetelahTujuanMt(chatId, convo, carMt);
          return;
        }
        if (isJawabanTidak(textRaw)) {
          convo.tujuan = convo.tujuanInput;
          convo.mapsLink = null;
          delete convo.tujuanCandidate;
          convo.step = 'mt_maps';
          await sendTg(chatId, '🔗 Oke, dipakai sesuai ketikan Anda -- nanti otomatis ditambahkan ke Data Tujuan. Ada link Google Maps-nya? (opsional, ketik "lewati" kalau tidak ada)');
          return;
        }
        await sendTg(chatId, 'Belum jelas 🙏 Silakan pilih salah satu tombol di atas ya.', withBatal([[
          { text: `✅ Ya, pakai "${convo.tujuanCandidate}"`, callback_data: 'ya' },
          { text: '✏️ Tidak, pakai punya saya', callback_data: 'tidak' },
        ]]));
        return;
      }

      // ---- pilih dari beberapa tujuan mirip/searah ----
      if (convo.step === 'mt_tujuan_pilih') {
        if (textRaw === 'mt:tujuan:sendiri') {
          convo.tujuan = convo.tujuanInput;
          convo.mapsLink = null;
          convo.step = 'mt_maps';
          await sendTg(chatId, '🔗 Oke, dipakai sesuai ketikan Anda -- nanti otomatis ditambahkan ke Data Tujuan. Ada link Google Maps-nya? (opsional, ketik "lewati" kalau tidak ada)');
          return;
        }
        if (textRaw.startsWith('mt:tujuan:idx:')) {
          const idx = Number(textRaw.slice('mt:tujuan:idx:'.length));
          const nama = Array.isArray(convo.tujuanPartialList) ? convo.tujuanPartialList[idx] : null;
          if (nama == null) { await sendTg(chatId, '⚠️ Pilihan tidak valid, coba lagi ya.'); return; }
          convo.tujuan = nama;
          const destObj = (state.destinations || []).find(d => (d.nama || '').trim().toLowerCase() === nama.toLowerCase());
          convo.mapsLink = destObj ? (destObj.mapsLink || null) : null;
          await lanjutSetelahTujuanMt(chatId, convo, carMt);
          return;
        }
        await sendTg(chatId, 'Silakan pilih salah satu tombol di atas ya, atau "Pakai tulisan saya".');
        return;
      }

      // ---- link maps (opsional, cuma ditanya kalau tujuan ini BARU) ----
      if (convo.step === 'mt_maps') {
        convo.mapsLink = isSkip(textRaw) ? null : textRaw.trim();
        await lanjutSetelahTujuanMt(chatId, convo, carMt);
        return;
      }

      // ---- BARU (v3.215.0): loop tanya "tujuan lain?" -- terus muter
      // sampai sopir bilang cukup, tiap tujuan baru ditambahkan ke daftar
      // convo.tujuanTambahan. Tidak dibatasi jumlahnya (jarang lebih dari
      // segelintir dalam praktiknya, tidak perlu batas keras). ----
      if (convo.step === 'mt_tujuan_lagi') {
        const selesaiKeywords = ['lanjut', 'selesai', 'tidak ada', 'cukup', 'sudah'];
        if (isSkip(textRaw) || selesaiKeywords.includes(text)) {
          await lanjutKeOdometerMt(chatId, convo, carMt);
          return;
        }
        const namaTambahan = textRaw.trim();
        if (!namaTambahan) { await sendTg(chatId, '⚠️ Ketik nama tujuannya, atau ketik "lanjut" kalau sudah cukup.'); return; }
        // v3.229.0 -- BARU: cegah nama yang SAMA PERSIS (case-insensitive)
        // ditambahkan dobel -- baik dgn tujuan PERTAMA maupun tujuan
        // tambahan yg sudah ada -- supaya datanya tidak "menumpuk" isi
        // yang sama kalau sopir tidak sengaja ketik ulang/kirim 2x.
        convo.tujuanTambahan = convo.tujuanTambahan || [];
        const sudahAda = [convo.tujuan, ...convo.tujuanTambahan]
          .some(t => (t || '').trim().toLowerCase() === namaTambahan.toLowerCase());
        if (sudahAda) {
          await sendTg(chatId, `⚠️ <b>${escapeHtmlTg(namaTambahan)}</b> sudah ada di daftar tujuan trip ini -- tidak ditambahkan lagi.\n\nAda tujuan LAIN? Ketik namanya, atau ketik <b>lanjut</b> kalau sudah cukup.`);
          return;
        }
        convo.tujuanTambahan.push(namaTambahan);
        await sendTg(chatId, `✅ Ditambahkan: <b>${escapeHtmlTg(namaTambahan)}</b> (tujuan ke-${convo.tujuanTambahan.length + 1})\n\nAda tujuan lain lagi? Ketik namanya, atau ketik <b>lanjut</b> kalau sudah cukup.`);
        return;
      }

      // ---- konfirmasi odometer dari GPS.id ----
      if (convo.step === 'mt_confirm_odo_gps') {
        if (isJawabanYa(textRaw)) {
          convo.odoKeluarValue = convo.gpsOdoSuggestion;
          convo.step = 'mt_bbm';
          await sendTg(chatId, pertanyaanBbm(carMt));
          return;
        }
        if (isJawabanTidak(textRaw)) {
          convo.step = 'mt_odo';
          await sendTg(chatId, '🔢 Oke, ketik manual odometer sekarang (KM). Contoh: 45230');
          return;
        }
        await sendTg(chatId, `Belum jelas 🙏 Ketik <b>ya</b> kalau odometer ${Number(convo.gpsOdoSuggestion).toLocaleString('id-ID')} KM benar, atau <b>tidak</b> kalau mau isi manual.`, withBatal(KB_YA_TIDAK));
        return;
      }

      // ---- odometer manual ----
      if (convo.step === 'mt_odo') {
        const digitSaja = textRaw.replace(/[^\d]/g, '');
        const angka = Number(digitSaja);
        if (digitSaja === '' || !isFinite(angka)) {
          await sendTg(chatId, '⚠️ Belum berupa angka yang valid. Coba ketik ulang, contoh: 45230 (boleh pakai titik: 45.230)');
          return;
        }
        convo.odoKeluarValue = angka;
        convo.step = 'mt_bbm';
        await sendTg(chatId, pertanyaanBbm(carMt));
        return;
      }

      // ---- level BBM saat berangkat -- validasi PERSIS spt alur "tiba"
      // (0-maxBar utk mobil bertipe indikator "bar", 0-100 utk persen).
      // Kalau angkanya melebihi batas (mis. bar > maxBarBbm mobil ini),
      // sopir diminta ketik ulang/koreksi -- tidak ada yang dipaksa lolos. ----
      if (convo.step === 'mt_bbm') {
        const angka = Number(textRaw.replace(',', '.'));
        if (!isFinite(angka) || textRaw.trim() === '') {
          await sendTg(chatId, '⚠️ Belum berupa angka yang valid. ' + pertanyaanBbm(carMt));
          return;
        }
        const maxBar = carMt.maxBarBbm || 8;
        const batasAtas = carMt.tipeIndikatorBbm === 'bar' ? maxBar : 100;
        if (angka < 0 || angka > batasAtas) {
          await sendTg(chatId, `⚠️ Harus di antara 0-${batasAtas}. ` + pertanyaanBbm(carMt));
          return;
        }
        convo.bensinKeluarPercent = carMt.tipeIndikatorBbm === 'bar' ? convertBarToPercent(angka, maxBar) : angka;

        if (state.etollCards.length === 0) {
          await finalizeMulaiTrip(chatId, convo);
          delete pendingConversations[chatId];
          return;
        }
        convo.step = 'mt_etoll_pilih';
        const rowsEtoll = state.etollCards.map(c => [{
          text: `${c.nomorKartu}${c.mobilId ? ' — ' + carLabel(c.mobilId) : ''} (${fmtMoney(c.saldo)})`,
          callback_data: 'mt:etoll:card:' + c.id,
        }]);
        rowsEtoll.push([{ text: '🚫 Tidak pakai kartu / bayar tunai', callback_data: 'mt:etoll:none' }]);
        await sendTg(chatId, '💳 Pakai kartu E-Toll yang mana untuk perjalanan ini?', withBatal(rowsEtoll));
        return;
      }

      // ---- pilih kartu E-Toll (atau tidak pakai) ----
      if (convo.step === 'mt_etoll_pilih') {
        if (textRaw === 'mt:etoll:none') {
          convo.etollCardId = null;
          convo.saldoEtollAwalValue = null;
          await finalizeMulaiTrip(chatId, convo);
          delete pendingConversations[chatId];
          return;
        }
        if (!textRaw.startsWith('mt:etoll:card:')) { await sendTg(chatId, 'Silakan pilih dari tombol di atas ya.'); return; }
        const cardId = textRaw.slice('mt:etoll:card:'.length);
        const card = state.etollCards.find(c => c.id === cardId);
        if (!card) { await sendTg(chatId, '⚠️ Kartu tidak ditemukan, pilih lagi ya.'); return; }
        convo.etollCardId = cardId;
        convo.step = 'mt_etoll_confirm_saldo';
        await sendTg(chatId, `💳 Saldo kartu E-Toll <b>${escapeHtmlTg(card.nomorKartu)}</b> menurut data aplikasi saat ini: <b>${fmtMoney(card.saldo)}</b>.\n\nApakah itu sesuai dengan saldo fisik kartu sekarang?`, withBatal(KB_YA_TIDAK));
        return;
      }

      // ---- konfirmasi saldo E-Toll ----
      if (convo.step === 'mt_etoll_confirm_saldo') {
        const card = state.etollCards.find(c => c.id === convo.etollCardId);
        if (isJawabanYa(textRaw)) {
          convo.saldoEtollAwalValue = card ? card.saldo : 0;
          await finalizeMulaiTrip(chatId, convo);
          delete pendingConversations[chatId];
          return;
        }
        if (isJawabanTidak(textRaw)) {
          convo.step = 'mt_etoll_manual';
          await sendTg(chatId, '✏️ Oke, saldo E-Toll kartu ini sekarang berapa (Rp)? Contoh: 50000');
          return;
        }
        await sendTg(chatId, `Belum jelas 🙏 Ketik <b>ya</b> kalau saldo ${card ? fmtMoney(card.saldo) : '-'} benar, atau <b>tidak</b> kalau mau isi manual.`, withBatal(KB_YA_TIDAK));
        return;
      }

      // ---- saldo E-Toll manual ----
      if (convo.step === 'mt_etoll_manual') {
        const digitSaja = textRaw.replace(/[^\d]/g, '');
        const angka = Number(digitSaja);
        if (digitSaja === '' || !isFinite(angka)) {
          await sendTg(chatId, '⚠️ Belum berupa angka yang valid. Saldo E-Toll sekarang berapa (Rp)? Contoh: 50000');
          return;
        }
        convo.saldoEtollAwalValue = angka;
        await finalizeMulaiTrip(chatId, convo);
        delete pendingConversations[chatId];
        return;
      }
      return;
    }
  }

  // BARU (fitur "mulai perjalanan" via Telegram) -- keputusan langkah
  // SETELAH tujuan final ditentukan (baik dari rekomendasi Data Tujuan
  // maupun ketikan sendiri): kalau mobil ini sudah terhubung IMEI GPS.id,
  // tanya-konfirmasi dulu odometer dari GPS.id (PORTING PERSIS pola yang
  // sama dgn alur "tiba"/tutup trip -- lihat blok "confirm_odo_gps" di atas
  // & catatan GPS_ODO_AUTOFILL_ENABLED di awal file). Kalau tidak ada
  // datanya, langsung diam-diam jatuh ke input odometer manual.
  // v3.215.0 -- BARU: sebelum lanjut ke odometer, tawarkan tujuan tambahan
  // (multi-tujuan 1 trip, konsisten dgn fitur yang sama di index.html
  // "Tujuan Tambahan"). SENGAJA tidak pakai typo-tolerant matching
  // (cariSaranTujuan) yang dipakai tujuan PERTAMA -- supaya alur ini tetap
  // sederhana/cepat diketik sopir di lapangan, beda dari tujuan pertama yang
  // memang harus akurat betul (jadi rujukan utama Data Tujuan/estimasi biaya).
  async function lanjutSetelahTujuanMt(chatId, convo, car) {
    convo.step = 'mt_tujuan_lagi';
    await sendTg(chatId, `📍 Tujuan: <b>${escapeHtmlTg(convo.tujuan)}</b>\n\nApakah trip ini mampir ke tujuan LAIN juga? Ketik nama tujuan berikutnya, atau ketik <b>lanjut</b> kalau cuma 1 tujuan ini saja.`);
  }
  async function lanjutKeOdometerMt(chatId, convo, car) {
    const gpsOdoKm = (GPS_ODO_AUTOFILL_ENABLED && car && car.imeiGps)
      ? await getGpsIdMileageForImei(env, car.imeiGps)
      : null;
    if (gpsOdoKm != null) {
      convo.step = 'mt_confirm_odo_gps';
      convo.gpsOdoSuggestion = gpsOdoKm;
      await sendTg(chatId, `🛰️ Sistem GPS mendeteksi odometer mobil ini sekarang: <b>${gpsOdoKm.toLocaleString('id-ID')} KM</b>. Apakah benar?\n\nKetik <b>ya</b> kalau benar, atau <b>tidak</b> kalau mau isi manual.`, withBatal(KB_YA_TIDAK));
    } else {
      convo.step = 'mt_odo';
      await sendTg(chatId, '🔢 Odometer saat berangkat (KM)? Contoh: 45230');
    }
  }

  // BARU -- simpan trip baru (status 'digunakan') ke fleetops-data.json,
  // PORTING PERSIS semangat finalizeBooking()/finalizeTutupTrip() di atas:
  // baca data TERBARU (bukan `state` yg sudah agak basi sejak awal webhook),
  // cek ulang mobil masih bebas, simpan, & (kalau tujuannya baru) otomatis
  // tambahkan ke Data Tujuan -- setara ensureDestinationFromTujuan() di
  // index.html, supaya rekomendasi tujuan ke depan makin lengkap & akurat.
  async function finalizeMulaiTrip(chatId, convo) {
    const jamSekarang = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
    const tanggalSekarang = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
    let savedKode = null;
    const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      freshRaw.data.usage = freshRaw.data.usage || [];
      const masihBebas = !freshRaw.data.usage.some(u => u.carId === convo.carId && u.status === 'digunakan');
      if (!masihBebas) return false; // ditangani sbg 'not-found' -> pesan konflik di bawah
      freshRaw.data.usageCodeSeq = (freshRaw.data.usageCodeSeq || 0) + 1;
      savedKode = 'PJL-' + String(freshRaw.data.usageCodeSeq).padStart(5, '0');
      freshRaw.data.usage.push({
        id: uidTg(), kode: savedKode, carId: convo.carId, driverId: convo.driverId,
        jenisPenggunaan: convo.jenisPenggunaan, tujuan: convo.tujuan,
        tujuanTambahan: (Array.isArray(convo.tujuanTambahan) && convo.tujuanTambahan.length) ? convo.tujuanTambahan : null,
        mapsLink: convo.mapsLink || null,
        tglKeluar: tanggalSekarang, tglKembali: null, jamKeluar: jamSekarang, jamKembali: null,
        status: 'digunakan',
        odoKeluar: convo.odoKeluarValue != null ? convo.odoKeluarValue : null, odoKembali: null,
        bensinKeluar: convo.bensinKeluarPercent != null ? convo.bensinKeluarPercent : null, bensinKembali: null,
        literBensin: null, biayaBensin: null,
        etollCardId: convo.etollCardId || null,
        saldoEtollAwal: convo.saldoEtollAwalValue != null ? convo.saldoEtollAwalValue : null,
        saldoEtoll: convo.saldoEtollAwalValue != null ? convo.saldoEtollAwalValue : null,
        petugas: `${convo.driverNama} (via Telegram)`,
        updatedAt: Date.now(),
      });
      // Sinkron ke Data Tujuan -- PORTING PERSIS semangat dari
      // ensureDestinationFromTujuan() di index.html. Dilewati utk trip
      // Pribadi (konsisten dgn aturan yg sama di aplikasi web).
      if (convo.jenisPenggunaan !== 'pribadi') {
        freshRaw.data.destinations = freshRaw.data.destinations || [];
        const namaTujuan = (convo.tujuan || '').trim();
        if (namaTujuan) {
          const existingDest = freshRaw.data.destinations.find(d => (d.nama || '').trim().toLowerCase() === namaTujuan.toLowerCase());
          if (existingDest) {
            if (convo.mapsLink && convo.mapsLink !== existingDest.mapsLink) {
              existingDest.mapsLink = convo.mapsLink;
              existingDest.updatedAt = Date.now();
            }
          } else {
            freshRaw.data.destinationCodeSeq = (freshRaw.data.destinationCodeSeq || 0) + 1;
            freshRaw.data.destinations.push({
              id: uidTg(), kode: 'TJN-' + String(freshRaw.data.destinationCodeSeq).padStart(4, '0'),
              nama: namaTujuan, jarakKm: null, bbmLiter: null, mapsLink: convo.mapsLink || null,
              createdAt: tanggalSekarang, petugas: `${convo.driverNama} (via Telegram)`, updatedAt: Date.now(),
            });
          }
        }
      }
      freshRaw.data.activityLog = freshRaw.data.activityLog || [];
      freshRaw.data.activityLog.unshift({
        id: uidTg(), tipe: 'penggunaan', judul: 'Catat penggunaan mobil (via Telegram)',
        keterangan: `${carLabel(convo.carId)} — ${convo.tujuan}`, waktu: Date.now(),
        petugas: `${convo.driverNama} (via Telegram)`,
      });
      if (freshRaw.data.activityLog.length > 200) freshRaw.data.activityLog = freshRaw.data.activityLog.slice(0, 200);
      return true;
    });

    if (hasil.ok) {
      const baris = [
        `✅ <b>Trip dimulai!</b> (${savedKode})`, '',
        `🚗 ${escapeHtmlTg(carLabel(convo.carId))}`,
        `📍 ${escapeHtmlTg(convo.tujuan)}`,
      ];
      if (convo.odoKeluarValue != null) baris.push(`🔢 Odometer Berangkat: ${convo.odoKeluarValue.toLocaleString('id-ID')} KM`);
      if (convo.saldoEtollAwalValue != null) baris.push(`💳 Saldo E-Toll Awal: ${fmtMoney(convo.saldoEtollAwalValue)}`);
      baris.push('', 'Hati-hati di jalan! Nanti kalau sudah selesai semua, ketik "akhiri trip" ya. 🙏');
      await sendTg(chatId, baris.join('\n'));
      if (ADMIN_CHAT_IDS.length) {
        const teksMulaiAdmin = `🚗 <b>${escapeHtmlTg(convo.driverNama)}</b> mulai trip lewat Telegram -- ${escapeHtmlTg(carLabel(convo.carId))} (${escapeHtmlTg(convo.tujuan)}).`;
        await sendTgUnique(ADMIN_CHAT_IDS.map(adminId => ({ chatId: adminId, text: teksMulaiAdmin })));
      }
      console.log(`webhook: ${convo.driverNama} mulai trip baru lewat chat (${savedKode}).`);
    } else if (hasil.reason === 'not-found') {
      await sendTg(chatId, '⚠️ Sepertinya mobil ini baru saja mulai dipakai duluan (lewat aplikasi/chat lain) -- silakan ketik "berangkat" lagi & pilih mobil lain.');
    } else {
      await sendTg(chatId, '❌ Gagal menyimpan ke server -- coba lagi beberapa saat lagi, atau catat manual lewat aplikasi.');
      console.log('webhook: pushMainDataUpdate (mulai trip) gagal:', JSON.stringify(hasil));
    }
  }

  async function finalizeTutupTrip(cid, convo, applyExtra) {
    const jamSekarang = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
    const tanggalSekarang = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
    // v3.??? -- Hitung rata-rata kecepatan SEBELUM transaksi tulis (mutatorFn
    // pushMainDataUpdate wajib sinkron, tidak boleh await fetch GPS.id di
    // dalamnya). Pakai jadwal keluar trip asli (dari state yg sudah dibaca
    // di awal webhook) sampai sekarang sbg rentang histori GPS.id.
    const tripAwalUntukSpeed = state.usage.find(u => u.id === convo.tripId);
    const carUntukSpeed = state.cars.find(c => c.id === convo.carId);
    const speedResult = (carUntukSpeed && carUntukSpeed.imeiGps && tripAwalUntukSpeed && tripAwalUntukSpeed.tglKeluar)
      ? await computeTripAvgSpeedKmh(env, carUntukSpeed.imeiGps, tripAwalUntukSpeed.tglKeluar, tripAwalUntukSpeed.jamKeluar, tanggalSekarang, jamSekarang)
      : { avgSpeedKmh: null, error: carUntukSpeed && !carUntukSpeed.imeiGps ? 'Mobil ini belum diisi IMEI GPS.id di Data Mobil.' : null };
    let closedTrip = null;
    const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      const usageArr = freshRaw.data.usage || [];
      const trip = usageArr.find(u => u.id === convo.tripId);
      if (!trip || trip.status !== 'digunakan') return false;
      trip.odoKembali = convo.odometerValue;
      trip.bensinKembali = convo.bensinKembaliPercent;
      trip.status = 'selesai';
      trip.tglKembali = tanggalSekarang;
      trip.jamKembali = jamSekarang;
      trip.updatedAt = Date.now();
      trip.petugas = trip.petugas || `${convo.driverNama} (via Telegram)`;
      if (speedResult.avgSpeedKmh != null) { trip.avgSpeedKmh = speedResult.avgSpeedKmh; trip.avgSpeedError = null; }
      else if (speedResult.error) trip.avgSpeedError = speedResult.error;
      if (applyExtra) applyExtra(trip, usageArr);
      closedTrip = trip;
      return true;
    });

    if (hasil.ok) {
      const jarak = convo.odoKeluar != null ? (convo.odometerValue - convo.odoKeluar) : null;
      const etollLine = convo.tidakLewatTol
        ? '\nSaldo E-Toll: Tidak lewat tol (saldo/top-up dianggap masih utuh, tidak terpakai).'
        : (convo.saldoEtollValue != null ? `\nSaldo E-Toll: ${fmtMoney(convo.saldoEtollValue)}` : '');
      await sendTg(cid, `✅ <b>Trip ditutup!</b>\n\n${escapeHtmlTg(carLabel(convo.carId))} — ${escapeHtmlTg(convo.tujuan)}\n${jarak != null ? 'Jarak: ' + jarak.toLocaleString('id-ID') + ' KM\n' : ''}Odometer Tiba: ${convo.odometerValue.toLocaleString('id-ID')} KM${etollLine}\n\nTerima kasih! 🙏`);
      const teksTutupAdminRingkas = `✅ <b>${escapeHtmlTg(convo.driverNama)}</b> menutup trip lewat Telegram -- ${escapeHtmlTg(carLabel(convo.carId))} (${escapeHtmlTg(convo.tujuan)}), Odometer ${convo.odometerValue.toLocaleString('id-ID')} KM.`;
      const notifAdminsUntukIni = (state.notifAdmins || []).filter(a => a.chatId && a.tripNotif && a.tripNotif !== 'off');
      // Anti-spam: ADMIN_CHAT_IDS (Secret) & state.notifAdmins bisa memuat
      // Chat ID yang SAMA -- sendTgUnique memastikan satu Chat ID cuma
      // dikirimi SATU notifikasi tutup-trip (yang lebih dulu terdaftar di
      // array ini yang menang: ADMIN_CHAT_IDS lebih dulu -> versi ringkas).
      await sendTgUnique([
        ...ADMIN_CHAT_IDS.map(adminId => ({ chatId: adminId, text: teksTutupAdminRingkas })),
        ...notifAdminsUntukIni.map(a => ({
          chatId: a.chatId,
          // 'gambar' diperlakukan SAMA seperti 'resi' di jalur INI (teks
          // lengkap) -- Worker tidak punya browser/canvas utk render gambar
          // (html2canvas cuma jalan di browser sopir, lihat generateTripReceiptBlob
          // di index.html). Instan (jalur utama) TETAP kirim gambar sungguhan;
          // jalur webhook/cron ini murni cadangan kalau instan gagal.
          text: (a.tripNotif === 'resi' || a.tripNotif === 'gambar')
            ? buildTripReceiptText({ ...closedTrip, carId: convo.carId, tujuan: convo.tujuan, driverId: convo.driverId, driver: convo.driverNama })
            : teksTutupAdminRingkas,
        })),
      ]);
      console.log(`webhook: Trip ${convo.tripId} ditutup lewat chat oleh ${convo.driverNama}.`);
    } else if (hasil.reason === 'not-found') {
      await sendTg(cid, '⚠️ Trip ini sepertinya sudah ditutup/diubah lewat aplikasi duluan -- tidak jadi diproses dari sini, supaya data tidak bentrok. Cek aplikasi untuk pastikan datanya sudah benar.');
    } else {
      await sendTg(cid, '❌ Gagal menyimpan ke server -- coba lagi beberapa saat lagi, atau lengkapi manual lewat aplikasi.');
      console.log('webhook: pushMainDataUpdate gagal:', JSON.stringify(hasil));
    }
  }

  // ============================================================================
  // v3.165.0 -- Fitur "saldo" & pintasan kata kuncinya lewat chat Telegram.
  // Alur: ketik "saldo" -> pilih kategori -> pilih item (kartu/mobil/dokumen)
  // -> detail. Ketik langsung nama kategori (mis. "etoll") -> LOMPAT ke
  // daftar item kategori itu, skip menu utama.
  //
  // STATELESS BY DESIGN: beda dari alur "tiba" (yang nyimpen progres ke
  // pendingConversations di notif-state.json), seluruh navigasi di sini
  // dikodekan LANGSUNG di callback_data tombol inline (prefix "sd:") --
  // "sd:m" = menu utama, "sd:c:<kat>"/"sd:l:<kat>" = daftar item kategori,
  // "sd:i:<kat>:<id>" = detail 1 item. Jadi TIDAK perlu baca/tulis GitHub
  // tambahan sama sekali -- 1x baca data utama yang sudah dilakukan di atas
  // (dataRead) sudah cukup utk seluruh perjalanan menu ini. Alasan lain:
  // ini navigasi baca-saja (tidak mengubah data), beda karakter dgn alur
  // "tiba" yang butuh state multi-langkah krn menunggu balasan bertahap.
  //
  // AKSES: dibuka utk Admin (ADMIN_CHAT_IDS/state.notifAdmins) & Sopir
  // (state.drivers dgn telegramChatId terdaftar) -- chat yg TIDAK dikenal
  // diam-diam diabaikan (sama seperti pola alur "tiba" yg juga diam kalau
  // chatId bukan sopir terdaftar), supaya data saldo/BBM/dokumen armada
  // tidak bocor ke sembarang orang yang kebetulan tahu username bot ini.
  // ============================================================================
  function isSaldoAllowedUser(cid) {
    if (ADMIN_CHAT_IDS.includes(cid)) return true;
    if ((state.notifAdmins || []).some(a => (a.chatId || '').toString().trim() === cid)) return true;
    if (state.drivers.some(d => (d.telegramChatId || '').toString().trim() === cid)) return true;
    return false;
  }
  // v3.172.0 -- Fitur "cek"/"cek mobil"/"mobil"/"sopir": ringkasan trip yang
  // SEDANG BERJALAN (posisi GPS.id, sopir, tujuan, biaya tersimpan sementara,
  // saldo E-Toll, KM ditempuh, level BBM terakhir). BEDA dari "saldo" (dibuka
  // utk admin & sopir) -- ini KHUSUS Admin Penerima Notifikasi Telegram saja
  // (ADMIN_CHAT_IDS / state.notifAdmins), krn isinya posisi live tiap mobil
  // & biaya berjalan tiap sopir, bukan konsumsi masing-masing sopir.
  function isAdminNotifUser(cid) {
    if (ADMIN_CHAT_IDS.includes(cid)) return true;
    if ((state.notifAdmins || []).some(a => (a.chatId || '').toString().trim() === cid)) return true;
    return false;
  }
  // v3.??? -- Gabungan Admin Penerima Notifikasi Telegram ATAU Administrator --
  // dipakai fitur BARU "lokasi" & "service". Administrator dianggap "di atas"
  // Admin Notifikasi biasa, jadi OTOMATIS ikut dapat akses menu ini tanpa
  // perlu didaftarkan lagi terpisah sbg notifAdmin.
  function isAdminOrSuperAdmin(cid) {
    return isAdminNotifUser(cid) || isSuperAdminChat(cid);
  }
  // BARU -- Admin Finance (state.financeAdmins) boleh pakai 2 fitur baca-saja
  // lewat bot: cek saldo E-Toll ("etoll") & detail Servis/Maintenance
  // ("service"). SENGAJA hanya cek terdaftar di financeAdmins (v3.181.0 --
  // sekarang JUGA berlaku sama utk semua notifikasi PUSH ke Finance, tidak
  // ada lagi syarat tambahan harus JUGA jadi Sopir/Admin). Finance boleh
  // AKTIF bertanya sendiri ke bot, tapi HANYA utk 2 fitur ini -- tidak
  // otomatis dapat akses fitur admin lain (lokasi, kecepatan, booking, dst).
  function isFinanceAdminChat(cid) {
    return (state.financeAdmins || []).some(fa => (fa.chatId || '').toString().trim() === cid);
  }
  // v3.268.0 -- BARU: dipakai command "log" (Log Interaksi Bot) -- BEDA dari
  // gerbang command lain di file ini yang hardcode isSuperAdminChat/togel
  // Fitur Tersembunyi, akses command ini sekarang lewat panel "🔔 Notifikasi
  // Telegram per Peran" (state.notifRolePrefs, kategori BARU 'botLog') --
  // supaya Administrator BISA membuka aksesnya ke peran lain (Operator/
  // Finance/Sopir) langsung dari situ, tanpa perlu ubah kode/deploy ulang.
  //
  // Default HANYA Administrator (superadmin:true, sisanya false) -- SAMA
  // semangatnya dgn NOTIF_ROLE_PREFS_DEFAULT (index.html/runNotifyCheck()),
  // TAPI SENGAJA TIDAK porting SELURUH tabel default ke sini (function itu
  // isinya 9+ kategori ALERT push, sedangkan ini cuma 1 flag akses command
  // pull) -- cukup 1 default inline per peran, hindari duplikasi yang tidak
  // perlu. Kalau default 'botLog' di index.html (NOTIF_ROLE_PREFS_DEFAULT)
  // diubah, WAJIB diubah juga persis di `defaultPerPeran` di bawah.
  function peranUntukRolePrefs(cid) {
    if (isSuperAdminChat(cid)) return 'superadmin';
    if (isFinanceAdminChat(cid)) return 'finance';
    if (isAdminNotifUser(cid)) return 'admin';
    if (state.drivers.some(d => (d.telegramChatId || '').toString().trim() === cid)) return 'sopir';
    return null; // chat tidak terdaftar di peran manapun
  }
  function botLogAccessAktif(cid) {
    const peran = peranUntukRolePrefs(cid);
    if (!peran) return false;
    const defaultPerPeran = { sopir: false, finance: false, admin: false, superadmin: true };
    const saved = state.notifRolePrefs && state.notifRolePrefs[peran] && state.notifRolePrefs[peran].botLog;
    return saved != null ? !!saved : defaultPerPeran[peran];
  }
  function today() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }); // format YYYY-MM-DD
  }
  function daysBetween(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const t = new Date(today() + 'T00:00:00');
    return Math.round((d - t) / 86400000);
  }
  function fmtDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d)) return dateStr;
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function subjectLabel(d) {
    return d.subjek === 'sopir' ? driverLabel(d.driverId) : carLabel(d.carId);
  }
  function monthsBetween(dateStr, todayStr) {
    const d1 = new Date(dateStr + 'T00:00:00');
    const d2 = new Date(todayStr + 'T00:00:00');
    return (d2 - d1) / (1000 * 60 * 60 * 24 * 30.44);
  }
  const RATA2_KM_HARIAN_JENDELA_HARI = 90;
  function computeAvgKmPerDay(carId) {
    const batasBawah = new Date();
    batasBawah.setDate(batasBawah.getDate() - RATA2_KM_HARIAN_JENDELA_HARI);
    const batasBawahStr = batasBawah.toISOString().slice(0, 10);
    const trips = state.usage.filter(u => u.carId === carId && (u.tglKeluar || '') >= batasBawahStr);
    const totalKm = trips.reduce((sum, u) => {
      if (u.odoKeluar != null && u.odoKembali != null && u.odoKembali >= u.odoKeluar) return sum + (u.odoKembali - u.odoKeluar);
      return sum;
    }, 0);
    if (totalKm <= 0) return null;
    return totalKm / RATA2_KM_HARIAN_JENDELA_HARI;
  }
  // v3.165.0 -- serviceWarnPct/bbmMinDefault/etollMinDefault: SENGAJA cuma
  // ambil 3 nilai yg dibutuhkan di sini dari state.notifSettings (bukan
  // porting penuh getNotifSettings()+NOTIF_SETTINGS_DEFAULT dari
  // runNotifyCheck), krn cuma 3 ini yg dipakai fitur "saldo".
  function serviceWarnPctValue() { return (state.notifSettings && state.notifSettings.serviceWarnPct != null) ? Number(state.notifSettings.serviceWarnPct) : 80; }
  function bbmMinDefaultValue() { return (state.notifSettings && state.notifSettings.bbmMinDefault != null) ? Number(state.notifSettings.bbmMinDefault) : 20; }
  function etollMinDefaultValue() { return (state.notifSettings && state.notifSettings.etollMinDefault != null) ? Number(state.notifSettings.etollMinDefault) : 25000; }
  // v4.0 -- REFACTOR: dipecah jadi pengingat generik per-kategori, dipakai
  // utk Ganti Oli & Servis Berkala secara independen (masing2 interval &
  // acuan catatan terakhirnya sendiri). Konsisten dgn refactor yang sama
  // di index.html.
  function computeMaintenanceReminder(car, opts) {
    const { kategori, intervalKm, intervalBulan, labelBelumAda, labelSudahWaktunya, labelSegera, labelMasihJauh } = opts;
    if (!intervalKm && !intervalBulan) return null;
    const lastRecord = state.services.filter(s => s.carId === car.id && serviceItems(s).some(it => (it.kategori || '').trim() === kategori)).sort((a, b) => b.tanggal.localeCompare(a.tanggal))[0];
    if (!lastRecord) return { level: 'warn', text: labelBelumAda };
    let pctKm = null, pctBulan = null;
    if (intervalKm && lastRecord.odometer != null && car.odometerSaatIni != null) {
      pctKm = (car.odometerSaatIni - lastRecord.odometer) / intervalKm;
    }
    if (intervalBulan) pctBulan = monthsBetween(lastRecord.tanggal, today()) / intervalBulan;
    if (pctKm === null && pctBulan === null) return { level: 'warn', text: 'Data odometer belum cukup untuk hitung pengingat' };
    const pct = Math.max(pctKm || 0, pctBulan || 0);
    let perkiraanTanggal = null;
    if (intervalBulan && lastRecord.tanggal) {
      const d = new Date(lastRecord.tanggal);
      d.setMonth(d.getMonth() + intervalBulan);
      perkiraanTanggal = d;
    }
    if (intervalKm && lastRecord.odometer != null && car.odometerSaatIni != null) {
      const avgKmPerDay = computeAvgKmPerDay(car.id);
      if (avgKmPerDay && avgKmPerDay > 0) {
        const dKm = new Date(lastRecord.tanggal);
        dKm.setDate(dKm.getDate() + Math.round(intervalKm / avgKmPerDay));
        if (!perkiraanTanggal || dKm < perkiraanTanggal) perkiraanTanggal = dKm;
      }
    }
    const perkiraanText = perkiraanTanggal ? ` (perkiraan ${perkiraanTanggal.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })})` : '';
    if (pct >= 1) return { level: 'danger', text: labelSudahWaktunya };
    if (pct >= (serviceWarnPctValue() / 100)) return { level: 'warn', text: labelSegera + perkiraanText };
    return { level: 'ok', text: labelMasihJauh + perkiraanText };
  }
  function oilReminderInfo(car) {
    return computeMaintenanceReminder(car, {
      kategori: 'Ganti Oli', intervalKm: car.intervalKm, intervalBulan: car.intervalBulan,
      labelBelumAda: 'Belum ada riwayat Ganti Oli tercatat',
      labelSudahWaktunya: 'Sudah waktunya ganti oli',
      labelSegera: 'Segera ganti oli (mendekati jadwal)',
      labelMasihJauh: 'Ganti oli masih jauh'
    });
  }
  // Nama lama dipertahankan sbg alias -- serviceReminderInfo() SELALU berarti Ganti Oli.
  function serviceReminderInfo(car) { return oilReminderInfo(car); }
  function servisBerkalaReminderInfo(car) {
    return computeMaintenanceReminder(car, {
      kategori: 'Servis Berkala / Tune Up', intervalKm: car.intervalKmServis, intervalBulan: car.intervalBulanServis,
      labelBelumAda: 'Belum ada riwayat Servis Berkala tercatat',
      labelSudahWaktunya: 'Sudah waktunya servis berkala',
      labelSegera: 'Segera servis berkala (mendekati jadwal)',
      labelMasihJauh: 'Servis berkala masih jauh'
    });
  }
  function getBensinKeluar(u) { if (u.bensinKeluar != null) return Number(u.bensinKeluar); if (u.sisaBensin != null) return Number(u.sisaBensin); return null; }
  function getBensinKembali(u) { return u.bensinKembali != null ? Number(u.bensinKembali) : null; }
  function getBensinTerkini(u) { const k = getBensinKembali(u); return k != null ? k : getBensinKeluar(u); }
  function fuelBatasFor(car) { return car.batasMinimumBensin != null ? Number(car.batasMinimumBensin) : bbmMinDefaultValue(); }
  function fuelLatestReading(carId) {
    return state.usage.filter(u => u.carId === carId && getBensinTerkini(u) != null).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  }
  function formatBensinDisplay(percentValue, car) {
    if (percentValue == null || isNaN(percentValue)) return '-';
    if (car && car.tipeIndikatorBbm === 'bar') {
      const maxBar = car.maxBarBbm || 8;
      return `${Math.round((Number(percentValue) / 100) * maxBar)} Bar`;
    }
    return `${percentValue}%`;
  }
  function serviceItems(s) {
    if (Array.isArray(s.items)) return s.items;
    if (s.jenis) return [{ id: 'legacy-' + s.id, kategori: s.jenis, biaya: Number(s.biaya) || 0, catatan: s.catatan || '' }];
    return [];
  }
  function computeMonthlyBbmCostForCar(carId, yearMonth) {
    return state.usage.filter(u => u.carId === carId && (u.tglKeluar || '').startsWith(yearMonth))
      .reduce((sum, u) => sum + (Number(u.biayaBensin) || 0), 0);
  }
  // PORTING PERSIS dari computeMonthlyCostForCar() di runNotifyCheck (jangan
  // diubah rumusnya sendirian di 1 tempat saja) -- dipakai kategori Budget
  // Bulanan, supaya angkanya konsisten dgn Laporan Bulanan di aplikasi.
  function computeMonthlyCostForCar(carId, yearMonth) {
    const trips = state.usage.filter(u => u.carId === carId && (u.tglKeluar || '').startsWith(yearMonth));
    const biayaBbm = trips.reduce((sum, u) => sum + (Number(u.biayaBensin) || 0), 0);
    const biayaTol = trips.reduce((sum, u) => { const info = getBiayaTolTerpakai(u); return sum + (info ? info.biayaTol : 0); }, 0);
    const biayaOperasional = trips.reduce((sum, u) => {
      if (u.jenisPenggunaan === 'pribadi') return sum;
      return sum + usageBiayaOpItems(u).filter(it => it.kategori !== 'Isi BBM' && it.kategori !== 'Isi E-Toll').reduce((s, it) => s + (Number(it.nominal) || 0), 0);
    }, 0);
    const biayaServis = state.services.filter(s => s.carId === carId && (s.tanggal || '').startsWith(yearMonth))
      .reduce((sum, s) => sum + serviceItems(s).reduce((s2, it) => s2 + (Number(it.biaya) || 0), 0), 0);
    return biayaBbm + biayaTol + biayaOperasional + biayaServis;
  }

  // Pintasan ketik-langsung -> kode kategori. "saldo" sendiri ditangani
  // terpisah (bukan lewat map ini) krn tujuannya beda (buka MENU, bukan
  // langsung ke daftar 1 kategori).
  const SALDO_KEYWORD_TO_CATEGORY = {
    etoll: 'et',
    bbm: 'tk', tangki: 'tk', // v3.165.0 -- "BBM Mobil" digabung jadi 1 dgn "Sisa BBM Tangki" (sama persis, sesuai konfirmasi user)
    odo: 'od',
    efisiensi: 'ef', 'konsumsi bbm': 'ef',
    'biaya bbm': 'bb',
    dokumen: 'dk',
    servis: 'sv',
    budget: 'bg',
  };
  // BARU -- alias tambahan pintasan Saldo, diisi Administrator lewat menu
  // "🔔 Notifikasi Telegram per Peran" -> "✏️ Alias" (kategori 'saldo:<kode>',
  // mis. 'saldo:et'), TANPA perlu ubah kode. Kata bawaan di atas tetap ada.
  for (const kode of ['et', 'tk', 'od', 'ef', 'bb', 'dk', 'sv', 'bg']) {
    const custom = Array.isArray(state.commandAliases['saldo:' + kode]) ? state.commandAliases['saldo:' + kode] : [];
    for (const kata of custom) {
      const k = String(kata || '').trim().toLowerCase();
      if (k) SALDO_KEYWORD_TO_CATEGORY[k] = kode;
    }
  }
  const SALDO_CATEGORY_TITLE = {
    et: '💳 E-Toll', tk: '⛽ Sisa BBM (Tangki)', od: '🛣️ Odometer', ef: '📊 Efisiensi BBM',
    bb: '💵 Biaya BBM Bulan Ini', dk: '📄 Masa Berlaku Dokumen', sv: '🔧 Servis Berikutnya', bg: '💰 Budget Bulanan',
  };
  function saldoMainMenuKeyboard() {
    return [
      [{ text: '💳 E-Toll', callback_data: 'sd:c:et' }, { text: '⛽ Sisa BBM (Tangki)', callback_data: 'sd:c:tk' }],
      [{ text: '🛣️ Odometer', callback_data: 'sd:c:od' }, { text: '📊 Efisiensi BBM', callback_data: 'sd:c:ef' }],
      [{ text: '💵 Biaya BBM Bulan Ini', callback_data: 'sd:c:bb' }, { text: '📄 Masa Berlaku Dokumen', callback_data: 'sd:c:dk' }],
      [{ text: '🔧 Servis Berikutnya', callback_data: 'sd:c:sv' }, { text: '💰 Budget Bulanan', callback_data: 'sd:c:bg' }],
      [{ text: '🏠 Menu Utama', callback_data: 'cmd:menu' }],
    ];
  }
  function saldoBackToMenuRow() { return [{ text: '🏠 Menu Saldo', callback_data: 'sd:m' }]; }
  function saldoListForCategory(cat) {
    const judul = SALDO_CATEGORY_TITLE[cat];
    if (!judul) return null;
    if (cat === 'et') {
      if (!state.etollCards.length) return { text: '💳 Belum ada kartu E-Toll yang tercatat di aplikasi.', keyboard: [saldoBackToMenuRow()] };
      const rows = state.etollCards.map(c => [{ text: `💳 ${c.nomorKartu}${c.mobilId ? ' — ' + carLabel(c.mobilId) : ''}`.slice(0, 64), callback_data: `sd:i:et:${c.id}` }]);
      rows.push(saldoBackToMenuRow());
      return { text: `${judul}\nPilih kartu:`, keyboard: rows };
    }
    if (cat === 'tk' || cat === 'od' || cat === 'ef' || cat === 'bb' || cat === 'sv') {
      if (!state.cars.length) return { text: '🚗 Belum ada mobil yang tercatat di aplikasi.', keyboard: [saldoBackToMenuRow()] };
      const rows = state.cars.map(c => [{ text: `🚗 ${carLabel(c.id)}`.slice(0, 64), callback_data: `sd:i:${cat}:${c.id}` }]);
      rows.push(saldoBackToMenuRow());
      return { text: `${judul}\nPilih mobil:`, keyboard: rows };
    }
    if (cat === 'bg') {
      const items = state.cars.filter(c => Number(c.budgetBulanan) > 0);
      if (!items.length) return { text: '💰 Belum ada mobil dengan Budget Bulanan diatur (isi dulu di menu Data Mobil pada aplikasi).', keyboard: [saldoBackToMenuRow()] };
      const rows = items.map(c => [{ text: `🚗 ${carLabel(c.id)}`.slice(0, 64), callback_data: `sd:i:bg:${c.id}` }]);
      rows.push(saldoBackToMenuRow());
      return { text: `${judul}\nPilih mobil:`, keyboard: rows };
    }
    if (cat === 'dk') {
      const semua = state.documents.slice().sort((a, b) => (a.tglExpired || '').localeCompare(b.tglExpired || ''));
      const items = semua.slice(0, 30);
      if (!items.length) return { text: '📄 Belum ada dokumen yang tercatat di aplikasi.', keyboard: [saldoBackToMenuRow()] };
      const rows = items.map(d => {
        const sisa = d.tglExpired ? daysBetween(d.tglExpired) : null;
        const ic = sisa == null ? '📄' : (sisa < 0 ? '⛔' : (sisa <= 30 ? '⚠️' : '📄'));
        return [{ text: `${ic} ${d.jenis} — ${subjectLabel(d)}`.slice(0, 64), callback_data: `sd:i:dk:${d.id}` }];
      });
      rows.push(saldoBackToMenuRow());
      const catatan = semua.length > 30 ? '\n<i>(30 teratas, diurutkan dari masa berlaku paling dekat habis)</i>' : '';
      return { text: `${judul}${catatan}\nPilih dokumen:`, keyboard: rows };
    }
    return null;
  }
  async function saldoDetailForItem(cat, id) {
    const bulanIniStr = today().slice(0, 7);
    const bulanLabel = new Date(bulanIniStr + '-01T00:00:00').toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
    if (cat === 'et') {
      const c = state.etollCards.find(x => x.id === id);
      if (!c) return '⚠️ Kartu E-Toll ini sudah tidak ada di data (mungkin sudah dihapus dari aplikasi).';
      const batas = c.batasMinimum != null ? Number(c.batasMinimum) : etollMinDefaultValue();
      const saldo = Number(c.saldo) || 0;
      const lines = [`💳 <b>${escapeHtmlTg(c.nomorKartu)}</b>`, '', `Saldo saat ini: <b>${fmtMoney(saldo)}</b>`, `Batas minimum: ${fmtMoney(batas)}${saldo < batas ? ' ⚠️ <i>(di bawah batas)</i>' : ''}`];
      if (c.mobilId) lines.push(`Terhubung ke: ${escapeHtmlTg(carLabel(c.mobilId))}`);
      if (c.catatan) lines.push(`Catatan: ${escapeHtmlTg(c.catatan)}`);
      return lines.join('\n');
    }
    const car = state.cars.find(x => x.id === id);
    if (!car) return '⚠️ Mobil ini sudah tidak ada di data (mungkin sudah dihapus dari aplikasi).';
    if (cat === 'tk') {
      const latest = fuelLatestReading(car.id);
      const sisaTerkini = latest ? getBensinTerkini(latest) : null;
      const lines = [`⛽ <b>${escapeHtmlTg(carLabel(car.id))}</b>`, ''];
      if (sisaTerkini == null) {
        lines.push('Belum ada data level BBM tercatat untuk mobil ini.');
      } else {
        const batas = fuelBatasFor(car);
        lines.push(`Sisa BBM: <b>${formatBensinDisplay(sisaTerkini, car)}</b>${sisaTerkini < batas ? ' ⚠️ <i>(di bawah batas minimum)</i>' : ''}`);
        lines.push(`Batas minimum: ${formatBensinDisplay(batas, car)}`);
        const tglUpdate = latest.tglKembali || latest.tglKeluar;
        if (tglUpdate) lines.push(`Data dari trip: ${fmtDate(tglUpdate)}`);
      }
      return lines.join('\n');
    }
    if (cat === 'od') {
      const lines = [`🛣️ <b>${escapeHtmlTg(carLabel(car.id))}</b>`, '', `Odometer (aplikasi): <b>${car.odometerSaatIni != null ? car.odometerSaatIni.toLocaleString('id-ID') + ' KM' : '-'}</b>`];
      if (car.imeiGps) {
        const gpsKm = await getGpsIdMileageForImei(env, car.imeiGps);
        lines.push(`Odometer GPS.id (live): ${gpsKm != null ? gpsKm.toLocaleString('id-ID') + ' KM' : 'tidak tersedia saat ini'}`);
        // v3.208.3 -- BARU: tampilkan selisihnya langsung, sebelumnya pengguna
        // harus hitung manual dari 2 angka di atas. Ambang batas "wajar vs
        // perlu perhatian" SENGAJA disamakan dgn badge "🛰️ GPS: ±X KM" di
        // halaman Data Mobil (computeGpsOdoDiffInfo() di index.html) --
        // 2% dari odometer aplikasi, minimal 200 KM -- supaya bot & web tidak
        // beda pendapat soal kapan selisih dianggap "jauh". Kalau threshold
        // di index.html diubah, samakan juga di sini.
        if (car.odometerSaatIni != null && gpsKm != null) {
          const selisih = gpsKm - car.odometerSaatIni;
          const threshold = Math.max(200, car.odometerSaatIni * 0.02);
          const arah = selisih === 0 ? 'sama persis' : (selisih > 0 ? 'GPS.id lebih besar' : 'GPS.id lebih kecil');
          const peringatan = Math.abs(selisih) > threshold ? ' ⚠️ <i>(cukup jauh, pertimbangkan kalibrasi ulang)</i>' : '';
          lines.push(`Selisih: <b>${Math.abs(selisih).toLocaleString('id-ID')} KM</b> (${arah})${peringatan}`);
        }
        lines.push('<i>Odometer GPS.id dihitung dari akumulasi sinyal GPS, bisa meleset kalau lama tidak dikalibrasi ulang.</i>');
      }
      return lines.join('\n');
    }
    if (cat === 'ef') {
      const ratio = simpleCarAvgRatio(state, car);
      const lines = [`📊 <b>${escapeHtmlTg(carLabel(car.id))}</b>`, ''];
      if (ratio == null) {
        lines.push('Data belum cukup untuk menghitung Efisiensi BBM (butuh riwayat trip dengan odometer & indikator BBM keluar/kembali lengkap).');
      } else {
        lines.push(`Efisiensi rata-rata: <b>${ratio.toFixed(1)} KM/L</b>`);
        if (car.efisiensiMinKmL != null || car.efisiensiMaxKmL != null) lines.push(`Rentang wajar: ${car.efisiensiMinKmL ?? '-'}–${car.efisiensiMaxKmL ?? '-'} KM/L`);
        lines.push('<i>Angka ini rata-rata sederhana dari riwayat trip, bisa sedikit beda dari badge Efisiensi di aplikasi (yang punya kalkulasi lebih detail).</i>');
      }
      return lines.join('\n');
    }
    if (cat === 'bb') {
      const total = computeMonthlyBbmCostForCar(car.id, bulanIniStr);
      return [`💵 <b>${escapeHtmlTg(carLabel(car.id))}</b>`, '', `Biaya BBM ${bulanLabel}: <b>${fmtMoney(total)}</b>`].join('\n');
    }
    if (cat === 'sv') {
      const lines = [`🔧 <b>${escapeHtmlTg(carLabel(car.id))}</b>`, ''];
      const info = serviceReminderInfo(car);
      if (!info) {
        lines.push('Interval servis (KM/Bulan) belum diatur untuk mobil ini.');
      } else {
        const ic = info.level === 'danger' ? '⛔' : (info.level === 'warn' ? '⚠️' : '✅');
        lines.push(`${ic} ${escapeHtmlTg(info.text)}`);
      }
      const lastService = state.services.filter(s => s.carId === car.id).sort((a, b) => b.tanggal.localeCompare(a.tanggal))[0];
      if (lastService) lines.push(`\nServis terakhir: ${fmtDate(lastService.tanggal)}${lastService.odometer != null ? ' — ' + lastService.odometer.toLocaleString('id-ID') + ' KM' : ''}`);
      return lines.join('\n');
    }
    if (cat === 'bg') {
      const budget = Number(car.budgetBulanan) || 0;
      const totalBiaya = computeMonthlyCostForCar(car.id, bulanIniStr);
      const pct = budget > 0 ? Math.round((totalBiaya / budget) * 100) : 0;
      const ic = pct >= 100 ? '⛔' : (pct >= 80 ? '⚠️' : '✅');
      return [`💰 <b>${escapeHtmlTg(carLabel(car.id))}</b>`, '', `Terpakai ${bulanLabel}: <b>${fmtMoney(totalBiaya)}</b>`, `Budget bulanan: ${fmtMoney(budget)}`, `${ic} ${pct}% dari budget${pct >= 100 ? ' — sudah terlampaui' : ''}`].join('\n');
    }
    return '⚠️ Kategori tidak dikenali.';
  }

  // ============================================================================
  // v3.172.0 -- Fitur "cek"/"cek mobil"/"mobil"/"sopir": ringkasan trip yang
  // SEDANG BERJALAN, KHUSUS Admin Penerima Notifikasi Telegram (lihat
  // isAdminNotifUser() di atas). Pola navigasi STATELESS sama persis dengan
  // "saldo" (prefix callback_data "ck:") -- "ck:m" = daftar mobil yang lagi
  // jalan, "ck:t:<tripId>" = detail 1 trip. Kalau cuma ada 1 trip aktif,
  // langsung tampilkan detailnya tanpa lewat daftar dulu.
  // ============================================================================
  const CEK_MOBIL_KEYWORDS = withAliases(['cek', 'cek mobil', 'mobil', 'sopir'], 'cek');
  function cekMobilBackRow() { return [{ text: '🔙 Daftar Mobil Jalan', callback_data: 'ck:m' }]; }
  function cekMobilPickerRows(trips) {
    return trips.map(u => [{ text: `${carLabel(u.carId)} — ${driverLabel(u.driverId, u.driver)}`, callback_data: `ck:t:${u.id}` }]);
  }
  async function cekMobilDetailText(u, env) {
    const car = state.cars.find(c => c.id === u.carId);
    const lines = [
      `🚗 <b>${escapeHtmlTg(carLabel(u.carId))}</b>`,
      `Nomor Perjalanan: <b>${escapeHtmlTg(u.kode || u.id)}</b>`,
      `Sopir: ${escapeHtmlTg(driverLabel(u.driverId, u.driver))}`,
      `Tujuan: ${escapeHtmlTg(u.tujuan || '-')}`,
      '',
    ];

    // ---- Posisi GPS.id (live) ----
    let posisiText = 'IMEI GPS.id belum dihubungkan ke mobil ini (isi di menu Data Mobil).';
    let gpsMileageKm = null;
    if (car && car.imeiGps) {
      try {
        const gpsResult = await fetchGpsIdVehicleData(env);
        const v = gpsResult.list && gpsResult.list.find(x => String(x.imei ?? x.IMEI ?? '') === String(car.imeiGps));
        if (v) {
          const lat = v.latitude ?? v.lat ?? null;
          const lon = v.longitude ?? v.lon ?? null;
          const kecepatan = v.speed ?? v.kecepatan ?? null;
          const waktu = v.last_update ?? v.gps_date ?? v.updated_at ?? v.waktu ?? v.gps_time ?? null;
          if (v.mileage != null) {
            const m = Number(v.mileage);
            if (!isNaN(m)) gpsMileageKm = Math.round(m / 1000);
          }
          const parts = [];
          if (lat != null && lon != null) parts.push(`<a href="https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lon)}">📍 Lihat posisi di peta</a>`);
          if (kecepatan != null) parts.push(`Kecepatan: ${escapeHtmlTg(String(kecepatan))} km/j`);
          if (waktu) parts.push(`Update terakhir: ${escapeHtmlTg(String(waktu))}`);
          posisiText = parts.length ? parts.join('\n') : 'Data posisi GPS.id belum tersedia untuk mobil ini.';
          if (gpsResult.stale) posisiText += '\n<i>(data GPS.id sedang dari cache, GPS.id lagi membatasi permintaan sebentar)</i>';
        } else {
          posisiText = 'Data GPS.id untuk mobil ini belum ditemukan (cek lagi IMEI di Data Mobil).';
        }
      } catch (e) {
        posisiText = `⚠️ Gagal ambil data GPS.id (${escapeHtmlTg(e.message)}).`;
      }
    }
    lines.push(`<b>Posisi (GPS.id):</b>\n${posisiText}`, '');

    // ---- KM ditempuh sejauh ini ----
    const kmTempuh = (gpsMileageKm != null && u.odoKeluar != null) ? (gpsMileageKm - u.odoKeluar)
      : (car && car.odometerSaatIni != null && u.odoKeluar != null) ? (car.odometerSaatIni - u.odoKeluar)
      : null;
    lines.push(`<b>KM Ditempuh:</b> ${(kmTempuh != null && kmTempuh >= 0) ? kmTempuh.toLocaleString('id-ID') + ' KM' : '-'}`);

    // ---- Level BBM terakhir tercatat ----
    const bensinTerkini = getBensinTerkini(u);
    lines.push(`<b>Level BBM Terakhir:</b> ${bensinTerkini != null ? formatBensinDisplay(bensinTerkini, car) : '-'}`);

    // ---- Saldo E-Toll kartu yang dipakai trip ini (saldo real-time kartu) ----
    const cardEtoll = u.etollCardId ? state.etollCards.find(c => c.id === u.etollCardId) : null;
    lines.push(`<b>Saldo E-Toll${cardEtoll ? ' (' + escapeHtmlTg(cardEtoll.nomorKartu) + ')' : ''}:</b> ${cardEtoll ? fmtMoney(cardEtoll.saldo) : '-'}`);

    // ---- Biaya yang sudah tercatat sementara selama trip (belum final, trip
    // masih berjalan -- baru pasti setelah sopir ketik "tiba" & trip ditutup) ----
    const biayaSementara = usageBiayaOpItems(u).reduce((sum, it) => sum + (Number(it.nominal) || 0), 0);
    lines.push(`<b>Biaya Tersimpan Sementara:</b> ${fmtMoney(biayaSementara)}`, '<i>(biaya operasional/BBM/E-Toll yang sudah dicatat sopir lewat "biaya"/"isi" selama trip berjalan, belum final sampai trip ditutup)</i>');

    return lines.join('\n');
  }

  // ============================================================================
  // v3.??? -- Fitur "lokasi": lokasi TERKINI 1 mobil (bukan trip -- jalan
  // untuk SEMUA mobil yang IMEI-nya terhubung, sedang dipakai trip ataupun
  // parkir di pool), KHUSUS Admin Penerima Notifikasi Telegram & Administrator
  // (lihat isAdminOrSuperAdmin() di atas). Isinya: alamat lengkap (reverse
  // geocoding koordinat GPS.id via Nominatim), link Google Maps, dan status
  // sedang jalan/diam-mesin-nyala/parkir (dari kombinasi acc+speed, pola
  // SAMA PERSIS dgn refreshLacakMobilJalanButton() di index.html). Navigasi
  // STATELESS sama seperti "cek" (prefix callback_data "lk:").
  // ============================================================================
  const LOKASI_KEYWORDS = withAliases(['lokasi', 'lokasi mobil', 'posisi', 'posisi mobil', 'lacak', 'lacak mobil'], 'lokasi');
  function lokasiMobilBackRow() { return [{ text: '🔙 Daftar Mobil', callback_data: 'lk:m' }]; }
  function lokasiMobilPickerRows(cars) {
    return cars.map(c => [{ text: carLabel(c.id), callback_data: `lk:c:${c.id}` }]);
  }
  async function lokasiDetailText(car, env) {
    const lines = [`📍 <b>${escapeHtmlTg(carLabel(car.id))}</b>`, ''];
    if (!car.imeiGps) {
      lines.push('IMEI GPS.id belum dihubungkan ke mobil ini (isi di menu Data Mobil).');
      return lines.join('\n');
    }
    try {
      const gpsResult = await fetchGpsIdVehicleData(env);
      const v = gpsResult.list && gpsResult.list.find(x => String(x.imei ?? x.IMEI ?? '') === String(car.imeiGps));
      if (!v) {
        lines.push('Data GPS.id untuk mobil ini belum ditemukan (cek lagi IMEI di Data Mobil).');
        return lines.join('\n');
      }
      const lat = v.latitude ?? v.lat ?? null;
      const lon = v.longitude ?? v.lon ?? null;
      const kecepatan = Number(v.speed ?? v.kecepatan ?? 0) || 0;
      const accRaw = v.acc ?? v.acc_status ?? v.status_mesin ?? null;
      const accOn = accRaw === 1 || accRaw === true || String(accRaw).toUpperCase() === 'ON';
      const waktu = v.last_update ?? v.gps_date ?? v.updated_at ?? v.waktu ?? v.gps_time ?? null;

      // Status: sama persis pola refreshLacakMobilJalanButton() di index.html
      // (acc ON + speed>0 = jalan).
      const statusText = accOn && kecepatan > 0
        ? '🟢 Sedang jalan'
        : accOn
          ? '🟡 Mesin menyala, diam (idle)'
          : '🔴 Parkir / mesin mati';
      lines.push(`<b>Status:</b> ${statusText}`);
      if (kecepatan > 0) lines.push(`<b>Kecepatan:</b> ${kecepatan} km/j`);

      if (lat != null && lon != null) {
        // Reverse geocoding (Nominatim) -- best-effort, tidak pernah gagalkan
        // pesan "lokasi" secara keseluruhan kalau lambat/error (lihat catatan
        // di reverseGeocodeLatLon()).
        const alamat = await reverseGeocodeLatLon(lat, lon);
        lines.push(`<b>Alamat:</b> ${alamat ? escapeHtmlTg(alamat) : `<i>(alamat tidak berhasil diambil, ini koordinatnya: ${lat}, ${lon})</i>`}`);
      } else {
        lines.push('Koordinat GPS.id belum tersedia untuk mobil ini.');
      }
      if (waktu) lines.push(`<b>Update terakhir:</b> ${escapeHtmlTg(String(waktu))}`);
      if (gpsResult.stale) lines.push('<i>(data GPS.id sedang dari cache, GPS.id lagi membatasi permintaan sebentar)</i>');
      if (lat != null && lon != null) {
        lines.push('', `<a href="https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lon)}">📍 Buka lokasi di Google Maps</a>`);
      }
      return lines.join('\n');
    } catch (e) {
      lines.push(`⚠️ Gagal ambil data GPS.id (${escapeHtmlTg(e.message)}).`);
      return lines.join('\n');
    }
  }

  // ============================================================================
  // v3.??? -- Fitur "service"/"servis"/"maintenance": rekomendasi kategori
  // dari menu Servis & Maintenance (SERVICE_CATEGORIES, sama persis
  // index.html), lalu 3 data servis TERBARU (semua mobil) utk kategori yang
  // dipilih. KHUSUS Admin Penerima Notifikasi Telegram & Administrator.
  // Navigasi STATELESS (prefix callback_data "sv:").
  // ============================================================================
  const SERVICE_KEYWORDS = withAliases(['service', 'servis', 'maintenance'], 'service');
  function svcItemsForBot(s) {
    if (Array.isArray(s.items)) return s.items;
    if (s.jenis) return [{ kategori: s.jenis, biaya: Number(s.biaya) || 0, catatan: s.catatan || '' }];
    return [];
  }
  function serviceCategoryKeyboard() {
    const rows = [];
    for (let i = 0; i < SERVICE_CATEGORIES.length; i += 2) {
      rows.push(SERVICE_CATEGORIES.slice(i, i + 2).map(k => ({ text: k, callback_data: `sv:k:${k}` })));
    }
    rows.push([{ text: '🏠 Menu Utama', callback_data: 'cmd:menu' }]);
    return rows;
  }
  function serviceCategoryBackRow() { return [{ text: '🔙 Pilih Kategori Lain', callback_data: 'sv:m' }]; }
  function serviceRecentTextForCategory(kategori) {
    // Kumpulkan tiap ITEM (bukan tiap kunjungan servis) yang kategorinya
    // cocok, dari semua kunjungan servis semua mobil -- 1 kunjungan bisa
    // punya beberapa item kategori berbeda sekaligus (lihat serviceItems()
    // di index.html), jadi harus dipecah dulu sebelum diurutkan/diambil 3.
    const matches = [];
    (state.services || []).forEach(s => {
      svcItemsForBot(s).forEach(it => {
        if ((it.kategori || '').trim() === kategori) matches.push({ s, it });
      });
    });
    if (matches.length === 0) {
      return `🔧 <b>${escapeHtmlTg(kategori)}</b>\n\nBelum ada riwayat servis kategori ini.`;
    }
    matches.sort((a, b) => (b.s.tanggal || '').localeCompare(a.s.tanggal || ''));
    const top3 = matches.slice(0, 3);
    const lines = [`🔧 <b>${top3.length} Servis Terbaru — ${escapeHtmlTg(kategori)}</b>`, ''];
    top3.forEach(({ s, it }, idx) => {
      lines.push(`${idx + 1}. <b>${escapeHtmlTg(carLabel(s.carId))}</b>`);
      lines.push(`   📅 ${escapeHtmlTg(fmtDate(s.tanggal))}${s.bengkel ? ' · ' + escapeHtmlTg(s.bengkel) : ''}`);
      lines.push(`   💰 ${fmtMoney(Number(it.biaya) || 0)}`);
      if (s.odometer != null) lines.push(`   🛣️ Odometer: ${Number(s.odometer).toLocaleString('id-ID')} KM`);
      if (it.catatan) lines.push(`   📝 ${escapeHtmlTg(it.catatan)}`);
      if (s.mapsLink) lines.push(`   <a href="${escapeHtmlTg(s.mapsLink)}">📍 Lokasi bengkel</a>`);
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  // ============================================================================
  // BARU: "oli"/"service"/"servis" KHUSUS SOPIR -- versi jauh lebih ringkas
  // dari menu Admin di atas. SENGAJA TIDAK dipakaikan untuk Admin (mereka
  // sudah dilayani blok serviceKeyword di atas & sudah return duluan) supaya
  // tidak ada 2 respons untuk keyword yang sama.
  //
  // BATASAN AKSES (PENTING, ini yang membedakan dari menu Admin):
  // - Sopir HANYA melihat status Ganti Oli mobil yang PERNAH/SEDANG dia
  //   pakai sendiri (dari riwayat state.usage miliknya), TIDAK BISA lihat
  //   mobil lain atau pilih bebas -- daftar mobilnya dihitung ulang dari
  //   server tiap kali (bukan dari input sopir), dan waktu pilih dari
  //   tombol (svo:c:<carId>) tetap divalidasi ulang carId itu benar ada di
  //   daftar mobilnya sebelum ditampilkan -- supaya tidak bisa "ditembak"
  //   lewat callback_data buatan sendiri untuk intip mobil orang lain.
  // - TIDAK ada rincian biaya/bengkel/kategori lain (Rem, AC, dst) seperti
  //   menu Admin -- itu data operasional/biaya yang bukan urusan sopir.
  //   Cuma badge status (aman/mendekati/sudah waktunya) + odometer acuan,
  //   sama persis dengan yang sopir lihat di card "Perlu Perhatian" versi
  //   web kalau buka aplikasinya.
  // ============================================================================
  const DRIVER_OLI_KEYWORDS = withAliases(['oli', 'ganti oli', 'cek oli', 'oli mobil'], 'oli');
  function carsForDriverBot(driverId) {
    // Mobil trip AKTIF (kalau ada) selalu paling atas, sisanya mobil lain yg
    // pernah dia pakai, diurutkan dari yang paling BARU dipakai.
    const seen = new Map(); // carId -> lastUsedAt (buat urutan)
    state.usage.filter(u => u.driverId === driverId).forEach(u => {
      const key = u.carId;
      const ts = u.status === 'digunakan' ? Infinity : (u.updatedAt || 0);
      if (!seen.has(key) || ts > seen.get(key)) seen.set(key, ts);
    });
    return [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([carId]) => state.cars.find(c => c.id === carId))
      .filter(Boolean);
  }
  function oliStatusTextForCar(car) {
    const infoOli = oilReminderInfo(car);
    const infoServis = servisBerkalaReminderInfo(car);
    const icFor = (info) => !info ? '🔧' : (info.level === 'danger' ? '⛔' : (info.level === 'warn' ? '⚠️' : '✅'));
    const lines = [`🚚 <b>${escapeHtmlTg(carLabel(car.id))}</b>`, ''];
    lines.push(`${icFor(infoOli)} <b>Ganti Oli</b>: ${infoOli ? infoOli.text : 'belum diatur Admin'}`);
    lines.push(`${icFor(infoServis)} <b>Servis Berkala</b>: ${infoServis ? infoServis.text : 'belum diatur Admin'}`);
    if (car.odometerSaatIni != null) { lines.push(''); lines.push(`🛣️ Odometer saat ini: ${Number(car.odometerSaatIni).toLocaleString('id-ID')} KM`); }
    return lines.join('\n');
  }
  function oliCarPickerRows(cars) {
    const rows = [];
    for (let i = 0; i < cars.length; i += 2) {
      rows.push(cars.slice(i, i + 2).map(c => ({ text: carLabel(c.id), callback_data: `svo:c:${c.id}` })));
    }
    return rows;
  }
  function oliBackRow() { return [{ text: '🔙 Pilih Mobil Lain', callback_data: 'svo:m' }]; }


  // ============================================================================
  // BARU -- Fitur "odometer jam sekian": cari odometer HISTORIS 1 mobil pada
  // jam tertentu (BUKAN odometer sekarang), dari titik histori GPS.id yang
  // waktunya PALING DEKAT dgn jam yang diminta. Trigger dari teks BEBAS yang
  // mengandung pola "jam <angka>" / "pukul <angka>[:menit]" -- BUKAN command
  // khusus, mirip semangat LOKASI_KEYWORDS/SERVICE_KEYWORDS tapi pakai regex
  // krn kalimatnya bebas (mis. "jam 10 tadi odonya berapa?").
  //
  // AKSES: Admin Penerima Notifikasi Telegram & Administrator (isAdminOrSuperAdmin)
  // -> boleh tanya mobil MANA SAJA yang punya IMEI GPS.id, kalau tidak sebut
  // nama/plat mobil dalam kalimat -> ditanya balik lewat daftar tombol
  // (persis pola fitur "lokasi"). Sopir dengan trip AKTIF -> otomatis
  // dijawab utk mobil trip aktifnya sendiri saja (tidak bisa tanya mobil
  // lain), tidak perlu pilih mobil.
  //
  // Jendela pencarian histori: ±30 menit dari jam yg diminta dulu; kalau
  // kosong, dilebarkan SEKALI ke ±2 jam sbg fallback sebelum dianggap
  // "tidak ada data". Jadi 1 pertanyaan = maksimal 2x panggil report/history
  // -- konsisten dgn pola hemat kuota GPS.id yang sudah ada di file ini
  // (computeTripAvgSpeedKmh dkk).
  // ============================================================================
  const JAM_QUERY_REGEX = /\b(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{2}))?\b/i;

  function parseJamQuery(rawText) {
    const m = rawText.match(JAM_QUERY_REGEX);
    if (!m) return null;
    const jam = Number(m[1]);
    const menit = m[2] != null ? Number(m[2]) : 0;
    if (!isFinite(jam) || jam < 0 || jam > 23 || menit < 0 || menit > 59) return null;
    return { jam, menit };
  }

  // v3.265.0 -- BARU: parser tanggal bebas berbahasa Indonesia, dipakai di
  // SEMUA tempat yg tadinya CUMA terima format kaku YYYY-MM-DD, supaya
  // sopir/admin bisa ketik lebih natural lewat chat:
  //   "2026-03-01"            (format lama, TETAP didukung, prioritas #1)
  //   "1-3-2026" / "1/3/2026" / "01-03-2026"   (tanggal-bulan-tahun angka)
  //   "1 maret 2026" / "1 Mar 2026"            (nama bulan Indonesia)
  //   "1 meret 2026"                           (typo ringan TETAP dikenali
  //                                              via jarak-edit ke nama bulan)
  // Tahun 2-digit ("26") dianggap 20xx. CATATAN: ini CUMA dipakai bot
  // Telegram (worker.js) -- di index.html input tanggal pakai
  // <input type="date"> bawaan browser, jadi TIDAK butuh kembaran parser
  // ini di sana (bukan kasus duplikasi-sengaja spt di SOP bagian 2).
  const NAMA_BULAN_INDO = [
    ['januari', 1], ['jan', 1],
    ['februari', 2], ['feb', 2],
    ['maret', 3], ['mar', 3],
    ['april', 4], ['apr', 4],
    ['mei', 5],
    ['juni', 6], ['jun', 6],
    ['juli', 7], ['jul', 7],
    ['agustus', 8], ['agu', 8], ['ags', 8], ['agt', 8],
    ['september', 9], ['sep', 9], ['sept', 9],
    ['oktober', 10], ['okt', 10],
    ['november', 11], ['nov', 11],
    ['desember', 12], ['des', 12], ['dec', 12],
  ];
  // v3.265.0 -- jarakEditSederhana() yang dulu di sini DIHAPUS -- ternyata
  // duplikat PERSIS dari levenshteinDistance() yang sudah ada jauh di atas
  // (dipakai bestFuzzyCommandMatch()/cariSaranTujuan()), keduanya nested di
  // scope processTelegramUpdate() yang SAMA jadi bisa langsung dipanggil
  // ulang tanpa perlu di-passing lewat parameter apa pun. Ketahuan saat
  // menambah fitur belajar alias otomatis (v3.265.0) & dirapikan sekalian --
  // lihat SOP bagian "jangan duplikasi logika".
  function cariBulanDariKata(kata) {
    const k = kata.toLowerCase().trim();
    // 1) cocok persis dulu (nama penuh/singkatan resmi) -- paling cepat & pasti benar
    const persis = NAMA_BULAN_INDO.find(([nama]) => nama === k);
    if (persis) return persis[1];
    // 2) fallback typo-toleran (jarak-edit <=2) -- ini yg bikin "meret"->Maret kena
    let terbaik = null, jarakTerbaik = Infinity;
    for (const [nama, bulan] of NAMA_BULAN_INDO) {
      if (Math.abs(nama.length - k.length) > 2) continue; // beda panjang jauh -> skip cepat
      const jarak = levenshteinDistance(nama, k);
      if (jarak < jarakTerbaik) { jarakTerbaik = jarak; terbaik = bulan; }
    }
    return (terbaik && jarakTerbaik <= 2) ? terbaik : null;
  }
  function validasiTanggal(y, mo, d) {
    if (!(y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    // Pastikan tanggal beneran valid (bkn "31 Februari") lewat cek round-trip.
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function parseTanggalBebas(teksMentah) {
    const t = (teksMentah || '').trim().toLowerCase();
    if (!t) return null;
    let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { const [, y, mo, d] = m; return validasiTanggal(Number(y), Number(mo), Number(d)); }
    m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (m) {
      const [, d, mo, yRaw] = m;
      const y = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
      return validasiTanggal(y, Number(mo), Number(d));
    }
    m = t.match(/^(\d{1,2})\s+([a-z]+)\.?\s+(\d{2,4})$/);
    if (m) {
      const [, d, namaBulan, yRaw] = m;
      const bulan = cariBulanDariKata(namaBulan);
      if (!bulan) return null;
      const y = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
      return validasiTanggal(y, bulan, Number(d));
    }
    return null;
  }
  // Sama seperti parseTanggalBebas(), tapi utk input gabungan "tanggal jam"
  // dlm 1 pesan (dipakai fitur booking "Kapan mulai?"), mis. "2 Agustus
  // 2026 08:00" atau "2/8/2026 08:00". Return {tanggal,jam} atau null.
  function parseTanggalJamBebas(teksMentah) {
    const t = (teksMentah || '').trim();
    const m = t.match(/^(.+?)\s+(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const [, tglBagian, jj, mm] = m;
    const tanggal = parseTanggalBebas(tglBagian);
    if (!tanggal) return null;
    const jam = Number(jj), menit = Number(mm);
    if (jam > 23 || menit > 59) return null;
    return { tanggal, jam: `${String(jam).padStart(2, '0')}:${String(menit).padStart(2, '0')}` };
  }

  function tanggalKemarin() {
    const d = new Date(today() + 'T12:00:00+07:00'); // tengah hari -- aman dari pergeseran krn WIB tidak ada DST
    d.setDate(d.getDate() - 1);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
  }

  // Tentukan tanggal yg dimaksud: default HARI INI, kecuali (a) kalimat
  // eksplisit sebut "kemarin", atau (b) jam yg diminta ternyata BELUM lewat
  // hari ini (mis. sekarang jam 09:00 tapi ditanya "jam 10 tadi") -> otomatis
  // mundur ke KEMARIN, supaya tidak nyasar minta data histori di masa depan.
  function resolveTanggalJamQuery(rawText, jam, menit) {
    const sebutKemarin = /\bkemarin\b/i.test(rawText);
    const todayStr = today();
    const jamStr = `${String(jam).padStart(2, '0')}:${String(menit).padStart(2, '0')}`;
    const targetTodayMs = new Date(`${todayStr}T${jamStr}:00+07:00`).getTime();
    let tanggal = todayStr, assumedYesterday = false;
    if (sebutKemarin || targetTodayMs > Date.now()) {
      tanggal = tanggalKemarin();
      assumedYesterday = true;
    }
    return { tanggal, jamStr, assumedYesterday };
  }

  // Cari 1 mobil dari teks bebas berdasarkan plat/merk/model -- dipakai
  // supaya Admin/Administrator BISA langsung sebut mobilnya di kalimat yang
  // sama ("jam 10 tadi odo mobil B 1234 XY berapa?"), tidak wajib selalu
  // ditanya balik. Best-effort sederhana (substring, bukan fuzzy) -- kalau
  // tidak ketemu/ambigu, pemanggil tetap jatuh ke daftar tombol pilih mobil.
  function cariMobilDariTeks(rawTextLower, cars) {
    const cocok = cars.filter(c => {
      const plat = (c.plat || '').toLowerCase().replace(/\s+/g, '');
      const platSpasi = (c.plat || '').toLowerCase();
      const teksRapat = rawTextLower.replace(/\s+/g, '');
      return (plat && teksRapat.includes(plat)) || (platSpasi && rawTextLower.includes(platSpasi));
    });
    return cocok.length === 1 ? cocok[0] : null;
  }

  function odoJamBackRow(jamCompact, tanggalCompact) {
    return [{ text: '🔙 Pilih Mobil Lain', callback_data: `odt:m:${tanggalCompact}:${jamCompact}` }];
  }
  function odoJamPickerRows(cars, jamCompact, tanggalCompact) {
    return cars.map(c => [{ text: carLabel(c.id), callback_data: `odt:c:${c.id}:${tanggalCompact}:${jamCompact}` }]);
  }

  // Cari titik histori GPS.id yang waktunya PALING DEKAT dgn targetMs, dalam
  // jendela ±menitJendela menit. Return null kalau tidak ada titik ber-mileage
  // sama sekali dalam jendela itu (BUKAN error -- pemanggil yang putuskan mau
  // lebarkan jendela atau menyerah).
  async function cariOdoTerdekat(env, imei, targetMs, menitJendela) {
    const fmt = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' }).replace('T', ' ');
    const points = await fetchGpsIdHistoryPoints(env, imei, fmt(targetMs - menitJendela * 60000), fmt(targetMs + menitJendela * 60000));
    const parsed = points
      .map(p => ({
        timeMs: new Date(String(p.time || '').replace(' ', 'T') + '+07:00').getTime(),
        mileage: p.mileage != null ? Number(p.mileage) : null,
      }))
      .filter(p => !isNaN(p.timeMs) && p.mileage != null);
    if (parsed.length === 0) return null;
    parsed.sort((a, b) => Math.abs(a.timeMs - targetMs) - Math.abs(b.timeMs - targetMs));
    return parsed[0];
  }

  async function odometerAtTimeText(env, car, tanggal, jamStr, assumedYesterday) {
    const labelWaktu = `jam ${jamStr}${assumedYesterday ? ' (kemarin)' : ' (hari ini)'}`;
    if (!car.imeiGps) {
      return `⚠️ ${escapeHtmlTg(carLabel(car.id))} belum diisi IMEI GPS.id di Data Mobil -- fitur ini butuh itu utk baca histori posisi.`;
    }
    const targetMs = new Date(`${tanggal}T${jamStr}:00+07:00`).getTime();
    try {
      let hit = await cariOdoTerdekat(env, car.imeiGps, targetMs, 30);
      let jendelaLebar = false;
      if (!hit) { hit = await cariOdoTerdekat(env, car.imeiGps, targetMs, 120); jendelaLebar = true; }
      if (!hit) {
        return `🛣️ <b>Odometer sekitar ${labelWaktu}</b>\n${escapeHtmlTg(carLabel(car.id))} — GPS.id tidak punya data histori posisi di sekitar jam itu (sudah dicoba sampai jendela ±2 jam).`;
      }
      const selisihMenit = Math.round(Math.abs(hit.timeMs - targetMs) / 60000);
      const jamTitik = new Date(hit.timeMs).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
      const km = Math.round(hit.mileage / 100) / 10; // meter -> KM (1 desimal)
      return `🛣️ <b>Odometer sekitar ${labelWaktu}</b>\n${escapeHtmlTg(carLabel(car.id))} — <b>${km.toLocaleString('id-ID')} KM</b> (titik GPS jam ${jamTitik}, selisih ${selisihMenit} menit dari yang diminta)${jendelaLebar ? '\n<i>(tidak ada data persis di ±30 menit, jendela dilebarkan ke ±2 jam)</i>' : ''}`;
    } catch (e) {
      const rateLimited = e && e.gpsStatus === 429;
      return rateLimited
        ? '⚠️ GPS.id sedang membatasi permintaan (rate limit) -- coba lagi sebentar.'
        : `⚠️ Gagal ambil data GPS.id (${escapeHtmlTg(e.message)}).`;
    }
  }

  // "bk:ya:<bookingId>" (Setuju) / "bk:tdk:<bookingId>" (Tolak), dikirim dari
  // /notify-booking-approval saat booking baru dibuat di aplikasi. STATELESS
  // sama seperti alur "sd:" di atas -- id booking ada langsung di
  // callback_data, tidak perlu convo tersimpan. Tombol sudah lenyap dari
  // pesan asal (lihat editMessageReplyMarkup di awal fungsi ini) begitu
  // di-tap, jadi tidak bisa di-tap dobel dari SISI PESAN YANG SAMA -- proteksi
  // dobel dari admin LAIN yang tap booking yang sama tetap dijaga di dalam
  // pushMainDataUpdate() di bawah (cek b.status==='menunggu' sebelum ditimpa).
  // Hanya admin (ADMIN_CHAT_IDS / state.notifAdmins) yang boleh memproses --
  // sopir yang entah-bagaimana tahu callback_data-nya tetap ditolak di sini.
  // ============================================================================
  if (cq && (text.startsWith('bk:ya:') || text.startsWith('bk:tdk:'))) {
    // v3.184.0 -- Administrator (state.superAdmins) SEKARANG BISA ikut approve
    // booking, TAPI HANYA kalau kategori "Approval Booking" utk kolom Super
    // Admin diaktifkan lewat menu "Notifikasi Telegram per Peran" (default
    // OFF -- lihat NOTIF_ROLE_PREFS_DEFAULT.superadmin.bookingApproval).
    // Dibaca LANGSUNG dari state.notifRolePrefs (bukan getNotifRolePrefsTg())
    // krn fungsi itu terkurung di dalam runNotifyCheck(), sama alasannya dgn
    // blockSelfApprove di bawah.
    const notifRolePrefsRaw = (state.notifRolePrefs && typeof state.notifRolePrefs === 'object') ? state.notifRolePrefs : {};
    const superAdminBookingApprovalOn = !!(notifRolePrefsRaw.superadmin && notifRolePrefsRaw.superadmin.bookingApproval === true);
    const isApprover = ADMIN_CHAT_IDS.includes(chatId) || (state.notifAdmins || []).some(a => (a.chatId || '').toString().trim() === chatId) ||
      (superAdminBookingApprovalOn && (state.superAdmins || []).some(a => (a.chatId || '').toString().trim() === chatId));
    if (!isApprover) {
      await sendTg(chatId, '⚠️ Kamu tidak terdaftar sebagai admin, tidak bisa memproses booking ini.');
      return;
    }
    const approve = text.startsWith('bk:ya:');
    // Ambil ID dari textRaw (bukan `text` yang sudah di-lowercase) -- aman
    // krn uid() di index.html selalu base36 (otomatis lowercase), tapi
    // dijaga di sini kalau format id berubah nanti.
    const bookingId = textRaw.slice(approve ? 'bk:ya:'.length : 'bk:tdk:'.length).trim().toLowerCase();
    // v3.183.0 -- BARU: cegah approve/tolak booking SENDIRI. "Sendiri"
    // dicek dari Chat ID (bukan nama), apapun perannya (Administrator, Admin
    // biasa, dst) -- kalau Chat ID yang tap tombol ini SAMA dengan Chat ID
    // pengaju booking (dicocokkan lewat nama b.petugas -> state.notifAdmins,
    // pola sama dgn pemberitahuan "pengaju" di bawah), tolak diproses.
    // Bisa dimatikan lewat Pengaturan > Ambang Batas Notifikasi (Administrator,
    // PIN 009900) kalau suatu saat tidak diperlukan lagi -- default AKTIF.
    // CATATAN: baca langsung dari state.notifSettings (BUKAN panggil
    // getNotifSettings()) -- fungsi itu ternyata terkurung di dalam
    // runNotifyCheck(), TIDAK bisa diakses dari processTelegramUpdate() ini
    // (fungsi async terpisah) -- ketahuan & diperbaiki sebelum sempat
    // dikirim, bukan lewat laporan bug.
    const blockSelfApprove = !(state.notifSettings && state.notifSettings.bookingApprovalBlockSelfApprove === false);
    if (blockSelfApprove) {
      const bookingCekSendiri = (state.bookings || []).find(x => x.id === bookingId);
      if (bookingCekSendiri && bookingCekSendiri.petugas) {
        const pengajuCek = (state.notifAdmins || []).find(a => (a.nama || '').trim() === String(bookingCekSendiri.petugas).trim() && a.chatId);
        if (pengajuCek && String(pengajuCek.chatId).trim() === chatId) {
          // v3.183.0 -- SEBELUM memblokir, cek dulu: ADA admin LAIN (Chat ID
          // beda dari pengaju) yang bisa memproses booking ini? Kalau TIDAK
          // ADA sama sekali (mis. cuma 1 admin terdaftar Telegram di seluruh
          // aplikasi), memblokir di sini bikin booking itu MENGGANTUNG
          // SELAMANYA (tidak ada siapa pun yang bisa approve) -- jadi
          // langsung DIIZINKAN diproses sendiri sbg jalan keluar, bukan
          // dipaksa nunggu admin lain yang tidak pernah ada.
          const semuaApproverCid = new Set();
          ADMIN_CHAT_IDS.forEach(cid => { if (cid) semuaApproverCid.add(cid); });
          (state.notifAdmins || []).forEach(a => { const cid = (a.chatId || '').toString().trim(); if (cid) semuaApproverCid.add(cid); });
          if (superAdminBookingApprovalOn) {
            (state.superAdmins || []).forEach(a => { const cid = (a.chatId || '').toString().trim(); if (cid) semuaApproverCid.add(cid); });
          }
          const adaApproverLain = [...semuaApproverCid].some(cid => cid !== chatId);
          if (adaApproverLain) {
            await sendTg(chatId, '⚠️ Kamu tidak bisa menyetujui/menolak booking yang kamu ajukan sendiri -- minta admin lain untuk memprosesnya.');
            return;
          }
          // Tidak ada admin lain sama sekali -- lanjutkan diproses seperti biasa di bawah, jangan diblokir.
        }
      }
    }
    const namaPenyetuju = (() => {
      const a = (state.notifAdmins || []).find(x => (x.chatId || '').toString().trim() === chatId);
      if (a && a.nama) return a.nama;
      const idxAdmin = ADMIN_CHAT_IDS.indexOf(chatId);
      if (idxAdmin >= 0) return `Admin${ADMIN_CHAT_IDS.length > 1 ? ' ' + (idxAdmin + 1) : ''} (Secret)`;
      // v3.184.0 -- kalau yang approve Administrator (bukan Admin/Secret biasa)
      const isSA = (state.superAdmins || []).some(sa => (sa.chatId || '').toString().trim() === chatId);
      return isSA ? 'Administrator' : 'Admin';
    })();

    let bookingSnapshot = null;
    let alreadyProcessedBy = null;
    const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      const bookings = freshRaw.data.bookings || [];
      const b = bookings.find(x => x.id === bookingId);
      if (!b) return false;
      if (b.status !== 'menunggu') {
        // Sudah diproses admin lain (atau diubah/dibatalkan dari aplikasi)
        // duluan -- JANGAN ditimpa, cukup laporkan siapa yang memproses.
        alreadyProcessedBy = b.approvedBy || b.rejectedBy || null;
        return false;
      }
      b.status = approve ? 'dipesan' : 'ditolak';
      if (approve) { b.approvedBy = namaPenyetuju; b.approvedAt = Date.now(); }
      else { b.rejectedBy = namaPenyetuju; b.rejectedAt = Date.now(); }
      b.updatedAt = Date.now();
      bookingSnapshot = { ...b };
      return true;
    });

    if (hasil.ok && bookingSnapshot) {
      const carTxt = carLabel(bookingSnapshot.carId);
      const tujuanTxt = bookingSnapshot.tujuan || '-';
      const ic = approve ? '✅' : '❌';
      await sendTg(chatId, `${ic} Booking <b>${escapeHtmlTg(carTxt)}</b> — ${escapeHtmlTg(tujuanTxt)} sudah kamu ${approve ? 'setujui' : 'tolak'}.`);

      // Beritahu admin lain (union ADMIN_CHAT_IDS + state.notifAdmins),
      // kecuali yang barusan tap.
      const lainnya = new Map();
      ADMIN_CHAT_IDS.forEach(cid => { if (cid && cid !== chatId) lainnya.set(cid, true); });
      (state.notifAdmins || []).forEach(a => {
        const cid = (a.chatId || '').toString().trim();
        if (cid && cid !== chatId) lainnya.set(cid, true);
      });
      const teksLain = `${ic} Booking <b>${escapeHtmlTg(carTxt)}</b> — ${escapeHtmlTg(tujuanTxt)} sudah ${approve ? 'DISETUJUI' : 'DITOLAK'} oleh <b>${escapeHtmlTg(namaPenyetuju)}</b>.`;
      for (const cid of lainnya.keys()) { await sendTg(cid, teksLain); }

      // Beritahu pengaju (petugas yang buat booking di aplikasi, field
      // b.petugas -- nama dari state.admins, BUKAN otomatis terhubung ke
      // Telegram). Kalau namanya cocok dgn salah satu state.notifAdmins yang
      // punya chatId, kirim balasan ke situ. Kalau tidak ketemu, dilewati
      // diam-diam (mis. pengaju cuma pakai aplikasi, tidak terdaftar Telegram).
      if (bookingSnapshot.petugas) {
        const pengaju = (state.notifAdmins || []).find(a => (a.nama || '').trim() === String(bookingSnapshot.petugas).trim() && a.chatId);
        if (pengaju) {
          const pengajuCid = String(pengaju.chatId).trim();
          if (pengajuCid !== chatId && !lainnya.has(pengajuCid)) {
            await sendTg(pengajuCid, `${ic} Booking yang kamu ajukan — <b>${escapeHtmlTg(carTxt)}</b> (${escapeHtmlTg(tujuanTxt)}) — sudah ${approve ? 'DISETUJUI' : 'DITOLAK'} oleh <b>${escapeHtmlTg(namaPenyetuju)}</b>.`);
          }
        }
      }

      // BARU (v3.168.0) -- Beritahu SOPIR yang tercantum di booking ini
      // (kalau ada & terdaftar Telegram) hasil approve/tolaknya -- sopir
      // sebelumnya cuma dapat pesan "booking tercatat, tunggu approval" saat
      // booking dibuat (lihat sendDriverBookingCreatedNotif() di index.html),
      // sekarang dikabari juga begitu keputusannya keluar.
      if (bookingSnapshot.driverId) {
        const driver = state.drivers.find(d => d.id === bookingSnapshot.driverId);
        const driverCid = driver && (driver.telegramChatId || '').toString().trim();
        if (driverCid) {
          const teksSopir = approve
            ? `${ic} Booking <b>${escapeHtmlTg(carTxt)}</b> — ${escapeHtmlTg(tujuanTxt)} sudah DISETUJUI admin. Mobil sudah bisa dipakai sesuai jadwal.`
            : `${ic} Booking <b>${escapeHtmlTg(carTxt)}</b> — ${escapeHtmlTg(tujuanTxt)} DITOLAK admin. Hubungi admin kalau ada pertanyaan.`;
          await sendTg(driverCid, teksSopir);
        }
      }
      console.log(`webhook: Booking ${bookingId} ${approve ? 'disetujui' : 'ditolak'} oleh ${namaPenyetuju}.`);
    } else if (!bookingSnapshot && alreadyProcessedBy) {
      await sendTg(chatId, `ℹ️ Booking ini sudah lebih dulu diproses oleh <b>${escapeHtmlTg(alreadyProcessedBy)}</b>, tidak diubah lagi.`);
    } else if (!bookingSnapshot) {
      await sendTg(chatId, '⚠️ Booking ini sudah tidak ditemukan (mungkin sudah dihapus/diubah dari aplikasi).');
    } else {
      await sendTg(chatId, '❌ Gagal menyimpan ke server -- coba tap tombolnya sekali lagi.');
    }
    return;
  }

  // ============================================================================
  // v3.261.0 -- BARU: respons tombol "✅ Ya, jadikan tujuan" / "❌ Tidak" dari
  // pertanyaan proaktif "Pola Kunjungan Berulang" (lihat
  // kirimPertanyaanJadikanTujuan() -- dikirim otomatis dari
  // runWeeklyPatternAnalysis(), BUKAN dari sini). callback_data formatnya
  // "polatjn:ya:<carId>:<patternId>" / "polatjn:tdk:<carId>:<patternId>" --
  // dipisah ':' TITIK DUA, aman krn carId/patternId ('POLA-...') proyek ini
  // tidak pernah mengandung ':' (selalu base36/timestamp/random alfanumerik).
  // ============================================================================
  if (cq && (text.startsWith('polatjn:ya:') || text.startsWith('polatjn:tdk:'))) {
    const isApproverPola = ADMIN_CHAT_IDS.includes(chatId) || (state.notifAdmins || []).some(a => (a.chatId || '').toString().trim() === chatId) || (state.superAdmins || []).some(a => (a.chatId || '').toString().trim() === chatId);
    if (!isApproverPola) { await sendTg(chatId, '⚠️ Kamu tidak terdaftar sebagai admin, tidak bisa memproses ini.'); return; }
    const jadikan = text.startsWith('polatjn:ya:');
    const sisaId = textRaw.slice((jadikan ? 'polatjn:ya:' : 'polatjn:tdk:').length);
    const [carIdPola, ...patternIdParts] = sisaId.split(':');
    const patternIdPola = patternIdParts.join(':'); // jaga2 kalau patternId sendiri kebetulan mengandung ':'
    const carPola = (state.cars || []).find(c => c.id === carIdPola);
    // Tandai sudahDitanyakanTujuan=true APA PUN jawabannya (Ya/Tidak) --
    // supaya pola yang sama tidak ditanyakan berulang-ulang tiap minggu.
    const hasilTandai = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      const patterns = (freshRaw.data.recurringStopPatterns && freshRaw.data.recurringStopPatterns[carIdPola]) || [];
      const p = patterns.find(x => x.id === patternIdPola);
      if (!p) return false;
      p.sudahDitanyakanTujuan = true;
      return true;
    });
    if (!hasilTandai.ok) { await sendTg(chatId, '⚠️ Pola ini sudah tidak ditemukan (mungkin sudah kadaluarsa/mobil dihapus).'); return; }
    if (!jadikan) { await sendTg(chatId, '👍 Oke, tidak dijadikan Data Tujuan. Polanya tetap terus dianalisis & bisa dilihat lagi lewat Pengaturan -> 📍 Pola Kunjungan Berulang.'); return; }
    if (!carPola) { await sendTg(chatId, '⚠️ Mobil untuk pola ini sudah tidak ditemukan.'); return; }
    await pushNotifStateUpdate(env, async (pendingConversations) => {
      pendingConversations[chatId] = { kind: 'pola_tujuan_nama', carId: carIdPola, patternId: patternIdPola, startedAt: Date.now() };
    });
    await sendTg(chatId, `📍 Oke! Nama tujuan ini apa? (contoh: "Masjid Al-Ikhlas", "Warung Makan Bu Siti")\n\nKetik "batal" kalau berubah pikiran.`);
    return;
  }

  // ============================================================================
  // BARU: Konfirmasi Booking H-1 Jam -- tombol "📱 Input dari Aplikasi Saja"
  // (callback_data "bkh1:app:<bookingId>") -- sopir/pembuat booking memilih
  // untuk mengisi/memproses booking ini sendiri lewat aplikasi web FleetOps,
  // BUKAN lewat tombol Telegram. Booking TIDAK diubah sama sekali di sini
  // (biar tetap 'dipesan', diproses manual dari aplikasi) -- cukup dibalas
  // pesan konfirmasi baku sesuai permintaan. Validasi penerima SAMA PERSIS
  // dgn "bkh1:jadi:"/"bkh1:batal:" di bawah (hanya chat yang berhak).
  // ============================================================================
  if (cq && text.startsWith('bkh1:app:')) {
    const bookingIdApp = textRaw.slice('bkh1:app:'.length).trim().toLowerCase();
    const bJadwalApp = state.bookings.find(x => x.id === bookingIdApp);
    if (!bJadwalApp) {
      await sendTg(chatId, '⚠️ Booking ini sudah tidak ditemukan (mungkin sudah dihapus/diubah dari aplikasi).');
      return;
    }
    const driverBookingApp = bJadwalApp.driverId ? state.drivers.find(d => d.id === bJadwalApp.driverId) : null;
    const driverCidApp = driverBookingApp && (driverBookingApp.telegramChatId || '').toString().trim();
    const adminPembuatApp = !driverCidApp && bJadwalApp.petugas
      ? (state.notifAdmins || []).find(a => (a.nama || '').trim() === String(bJadwalApp.petugas).trim() && a.chatId)
      : null;
    const targetCidApp = driverCidApp || (adminPembuatApp && String(adminPembuatApp.chatId).trim());
    if (!targetCidApp || targetCidApp !== chatId) {
      await sendTg(chatId, '⚠️ Booking ini bukan untuk kamu.');
      return;
    }
    await sendTg(chatId, [
      'Baik, silakan lakukan input melalui aplikasi FleetOps .',
      'Terima kasih telah menggunakan FleetOps dan merespon pesan ini.',
      'Stay in Control.',
      'Semoga Allah senantiasa menjaga dan melancarkan setiap perjalanan Anda. 🤲',
    ].join('\n'));
    return;
  }

  // ============================================================================
  // BARU: Konfirmasi Booking H-1 Jam -- tombol "✅ Ya, Berangkat" / "❌ Batal"
  // dari pesan yang dikirim runNotifyCheck() ~1 jam sebelum jadwal booking
  // (callback_data "bkh1:jadi:<bookingId>" / "bkh1:batal:<bookingId>", lihat
  // blok "Konfirmasi Booking H-1 Jam" di runNotifyCheck()). STATELESS sama
  // seperti "bk:ya:"/"bk:tdk:" di atas (id booking ada langsung di
  // callback_data). PENTING (sesuai permintaan): pesan konfirmasi ini SENGAJA
  // hanya dikirim ke 1 chat (sopir yang tercantum di booking, atau admin
  // pembuatnya kalau belum ada sopir dipilih) -- di sini kita jaga supaya
  // HANYA chat itu juga yang boleh menekan tombolnya (dicek ulang di server,
  // bukan cuma percaya tombolnya cuma dikirim ke 1 orang).
  // ============================================================================
  if (cq && (text.startsWith('bkh1:jadi:') || text.startsWith('bkh1:batal:'))) {
    const jadiBerangkat = text.startsWith('bkh1:jadi:');
    const bookingIdH1 = textRaw.slice(jadiBerangkat ? 'bkh1:jadi:'.length : 'bkh1:batal:'.length).trim().toLowerCase();
    const bJadwal = state.bookings.find(x => x.id === bookingIdH1);
    if (!bJadwal) {
      await sendTg(chatId, '⚠️ Booking ini sudah tidak ditemukan (mungkin sudah dihapus/diubah dari aplikasi).');
      return;
    }
    const driverBookingIni = bJadwal.driverId ? state.drivers.find(d => d.id === bJadwal.driverId) : null;
    const driverCidIni = driverBookingIni && (driverBookingIni.telegramChatId || '').toString().trim();
    const adminPembuatIni = !driverCidIni && bJadwal.petugas
      ? (state.notifAdmins || []).find(a => (a.nama || '').trim() === String(bJadwal.petugas).trim() && a.chatId)
      : null;
    const targetCidIni = driverCidIni || (adminPembuatIni && String(adminPembuatIni.chatId).trim());
    if (!targetCidIni || targetCidIni !== chatId) {
      await sendTg(chatId, '⚠️ Booking ini bukan untuk kamu.');
      return;
    }
    if (bJadwal.status !== 'dipesan') {
      await sendTg(chatId, 'ℹ️ Booking ini sudah tidak berstatus "dipesan" lagi (sudah diproses lebih dulu) -- tidak diubah lagi.');
      return;
    }

    if (!jadiBerangkat) {
      // ---- Batal: SAMA PERSIS dgn cancelBooking() di index.html (status -> 'dibatalkan') ----
      const hasilBatal = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
        const bookings = freshRaw.data.bookings || [];
        const b = bookings.find(x => x.id === bookingIdH1);
        if (!b || b.status !== 'dipesan') return false;
        b.status = 'dibatalkan';
        b.updatedAt = Date.now();
        return true;
      });
      await sendTg(chatId, hasilBatal.ok
        ? `❌ Booking <b>${escapeHtmlTg(carLabel(bJadwal.carId))}</b> — ${escapeHtmlTg(bJadwal.tujuan || '-')} sudah dibatalkan. Data di aplikasi ikut ter-update.`
        : '⚠️ Booking ini sudah tidak bisa dibatalkan lagi (mungkin sudah diubah dari aplikasi/chat lain) -- coba tap sekali lagi.');
      return;
    }

    // ---- Jadi Berangkat: SAMA PERSIS dgn startTripFromBooking() di
    // index.html -- langsung buat catatan Penggunaan Mobil baru berstatus
    // "digunakan" (carId/driverId/tujuan/jenisPenggunaan ke-auto-isi dari
    // booking, TANPA tanya odometer/BBM dulu -- itu tetap bisa dilengkapi
    // nanti dari aplikasi atau ketik "isi" di chat), booking-nya jadi
    // 'selesai'. ----
    const jamSekarangH1 = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
    const tanggalSekarangH1 = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
    let savedKodeH1 = null;
    let gagalKarenaMobilDipakai = false;
    const hasilJadi = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      const bookings = freshRaw.data.bookings || [];
      const b = bookings.find(x => x.id === bookingIdH1);
      if (!b || b.status !== 'dipesan') return false;
      freshRaw.data.usage = freshRaw.data.usage || [];
      const mobilSedangDipakai = freshRaw.data.usage.some(u => u.carId === b.carId && u.status === 'digunakan');
      if (mobilSedangDipakai) { gagalKarenaMobilDipakai = true; return false; }
      freshRaw.data.usageCodeSeq = (freshRaw.data.usageCodeSeq || 0) + 1;
      savedKodeH1 = 'PJL-' + String(freshRaw.data.usageCodeSeq).padStart(5, '0');
      freshRaw.data.usage.push({
        id: uidTg(), kode: savedKodeH1, carId: b.carId, driverId: b.driverId || null,
        jenisPenggunaan: b.jenisPenggunaan || 'pengiriman', tujuan: b.tujuan, mapsLink: b.mapsLink || null,
        tglKeluar: tanggalSekarangH1, tglKembali: null, jamKeluar: jamSekarangH1, jamKembali: null,
        status: 'digunakan',
        odoKeluar: null, odoKembali: null, bensinKeluar: null, bensinKembali: null,
        literBensin: null, biayaBensin: null, etollCardId: null, saldoEtollAwal: null, saldoEtoll: null,
        petugas: driverBookingIni ? `${driverBookingIni.nama} (via Telegram)` : (adminPembuatIni ? adminPembuatIni.nama : 'Telegram'),
        updatedAt: Date.now(),
      });
      b.status = 'selesai';
      b.updatedAt = Date.now();
      freshRaw.data.activityLog = freshRaw.data.activityLog || [];
      freshRaw.data.activityLog.unshift({
        id: uidTg(), tipe: 'penggunaan', judul: 'Mulai perjalanan dari booking (via Telegram)',
        keterangan: `${carLabel(b.carId)} — ${b.tujuan}`, waktu: Date.now(),
        petugas: driverBookingIni ? driverBookingIni.nama : (adminPembuatIni ? adminPembuatIni.nama : 'Telegram'),
      });
      if (freshRaw.data.activityLog.length > 200) freshRaw.data.activityLog = freshRaw.data.activityLog.slice(0, 200);
      return true;
    });

    if (hasilJadi.ok) {
      await sendTg(chatId, [
        `✅ <b>Perjalanan dimulai!</b> (${savedKodeH1})`, '',
        `🚗 ${escapeHtmlTg(carLabel(bJadwal.carId))}`,
        `📍 ${escapeHtmlTg(bJadwal.tujuan || '-')}`, '',
        `Data mobil sudah otomatis tercatat di Catat Perjalanan (sama seperti tombol "Mulai Perjalanan" di aplikasi). Hati-hati di jalan! Nanti kalau sudah selesai semua, ketik "akhiri trip" ya. 🙏`,
      ].join('\n'));
      if (ADMIN_CHAT_IDS.length) {
        const teksH1Admin = `🚗 Booking <b>${escapeHtmlTg(carLabel(bJadwal.carId))}</b> — ${escapeHtmlTg(bJadwal.tujuan || '-')} dikonfirmasi JADI berangkat lewat Telegram.`;
        await sendTgUnique(ADMIN_CHAT_IDS.map(adminId => ({ chatId: adminId, text: teksH1Admin })));
      }
      console.log(`webhook: Booking ${bookingIdH1} dikonfirmasi JADI berangkat lewat Telegram (${savedKodeH1}).`);
    } else if (gagalKarenaMobilDipakai) {
      await sendTg(chatId, '⚠️ Mobil ini sedang dipakai di perjalanan lain -- selesaikan dulu perjalanan itu (ketik "akhiri trip"), baru bisa mulai booking ini.');
    } else {
      await sendTg(chatId, 'ℹ️ Booking ini sudah tidak berstatus "dipesan" lagi (mungkin sudah diproses/diubah lebih dulu) -- tidak diubah lagi.');
    }
    return;
  }

  // ============================================================================
  // BARU: eksekusi pembatalan booking (callback_data "batalbk:<bookingId>",
  // dipicu dari daftar yg dikirim handler "batalbooking"/"batal booking" di
  // atas). Otorisasi dicek ULANG di sini (bukan cuma percaya krn ID-nya
  // sudah ada di tombol) -- sopir cuma boleh membatalkan booking miliknya
  // sendiri, admin/notifAdmin/Administrator boleh membatalkan booking
  // siapa pun (SAMA seperti wewenang approve/tolak). Perubahan status ->
  // 'dibatalkan' SAMA PERSIS dgn cancelBooking() di index.html & blok
  // "bkh1:batal:" di atas.
  // ============================================================================
  if (cq && text.startsWith('batalbk:')) {
    const bookingIdBb = textRaw.slice('batalbk:'.length).trim();
    const bTargetBb = (state.bookings || []).find(x => x.id === bookingIdBb);
    if (!bTargetBb) {
      await sendTg(chatId, '⚠️ Booking ini sudah tidak ditemukan (mungkin sudah dihapus/diubah dari aplikasi).');
      return;
    }
    const driverActorBb2 = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
    const bolehBatalkan = driverActorBb2
      ? bTargetBb.driverId === driverActorBb2.id
      : isAdminOrSuperAdmin(chatId) || (state.notifAdmins || []).some(a => (a.chatId || '').toString().trim() === chatId);
    if (!bolehBatalkan) {
      await sendTg(chatId, '⚠️ Booking ini bukan milik Anda.');
      return;
    }
    if (bTargetBb.status !== 'menunggu' && bTargetBb.status !== 'dipesan') {
      await sendTg(chatId, 'ℹ️ Booking ini sudah tidak berstatus aktif lagi (sudah diproses/diubah lebih dulu) -- tidak diubah lagi.');
      return;
    }
    const hasilBatalBb = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      const bookings = freshRaw.data.bookings || [];
      const b = bookings.find(x => x.id === bookingIdBb);
      if (!b || (b.status !== 'menunggu' && b.status !== 'dipesan')) return false;
      b.status = 'dibatalkan';
      b.updatedAt = Date.now();
      return true;
    });
    if (!hasilBatalBb.ok) {
      await sendTg(chatId, '⚠️ Booking ini sudah tidak bisa dibatalkan lagi (mungkin sudah diubah dari aplikasi/chat lain) -- coba tap sekali lagi.');
      return;
    }
    const carTxtBb = carLabel(bTargetBb.carId);
    const tujuanTxtBb = bTargetBb.tujuan || '-';
    await sendTg(chatId, `❌ Booking <b>${escapeHtmlTg(carTxtBb)}</b> — ${escapeHtmlTg(tujuanTxtBb)} sudah dibatalkan. Data di aplikasi ikut ter-update.`);
    // Beritahu pihak lain yang terkait (sopir kalau yg batalkan admin, atau
    // admin pembuat kalau yg batalkan sopir) -- pola SAMA dgn notifikasi
    // approve/tolak booking di atas, TAPI cuma 1 pihak lawan (bukan broadcast
    // ke semua admin) supaya tidak berisik utk aksi pembatalan sendiri.
    if (driverActorBb2 && bTargetBb.petugas) {
      const pengajuBb = (state.notifAdmins || []).find(a => (a.nama || '').trim() === String(bTargetBb.petugas).trim() && a.chatId);
      if (pengajuBb && String(pengajuBb.chatId).trim() !== chatId) {
        await sendTg(String(pengajuBb.chatId).trim(), `❌ Booking <b>${escapeHtmlTg(carTxtBb)}</b> — ${escapeHtmlTg(tujuanTxtBb)} dibatalkan oleh sopir (${escapeHtmlTg(driverActorBb2.nama)}) lewat Telegram.`);
      }
    } else if (!driverActorBb2 && bTargetBb.driverId) {
      const driverBb2 = state.drivers.find(d => d.id === bTargetBb.driverId);
      const driverCidBb2 = driverBb2 && (driverBb2.telegramChatId || '').toString().trim();
      if (driverCidBb2) {
        await sendTg(driverCidBb2, `❌ Booking <b>${escapeHtmlTg(carTxtBb)}</b> — ${escapeHtmlTg(tujuanTxtBb)} dibatalkan admin.`);
      }
    }
    console.log(`webhook: Booking ${bookingIdBb} dibatalkan lewat Telegram oleh ${chatId}.`);
    return;
  }

  // BARU: Admin Finance (state.financeAdmins) boleh ikut pakai menu ini,
  // TAPI cuma 4 kategori yang relevan langsung utk Finance -- E-Toll, Biaya
  // BBM Bulan Ini, Masa Berlaku Dokumen, & Budget Bulanan. Kategori lain
  // (Sisa BBM Tangki, Odometer, Efisiensi, Servis-ringkas) TETAP tertutup --
  // itu data operasional, bukan data keuangan, jadi sengaja tidak dibuka.
  // financeOnlyRestricted = true berarti chat ini TIDAK lolos
  // isSaldoAllowedUser (bukan Admin/Sopir), MURNI lewat jalur Finance yg
  // dibatasi ke 4 kategori ini.
  const FINANCE_SALDO_CATEGORIES = ['et', 'bb', 'dk', 'bg'];
  function financeSaldoMenuKeyboard() {
    return [
      [{ text: '💳 E-Toll', callback_data: 'sd:c:et' }, { text: '💵 Biaya BBM Bulan Ini', callback_data: 'sd:c:bb' }],
      [{ text: '📄 Masa Berlaku Dokumen', callback_data: 'sd:c:dk' }, { text: '💰 Budget Bulanan', callback_data: 'sd:c:bg' }],
    ];
  }
  if (isSaldoAllowedUser(chatId) || isFinanceAdminChat(chatId)) {
    const financeOnlyRestricted = !isSaldoAllowedUser(chatId) && isFinanceAdminChat(chatId);
    const saldoNav = (cq && text.startsWith('sd:')) ? text : null;
    const saldoKeyword = (!cq && text === 'saldo') ? 'MENU' : ((!cq && SALDO_KEYWORD_TO_CATEGORY[text]) || null);

    if (saldoNav === 'sd:m' || saldoKeyword === 'MENU') {
      if (financeOnlyRestricted) {
        // Finance-only -- tampilkan menu MINI berisi 4 kategori yg dibuka
        // saja, JANGAN kasih menu penuh (Odometer/Efisiensi/dst tetap tersembunyi).
        await sendTg(chatId, '📋 <b>Menu Saldo (Finance)</b>\nPilih kategori:', financeSaldoMenuKeyboard());
        return;
      }
      await sendTg(chatId, '📋 <b>Menu Saldo</b>\nPilih kategori:', saldoMainMenuKeyboard());
      return;
    }
    if (saldoKeyword) {
      if (financeOnlyRestricted && !FINANCE_SALDO_CATEGORIES.includes(saldoKeyword)) return; // kategori lain tetap tertutup utk Finance
      const list = saldoListForCategory(saldoKeyword);
      if (list) await sendTg(chatId, list.text, list.keyboard);
      return;
    }
    if (saldoNav && (saldoNav.startsWith('sd:c:') || saldoNav.startsWith('sd:l:'))) {
      const kat = saldoNav.slice(5);
      if (financeOnlyRestricted && !FINANCE_SALDO_CATEGORIES.includes(kat)) return;
      const list = saldoListForCategory(kat);
      if (list) await sendTg(chatId, list.text, list.keyboard);
      return;
    }
    if (saldoNav && saldoNav.startsWith('sd:i:')) {
      const parts = saldoNav.split(':'); // ['sd','i',cat,id]
      const cat = parts[2], id = parts[3];
      if (financeOnlyRestricted && !FINANCE_SALDO_CATEGORIES.includes(cat)) return;
      const detailText = await saldoDetailForItem(cat, id);
      await sendTg(chatId, detailText, [[{ text: '🔙 Kembali', callback_data: `sd:l:${cat}` }], saldoBackToMenuRow()]);
      return;
    }
  }

  if (isAdminNotifUser(chatId)) {
    const cekNav = (cq && text.startsWith('ck:')) ? text : null;
    const cekKeyword = !cq && CEK_MOBIL_KEYWORDS.includes(text);

    if (cekKeyword || cekNav === 'ck:m') {
      const tripsAktif = state.usage.filter(u => u.status === 'digunakan');
      if (tripsAktif.length === 0) {
        await sendTg(chatId, '🚗 Tidak ada mobil yang sedang jalan (trip aktif) saat ini.');
        return;
      }
      if (tripsAktif.length === 1) {
        await sendTg(chatId, await cekMobilDetailText(tripsAktif[0], env));
        return;
      }
      await sendTg(chatId, `🚗 Ada ${tripsAktif.length} mobil sedang jalan. Pilih salah satu:`, cekMobilPickerRows(tripsAktif));
      return;
    }
    if (cekNav && cekNav.startsWith('ck:t:')) {
      const tripId = cekNav.slice(5);
      const trip = state.usage.find(u => u.id === tripId && u.status === 'digunakan');
      if (!trip) {
        await sendTg(chatId, '⚠️ Trip ini sudah tidak aktif (mungkin sudah ditutup/dihapus). Ketik "cek" lagi untuk lihat daftar terbaru.');
        return;
      }
      await sendTg(chatId, await cekMobilDetailText(trip, env), [cekMobilBackRow()]);
      return;
    }
  }

  // ---- BARU (v3.213.0): "cek [kode trip]" (mis. "cek PJL-00007") --
  // tampilkan status kirim & KIRIM ULANG foto nota/tanda terima 1 trip
  // TERTENTU (beda dari "cek" tanpa kode di atas -- itu ringkasan trip yang
  // SEDANG BERJALAN, khusus Admin Notifikasi). Ini bisa cari trip APA SAJA
  // (aktif maupun sudah selesai) berdasarkan kode persis. Akses: Sopir HANYA
  // boleh cek trip MILIKNYA SENDIRI (kalau bukan, dibalas "tidak ditemukan"
  // supaya tidak bocor keberadaan trip sopir lain); Operator/Finance/
  // Administrator boleh cek trip siapa saja WAJIB selalu bisa.
  if (!cq && /^cek\s+[a-z]+-\d+$/i.test(text)) {
    const kodeCari = text.replace(/^cek\s+/, '').trim();
    const tripCek = state.usage.find(u => (u.kode || '').toLowerCase() === kodeCari);
    const driverCek = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
    const bolehLihatSemua = isAdminOrSuperAdmin(chatId) || isFinanceAdminChat(chatId);
    if (!tripCek || (!bolehLihatSemua && !(driverCek && tripCek.driverId === driverCek.id))) {
      await sendTg(chatId, `⚠️ Trip dengan kode <b>${escapeHtmlTg(kodeCari.toUpperCase())}</b> tidak ditemukan. Pastikan kodenya persis sama dengan yang tertera di aplikasi/resi (contoh: PJL-00007).`);
      return;
    }
    const notaItemsCek = Array.isArray(tripCek.buktiPending) ? tripCek.buktiPending : [];
    const resiItemCek = tripCek.resiImageFileId ? { fileId: tripCek.resiImageFileId, kind: 'photo' } : null;
    const fotoCek = [...(resiItemCek ? [resiItemCek] : []), ...notaItemsCek.filter(b => b.kind === 'photo')];
    const docsCek = notaItemsCek.filter(b => b.kind === 'document');
    const driverPemilikCek = state.drivers.find(d => d.id === tripCek.driverId);
    const statusKirimCek = tripCek.jenisPenggunaan === 'pribadi'
      ? '🏠 Trip Pribadi -- tidak diteruskan ke Admin Finance.'
      : (tripCek.buktiTerkirimAt
        ? `✅ Sudah dikirim ke Admin Finance (${new Date(tripCek.buktiTerkirimAt).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })} WIB).`
        : '⏳ Belum dikirim ke Admin Finance (sopir belum ketik "kirim", atau memang belum ada nota).');
    const headerCek = `📎 <b>${escapeHtmlTg(tripCek.kode || kodeCari.toUpperCase())}</b>\n${escapeHtmlTg(driverPemilikCek ? driverPemilikCek.nama : '-')} — ${escapeHtmlTg(carLabel(tripCek.carId))}\n${escapeHtmlTg(tripCek.tujuan || '-')}\n${escapeHtmlTg(tripCek.tglKeluar || '-')} s/d ${escapeHtmlTg(tripCek.tglKembali || 'masih berjalan')}\n\n${statusKirimCek}` +
      (fotoCek.length ? `\n📷 ${fotoCek.length} foto${resiItemCek ? ' (termasuk Tanda Terima Perjalanan)' : ''}` : '') +
      (docsCek.length ? `\n📄 ${docsCek.length} dokumen` : '') +
      ((!fotoCek.length && !docsCek.length) ? '\n\n<i>Belum ada nota/tanda terima yang dikirim ke bot untuk trip ini.</i>' : '');
    await sendTg(chatId, headerCek);
    // v3.213.0 -- kirim ulang FOTO ASLINYA pakai file_id (bukan bytes baru),
    // sama pola dgn handleGetKirimNotaFinance/sendTgPhotoById di atas. Caption
    // nota SENGAJA TIDAK pakai parse_mode HTML (beda dari headerCek) --
    // caption itu teks bebas ketikan sopir, bisa berisi karakter yang salah
    // dikira tag HTML kalau dipaksa parse_mode, bikin Telegram menolak
    // kirimnya. Sama pola aman dgn kirimNotaKeFinance yang sudah ada.
    if (fotoCek.length === 1) {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, photo: fotoCek[0].fileId, ...(fotoCek[0].caption ? { caption: fotoCek[0].caption } : {}) }),
        });
      } catch (e) { console.log('cek-kode: gagal sendPhoto (tunggal) ke', chatId, e.message); }
    } else if (fotoCek.length > 1) {
      for (const chunk of chunkMediaGroup(fotoCek, 10)) {
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, media: chunk.map(b => ({ type: 'photo', media: b.fileId, ...(b.caption ? { caption: b.caption } : {}) })) }),
          });
        } catch (e) { console.log('cek-kode: gagal sendMediaGroup ke', chatId, e.message); }
      }
    }
    for (const d of docsCek) {
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, document: d.fileId, ...(d.caption ? { caption: d.caption } : {}) }),
        });
      } catch (e) { console.log('cek-kode: gagal sendDocument ke', chatId, e.message); }
    }
    return;
  }

  // ---- BARU: "lokasi" -- lokasi TERKINI 1 mobil (semua mobil ber-IMEI,
  // bukan cuma yang sedang trip), KHUSUS Admin Notifikasi & Administrator. ----
  if (isAdminOrSuperAdmin(chatId)) {
    const lokasiNav = (cq && text.startsWith('lk:')) ? text : null;
    const lokasiKeyword = !cq && LOKASI_KEYWORDS.includes(text);

    if (lokasiKeyword || lokasiNav === 'lk:m') {
      const carsGps = state.cars.filter(c => c.imeiGps);
      if (carsGps.length === 0) {
        await sendTg(chatId, '📍 Belum ada mobil yang terhubung IMEI GPS.id (atur di menu Data Mobil).');
        return;
      }
      if (carsGps.length === 1) {
        await sendTg(chatId, await lokasiDetailText(carsGps[0], env));
        return;
      }
      await sendTg(chatId, `📍 Ada ${carsGps.length} mobil terhubung GPS.id. Pilih salah satu:`, lokasiMobilPickerRows(carsGps));
      return;
    }
    if (lokasiNav && lokasiNav.startsWith('lk:c:')) {
      const carId = lokasiNav.slice(5);
      const car = state.cars.find(c => c.id === carId);
      if (!car) {
        await sendTg(chatId, '⚠️ Mobil ini sudah tidak ditemukan (mungkin sudah dihapus). Ketik "lokasi" lagi untuk lihat daftar terbaru.');
        return;
      }
      await sendTg(chatId, await lokasiDetailText(car, env), [lokasiMobilBackRow()]);
      return;
    }
  }

  // ---- BARU: "service"/"servis"/"maintenance" -- rekomendasi kategori Servis
  // & Maintenance, lalu 3 data terbaru per kategori. Admin Notifikasi &
  // Administrator, DITAMBAH Admin Finance (state.financeAdmins) -- Finance
  // butuh lihat detail biaya servis/maintenance juga utk keperluan
  // pembukuan, walau bukan Admin/Sopir. ----
  if (isAdminOrSuperAdmin(chatId) || isFinanceAdminChat(chatId)) {
    const serviceNav = (cq && text.startsWith('sv:')) ? text : null;
    const serviceKeyword = !cq && SERVICE_KEYWORDS.includes(text);
    // v3.??? -- FIX: sebelumnya HARUS ketik "service"/"servis"/"maintenance"
    // dulu baru bisa TAP tombol kategori -- ketik nama kategori langsung
    // (mis. "ganti oli") tidak dikenali sama sekali & jatuh ke pesan "belum
    // ngerti". Sekarang kalau teks yang diketik cocok PERSIS (case-insensitive)
    // dengan salah satu SERVICE_CATEGORIES, langsung tampilkan 3 data
    // terbaru kategori itu -- tanpa perlu ketik "service" dulu.
    const kategoriTyped = !cq ? SERVICE_CATEGORIES.find(k => k.toLowerCase() === text) : null;

    if (serviceKeyword || serviceNav === 'sv:m') {
      await sendTg(chatId, '🔧 <b>Servis & Maintenance</b>\nPilih kategori untuk lihat 3 data terbaru:', serviceCategoryKeyboard());
      return;
    }
    if (kategoriTyped) {
      await sendTg(chatId, serviceRecentTextForCategory(kategoriTyped), [serviceCategoryBackRow()]);
      return;
    }
    if (serviceNav && serviceNav.startsWith('sv:k:')) {
      const kategori = textRaw.slice('sv:k:'.length);
      if (!SERVICE_CATEGORIES.includes(kategori)) {
        await sendTg(chatId, '⚠️ Kategori ini tidak dikenali. Ketik "service" lagi untuk pilih ulang.');
        return;
      }
      await sendTg(chatId, serviceRecentTextForCategory(kategori), [serviceCategoryBackRow()]);
      return;
    }
  }

  // ---- BARU: "oli"/"service"/"servis" KHUSUS SOPIR (bukan Admin/Super
  // Admin -- mereka sudah ditangani & di-return oleh blok Admin di atas
  // duluan kalau perannya cocok). Cuma status Ganti Oli mobil yang
  // pernah/sedang dia pakai sendiri -- lihat catatan lengkap di
  // carsForDriverBot()/oliStatusTextForCar() di atas soal batasan aksesnya. ----
  {
    const driverOli = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
    if (driverOli && !isAdminOrSuperAdmin(chatId)) {
      const oliNav = (cq && text.startsWith('svo:')) ? text : null;
      const oliKeyword = !cq && (DRIVER_OLI_KEYWORDS.includes(text) || SERVICE_KEYWORDS.includes(text));

      if (oliKeyword || oliNav === 'svo:m') {
        const cars = carsForDriverBot(driverOli.id);
        if (cars.length === 0) {
          await sendTg(chatId, '🔧 Belum ada riwayat mobil yang kamu pakai, jadi belum bisa dicek status olinya.');
          return;
        }
        if (cars.length === 1) {
          await sendTg(chatId, oliStatusTextForCar(cars[0]));
          return;
        }
        await sendTg(chatId, '🔧 Mobil mana yang mau dicek status olinya?', oliCarPickerRows(cars));
        return;
      }
      if (oliNav && oliNav.startsWith('svo:c:')) {
        const carId = oliNav.slice('svo:c:'.length);
        // Validasi ulang: carId HARUS ada di daftar mobil sopir ini sendiri
        // (bukan percaya begitu saja ke callback_data yang datang) -- supaya
        // sopir tidak bisa intip status mobil lain dgn mengarang carId.
        const carsMilikDia = carsForDriverBot(driverOli.id);
        const car = carsMilikDia.find(c => c.id === carId);
        if (!car) {
          await sendTg(chatId, '⚠️ Mobil ini bukan riwayat mobil kamu atau sudah tidak ditemukan. Ketik "oli" lagi untuk lihat daftar mobil kamu.');
          return;
        }
        await sendTg(chatId, oliStatusTextForCar(car), [oliBackRow()]);
        return;
      }
    }
  }

  // ---- BARU: "odometer jam sekian" -- deteksi pola waktu bebas ("jam 10",
  // "pukul 14.00", "kemarin jam 9", dst) di teks bebas (BUKAN keyword tetap).
  // Admin/Administrator boleh tanya mobil MANAPUN yg terhubung IMEI GPS.id
  // (kalau tidak sebut mobilnya di kalimat -> tombol pilih mobil, mirip
  // fitur "lokasi"). Sopir dgn trip AKTIF otomatis dijawab utk mobil trip
  // aktifnya sendiri saja, tidak perlu pilih. ----
  {
    const driverOdt = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
    const tripAktifOdt = driverOdt ? state.usage.find(u => u.driverId === driverOdt.id && u.status === 'digunakan') : null;
    const bolehAdminOdt = isAdminOrSuperAdmin(chatId);

    if (!cq && (bolehAdminOdt || tripAktifOdt)) {
      const jamParsed = parseJamQuery(text);
      if (jamParsed) {
        const { tanggal, jamStr, assumedYesterday } = resolveTanggalJamQuery(text, jamParsed.jam, jamParsed.menit);

        if (tripAktifOdt && !bolehAdminOdt) {
          // Sopir biasa -- HANYA mobil trip aktifnya sendiri, tidak perlu pilih mobil.
          const carSopirOdt = state.cars.find(c => c.id === tripAktifOdt.carId);
          if (carSopirOdt) {
            await sendTg(chatId, await odometerAtTimeText(env, carSopirOdt, tanggal, jamStr, assumedYesterday));
            return;
          }
        } else {
          // Admin/Administrator -- coba tebak mobil dari plat yg disebut di
          // kalimat; kalau ketemu persis 1 -> langsung jawab, kalau tidak
          // -> tombol pilih mobil (waktu yg diminta disisipkan di callback_data
          // supaya navigasi ini tetap STATELESS, sama pola dgn "lokasi"/"service").
          const carsGpsOdt = state.cars.filter(c => c.imeiGps);
          if (carsGpsOdt.length === 0) {
            await sendTg(chatId, '🛣️ Belum ada mobil yang terhubung IMEI GPS.id (atur di menu Data Mobil).');
            return;
          }
          const carTebakanOdt = cariMobilDariTeks(text, carsGpsOdt);
          if (carTebakanOdt) {
            await sendTg(chatId, await odometerAtTimeText(env, carTebakanOdt, tanggal, jamStr, assumedYesterday));
            return;
          }
          if (carsGpsOdt.length === 1) {
            await sendTg(chatId, await odometerAtTimeText(env, carsGpsOdt[0], tanggal, jamStr, assumedYesterday));
            return;
          }
          const jamCompact = `${String(jamParsed.jam).padStart(2, '0')}${String(jamParsed.menit).padStart(2, '0')}`;
          const tanggalCompact = tanggal.replace(/-/g, '');
          await sendTg(chatId, `🛣️ Odometer sekitar jam ${jamStr}${assumedYesterday ? ' (kemarin)' : ''} -- mobil yang mana?`, odoJamPickerRows(carsGpsOdt, jamCompact, tanggalCompact));
          return;
        }
      }
    }

    // ---- navigasi tombol pilih mobil (callback_data prefix "odt:") ----
    if (cq && bolehAdminOdt && textRaw.startsWith('odt:')) {
      const parts = textRaw.split(':');
      if (parts[1] === 'c') {
        const carIdOdt = parts[2];
        const tanggalOdt = `${parts[3].slice(0, 4)}-${parts[3].slice(4, 6)}-${parts[3].slice(6, 8)}`;
        const jamStrOdt = `${parts[4].slice(0, 2)}:${parts[4].slice(2, 4)}`;
        const carOdt = state.cars.find(c => c.id === carIdOdt);
        if (!carOdt) {
          await sendTg(chatId, '⚠️ Mobil ini sudah tidak ditemukan (mungkin sudah dihapus). Ketik ulang pertanyaan jamnya ya.');
          return;
        }
        await sendTg(chatId, await odometerAtTimeText(env, carOdt, tanggalOdt, jamStrOdt, tanggalOdt !== today()), [odoJamBackRow(parts[4], parts[3])]);
        return;
      }
      if (parts[1] === 'm') {
        const tanggalCompactOdt = parts[2];
        const jamCompactOdt = parts[3];
        const jamStrOdt = `${jamCompactOdt.slice(0, 2)}:${jamCompactOdt.slice(2, 4)}`;
        const carsGpsOdt = state.cars.filter(c => c.imeiGps);
        if (carsGpsOdt.length === 0) {
          await sendTg(chatId, '🛣️ Belum ada mobil yang terhubung IMEI GPS.id (atur di menu Data Mobil).');
          return;
        }
        await sendTg(chatId, `🛣️ Odometer sekitar jam ${jamStrOdt}${tanggalCompactOdt !== today().replace(/-/g, '') ? ' (kemarin)' : ''} -- mobil yang mana?`, odoJamPickerRows(carsGpsOdt, jamCompactOdt, tanggalCompactOdt));
        return;
      }
    }
  }

  // ============================================================================
  // BARU: Nota/Tanda Terima trip dikirim sopir sbg foto/dokumen lewat bot,
  // ditampung dulu sbg REFERENSI SAJA (file_id Telegram, BUKAN bytes-nya --
  // Telegram yang tetap menyimpan file aslinya) di trip.buktiPending, supaya
  // TIDAK membebani storage GitHub (fleetops-data.json tetap cuma berisi
  // teks). Begitu sopir ketik "kirim", semua lampiran yg terkumpul untuk
  // trip yang belum terkirim diteruskan sekaligus ke SEMUA Admin Finance
  // (state.financeAdmins -- daftar TERPISAH dari Admin Penerima Notifikasi
  // Telegram, lihat menu Pengaturan) lewat sendMediaGroup/sendDocument.
  // Kalau lupa ketik "kirim", ada pengingat otomatis 5 jam setelah trip
  // ditandai "Tiba" (lihat blok senada di runNotifyCheck()).
  // ============================================================================
  if (isMediaMsg) {
    // ---- BARU (v3.212.1): tangkap foto barcode MyPertamina KALAU chat ini
    // sedang dalam alur "atur barcode" (pendingConversations kind
    // 'qr_upload', lihat trigger "qrset:" di atas) -- HARUS diperiksa di
    // SINI, PALING ATAS blok isMediaMsg, SEBELUM logika nota/tanda terima
    // generik di bawah (yang assume SEMUA foto dari sopir = lampiran nota
    // trip) -- kalau tidak, foto barcode yang dikirim Admin/Administrator
    // akan salah nyasar jadi lampiran nota (atau malah diam-diam diabaikan
    // kalau pengirimnya bukan Sopir terdaftar, karena logika nota generik
    // itu me-return awal utk chat yang bukan Sopir).
    // CATATAN PENTING: `pendingConversations` TIDAK bisa dibaca/ditulis
    // langsung sbg variabel bebas -- itu tersimpan di notif-state.json
    // (GitHub) dan HARUS lewat pushNotifStateUpdate() supaya perubahan ikut
    // tersimpan (lihat pola yang sama di alur convo teks, baris ~4483).
    let handledAsQrUpload = false;
    // v3.259.0 -- BARU: tangkap foto STRUK BBM kalau chat ini sedang di step
    // 'sbbm_nominal' (alur "Isi BBM Luar Trip") -- HARUS diperiksa di SINI,
    // sebelum logika nota/tanda terima generik di bawah, pola SAMA dgn
    // interception barcode qr_upload persis di bawah ini -- kalau tidak,
    // foto struk yang dikirim sopir akan salah nyasar jadi lampiran nota
    // generik alih-alih dibaca lewat OCR. Lihat ocrReceiptNominal().
    let handledAsBbmOcrPhoto = false;
    if (msg.photo && msg.photo.length > 0) {
      await pushNotifStateUpdate(env, async (pendingConversations) => {
        const convoBbm = pendingConversations[chatId];
        if (!(convoBbm && convoBbm.kind === 'isi_bbm' && convoBbm.step === 'sbbm_nominal')) return;
        handledAsBbmOcrPhoto = true;
        const fileIdBbm = msg.photo[msg.photo.length - 1].file_id;
        await sendTg(chatId, '🔎 Membaca nominal dari foto struk...');
        const hasilOcr = await ocrReceiptNominal(env, fileIdBbm);
        if (hasilOcr == null) {
          await sendTg(chatId, '⚠️ Tidak bisa membaca nominal dari foto ini (mungkin kurang jelas/silau/fitur belum aktif). Coba foto ulang yang lebih jelas, atau ketik nominalnya manual (contoh: 150000).');
          return; // convo TETAP di step sbbm_nominal -- sopir bisa coba lagi atau ketik manual
        }
        convoBbm.step = 'sbbm_nominal_ocr_confirm';
        convoBbm.ocrNominalGuess = hasilOcr;
        await sendTg(chatId, `📷 Dari foto ini saya baca nominalnya: <b>Rp ${hasilOcr.toLocaleString('id-ID')}</b>.\n\nBenar? Ketik <b>ya</b> kalau benar, atau ketik angka yang benar kalau saya salah baca.`, [[{ text: '✅ Ya, benar', callback_data: 'sbbm:ocrok' }]]);
      });
    }
    if (handledAsBbmOcrPhoto) return;
    if (msg.photo && msg.photo.length > 0) {
      await pushNotifStateUpdate(env, async (pendingConversations) => {
        const convoQr = pendingConversations[chatId];
        if (!(convoQr && convoQr.kind === 'qr_upload')) return;
        handledAsQrUpload = true;
        if (!isAdminOrSuperAdmin(chatId)) { delete pendingConversations[chatId]; return; } // jaga-jaga kalau izin dicabut di tengah alur
        const carQrTarget = state.cars.find(c => c.id === convoQr.carId);
        if (!carQrTarget) {
          delete pendingConversations[chatId];
          await sendTg(chatId, '⚠️ Mobil tujuan tidak ditemukan (mungkin sudah dihapus) -- ketik "atur barcode" lagi ya.');
          return;
        }
        const fileIdQr = msg.photo[msg.photo.length - 1].file_id;
        const carIdQrSave = convoQr.carId;
        const hasilSimpanQr = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
          const carsArr = freshRaw.data.cars || [];
          const c = carsArr.find(x => x.id === carIdQrSave);
          if (!c) return false;
          c.qrPertaminaFileId = fileIdQr;
          c.qrPertaminaSetAt = Date.now();
          // v3.272.0 -- PERBAIKAN BUG PENTING: `updatedAt` mobil ini TIDAK
          // pernah ikut di-update di sini sebelumnya. Sinkronisasi cloud di
          // index.html (mergeCollection) menggabungkan data PER RECORD
          // berdasarkan field `updatedAt` yang PALING BARU -- kalau field
          // ini dibiarkan lama, versi lokal (browser/HP) manapun yang tidak
          // punya barcode ini dianggap "lebih baru" begitu device itu
          // sinkron ke cloud, lalu barcode yang baru disimpan lewat Telegram
          // ini TERTIMPA HILANG lagi (biasanya dalam hitungan hari, begitu
          // ada device yang sinkron). Menyamakan pola dgn touch() di
          // index.html supaya perubahan lewat bot ini juga dianggap paling
          // baru & tidak lagi kalah/hilang saat sinkron.
          c.updatedAt = Date.now();
          return true;
        });
        delete pendingConversations[chatId];
        await sendTg(chatId, hasilSimpanQr.ok
          ? `✅ Barcode MyPertamina untuk <b>${escapeHtmlTg(carLabel(carIdQrSave))}</b> tersimpan. Ketik <b>barcode</b> kapan saja untuk memanggilnya lagi.`
          : '❌ Gagal menyimpan barcode ini -- coba ketik "atur barcode" lagi ya.');
      });
    }
    if (handledAsQrUpload) return;
    const driverPengirim = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
    if (!driverPengirim) return; // bukan sopir terdaftar -> diam-diam diabaikan, sama pola dgn perintah lain
    // Sasaran lampiran: trip yg SEDANG berjalan milik sopir ini, atau kalau
    // tidak ada, trip yg BARU SAJA ditutup ("selesai") tapi buktinya belum
    // terkirim -- supaya sopir masih bisa nyusulin nota walau sudah ketik "tiba".
    let tripTarget = state.usage.find(u => u.driverId === driverPengirim.id && u.status === 'digunakan');
    if (!tripTarget) {
      tripTarget = state.usage
        .filter(u => u.driverId === driverPengirim.id && u.status === 'selesai' && !u.buktiTerkirimAt)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    }
    if (!tripTarget) {
      await sendTg(chatId, '⚠️ Tidak ada trip aktif atau baru selesai yang bisa dilampiri nota/tanda terima. Mulai trip dulu lewat aplikasi.');
      return;
    }
    const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    const kind = msg.photo ? 'photo' : 'document';
    const caption = (msg.caption || '').trim();
    const tripIdTarget = tripTarget.id;
    let totalSetelah = 0;
    const hasilSimpanBukti = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      const usageArr = freshRaw.data.usage || [];
      const t = usageArr.find(u => u.id === tripIdTarget);
      if (!t || t.buktiTerkirimAt) return false;
      if (!Array.isArray(t.buktiPending)) t.buktiPending = [];
      t.buktiPending.push({ fileId, kind, caption, at: Date.now() });
      t.updatedAt = Date.now();
      totalSetelah = t.buktiPending.length;
      return true;
    });
    if (hasilSimpanBukti.ok) {
      await sendTg(chatId, `📎 Diterima (lampiran ke-${totalSetelah} untuk trip ini). Kirim lagi kalau masih ada, atau ketik <b>kirim</b> kalau nota/tanda terimanya sudah lengkap semua.`);
    } else {
      await sendTg(chatId, '❌ Gagal menyimpan lampiran ini -- coba kirim ulang foto/dokumennya ya.');
    }
    return;
  }

  // ---- BARU: fungsi bersama -- teruskan nota/tanda terima trip TERTENTU (atau
  // semua yg pending) milik 1 sopir ke Admin Finance. Dipakai baik dari ketik
  // teks "kirim" (semua trip pending) MAUPUN dari tap tombol "✅ Kirim Sekarang"
  // di pesan konfirmasi otomatis saat trip ditutup (1 trip spesifik, lihat
  // callback "kirimnota:<tripId>" di bawah). SENGAJA hanya trip OPERASIONAL
  // (jenisPenggunaan !== 'pribadi') yang pernah diteruskan ke Finance -- trip
  // Pribadi tidak pernah dikirim ke Admin Finance sama sekali walau ada
  // lampiran/biaya tercatat. ----
  // BARU (v3.186.0): pecah array item media jadi grup 2-10 item (batas
  // sendMediaGroup Telegram: MINIMAL 2, MAKSIMAL 10 -- mengirim grup isi 1
  // item DITOLAK Telegram dgn error "Group of at least 2 items expected").
  // Kalau pemecahan rata per `maxSize` menyisakan PAS 1 item di grup
  // terakhir, 1 item dipindah dari grup sebelumnya supaya grup terakhir
  // jadi 2 (bukan 1) -- tanpa ini, kombinasi jumlah item tertentu (mis.
  // 11 foto: resi + 10 nota) akan menyisakan grup terakhir 1 foto & gagal.
  function chunkMediaGroup(items, maxSize = 10) {
    const chunks = [];
    for (let i = 0; i < items.length; i += maxSize) chunks.push(items.slice(i, i + maxSize));
    if (chunks.length > 1 && chunks[chunks.length - 1].length === 1) {
      const pindahan = chunks[chunks.length - 2].pop();
      chunks[chunks.length - 1].unshift(pindahan);
    }
    return chunks;
  }

  async function kirimNotaKeFinance(driverPengirim, tripsUntukDikirim) {
    // v3.181.0 -- gerbang "harus JUGA terdaftar sbg Sopir/Admin" DIHAPUS atas
    // permintaan eksplisit -- Admin Finance sekarang independen sepenuhnya,
    // cukup terdaftar & terisi Chat ID di menu Admin Finance saja.
    const financeAdminsAktif = (state.financeAdmins || []).filter(a => a.chatId);
    if (!tripsUntukDikirim.length) return { status: 'kosong' };
    if (!financeAdminsAktif.length) return { status: 'nofinance' };
    for (const trip of tripsUntukDikirim) {
      const notaItems = Array.isArray(trip.buktiPending) ? trip.buktiPending : [];
      const notaPhotos = notaItems.filter(b => b.kind === 'photo');
      const docs = notaItems.filter(b => b.kind === 'document');
      // BARU (v3.186.0): gambar "Tanda Terima Perjalanan" (kartu ringkasan,
      // di-render html2canvas di BROWSER sopir lalu disimpan sbg
      // trip.resiImageFileId oleh sendInstantTripReceipt() di index.html)
      // digabung jadi 1 PAKET yang SAMA dgn nota di sini -- BUKAN pesan
      // terpisah -- supaya Finance tidak menerima 2 notifikasi utk 1 trip
      // yang sama. Cukup pakai file_id-nya lagi, tidak upload ulang bytes.
      const resiItem = trip.resiImageFileId ? { fileId: trip.resiImageFileId } : null;
      const semuaFotoUntukFinance = [...(resiItem ? [resiItem] : []), ...notaPhotos];
      const headerText = `📎 <b>${escapeHtmlTg(driverPengirim.nama)}</b> — trip selesai\n${escapeHtmlTg(carLabel(trip.carId))} — ${escapeHtmlTg(trip.tujuan || '-')}\n${escapeHtmlTg(trip.tglKeluar || '-')} s/d ${escapeHtmlTg(trip.tglKembali || '-')}` +
        (notaItems.length > 0 ? ` · ${notaItems.length} lampiran nota` : '') +
        (resiItem ? `${notaItems.length > 0 ? ' +' : ' ·'} Tanda Terima Perjalanan` : '');
      for (const fa of financeAdminsAktif) {
        await sendTg(fa.chatId, headerText);
        if (semuaFotoUntukFinance.length === 1) {
          // Cuma 1 foto (paling sering: baru Tanda Terima, belum ada nota
          // menyusul) -- sendMediaGroup DITOLAK kalau isinya 1 item, jadi
          // pakai sendPhoto biasa.
          try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: fa.chatId, photo: semuaFotoUntukFinance[0].fileId }),
            });
          } catch (e) { console.log('webhook: gagal sendPhoto (tunggal) ke', fa.chatId, e.message); }
        } else if (semuaFotoUntukFinance.length > 1) {
          for (const chunk of chunkMediaGroup(semuaFotoUntukFinance, 10)) {
            try {
              await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMediaGroup`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: fa.chatId,
                  media: chunk.map(b => ({ type: 'photo', media: b.fileId, ...(b.caption ? { caption: b.caption } : {}) })),
                }),
              });
            } catch (e) { console.log('webhook: gagal sendMediaGroup nota ke', fa.chatId, e.message); }
          }
        }
        for (const d of docs) {
          try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: fa.chatId, document: d.fileId, ...(d.caption ? { caption: d.caption } : {}) }),
            });
          } catch (e) { console.log('webhook: gagal sendDocument nota ke', fa.chatId, e.message); }
        }
      }
    }
    const tripIdsTerkirim = tripsUntukDikirim.map(t => t.id);
    const hasilTandaiKirim = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      const usageArr = freshRaw.data.usage || [];
      let ada = false;
      tripIdsTerkirim.forEach(id => {
        const t = usageArr.find(u => u.id === id);
        if (t && !t.buktiTerkirimAt) { t.buktiTerkirimAt = Date.now(); t.buktiPending = []; t.updatedAt = Date.now(); ada = true; }
      });
      return ada;
    });
    return { status: hasilTandaiKirim.ok ? 'ok' : 'gagaltandai', count: tripsUntukDikirim.length };
  }

  // ---- BARU: "kirim" -- teruskan semua nota/tanda terima OPERASIONAL yg terkumpul ke Admin Finance ----
  if (!cq && text === 'kirim') {
    const driverPengirim = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
    if (!driverPengirim) return; // chat tak dikenal -> diam-diam diabaikan
    // v3.186.0 -- SEBELUMNYA cuma trip yg punya buktiPending yg dianggap
    // "ada yg dikirim". Sekarang trip dgn resiImageFileId (Tanda Terima
    // sudah terkirim ke sopir, tapi belum diteruskan ke Finance) juga ikut,
    // walau belum ada nota sama sekali -- lihat kirimNotaKeFinance().
    const tripsUntukDikirim = state.usage.filter(u => u.driverId === driverPengirim.id && u.jenisPenggunaan !== 'pribadi' && !u.buktiTerkirimAt && ((Array.isArray(u.buktiPending) && u.buktiPending.length > 0) || u.resiImageFileId));
    const hasil = await kirimNotaKeFinance(driverPengirim, tripsUntukDikirim);
    if (hasil.status === 'kosong') {
      await sendTg(chatId, 'Belum ada nota/tanda terima yang menunggu dikirim. Kirim dulu fotonya, baru ketik "kirim". (Trip Pribadi tidak dikirim ke Admin Finance.)');
      return;
    }
    if (hasil.status === 'nofinance') {
      await sendTg(chatId, '⚠️ Belum ada Admin Finance terdaftar di aplikasi -- hubungi admin dulu ya, lampiran Anda tetap aman tersimpan menunggu dikirim.');
      return;
    }
    await sendTg(chatId, hasil.status === 'ok'
      ? `✅ Nota/tanda terima ${hasil.count > 1 ? `(${hasil.count} trip) ` : ''}berhasil dikirim ke Admin Finance. Terima kasih! 🙏`
      : '⚠️ Sudah terkirim ke Admin Finance, tapi gagal menandai selesai di server -- ketik "kirim" sekali lagi supaya tidak terkirim dobel.');
    return;
  }

  // ---- BARU: tombol "✅ Nota Sudah Lengkap, Kirim Sekarang" pada pesan
  // konfirmasi otomatis begitu trip OPERASIONAL ditutup lewat aplikasi
  // (lihat sendInstantNotaConfirmAsk() di index.html) -- callback_data
  // "kirimnota:<tripId>". Ditangani PERSIS seperti ketik "kirim", tapi
  // discope ke 1 trip itu saja (bukan semua trip pending sopir ybs). ----
  if (cq && text.startsWith('kirimnota:')) {
    const tripId = textRaw.slice('kirimnota:'.length).trim();
    const driverPengirim = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
    if (!driverPengirim) return;
    const trip = state.usage.find(u => u.id === tripId && u.driverId === driverPengirim.id);
    if (!trip || trip.jenisPenggunaan === 'pribadi' || trip.buktiTerkirimAt) {
      await sendTg(chatId, '⚠️ Trip ini sudah tidak bisa dikirim lewat tombol (mungkin sudah terkirim, trip Pribadi, atau sudah dihapus). Ketik "kirim" untuk trip lain yang masih pending.');
      return;
    }
    // v3.186.0 -- trip dgn resiImageFileId (Tanda Terima) ikut dianggap
    // "ada yg dikirim" walau belum ada nota sama sekali -- lihat catatan
    // senada di blok "kirim" (ketik manual) di atas.
    const tripsUntukDikirim = ((Array.isArray(trip.buktiPending) && trip.buktiPending.length > 0) || trip.resiImageFileId) ? [trip] : [];
    const hasil = await kirimNotaKeFinance(driverPengirim, tripsUntukDikirim);
    if (hasil.status === 'kosong') {
      await sendTg(chatId, 'Belum ada foto/dokumen nota yang terlampir untuk trip ini -- kirim dulu fotonya ke chat ini, baru ketik "kirim".');
      return;
    }
    if (hasil.status === 'nofinance') {
      await sendTg(chatId, '⚠️ Belum ada Admin Finance terdaftar di aplikasi -- hubungi admin dulu ya, lampiran Anda tetap aman tersimpan menunggu dikirim.');
      return;
    }
    await sendTg(chatId, hasil.status === 'ok'
      ? '✅ Nota/tanda terima trip ini berhasil dikirim ke Admin Finance. Terima kasih! 🙏'
      : '⚠️ Sudah terkirim ke Admin Finance, tapi gagal menandai selesai di server -- ketik "kirim" sekali lagi supaya tidak terkirim dobel.');
    return;
  }

  await pushNotifStateUpdate(env, async (pendingConversations) => {
    const convo = pendingConversations[chatId];

    if (convo && batalAliases().includes(text)) {
      delete pendingConversations[chatId];
      await sendTg(chatId, '❌ Dibatalkan. Ketik "akhiri trip" lagi kapan pun kalau mau lapor ulang.');
      return;
    }

    if (!convo) {
      // ---- BARU: "menu" -> kembali ke Menu Utama bot. Dipakai tombol
      // "🏠 Menu Utama" (callback_data "cmd:menu", lewat mekanisme "cmd:" di
      // atas yang memperlakukan tap tombol PERSIS spt ketik teksnya) yang
      // ditambahkan di menu-menu yang punya submenu (Servis & Maintenance,
      // Saldo, dst) supaya selalu ada jalan kembali ke Menu Utama. ----
      if (!cq && menuAliases().includes(text)) {
        if (actorNameForChat(chatId) === 'Telegram' && !isSaldoAllowedUser(chatId) && !isSuperAdminChat(chatId)) return; // chat tak dikenal -> diam-diam diabaikan
        await sendTg(chatId, '📋 <b>Menu Utama</b>\nPilih salah satu:', menuCommandKeyboard(chatId));
        return;
      }

      // ---- BARU (v3.173.0): "rekomendasi" -> versi LENGKAP daftar perintah
      // dgn deskripsi & link "/perintah" yang bisa langsung di-tap (lihat
      // commandReferenceMessage() & syncBotCommandsForChat() di atas).
      // Dipicu tombol "📋 Rekomendasi Perintah" (selalu ada di
      // menuCommandKeyboard()) atau ketik manual "rekomendasi". ----
      if (!cq && rekomendasiAliases().includes(text)) {
        if (actorNameForChat(chatId) === 'Telegram' && !isSaldoAllowedUser(chatId) && !isSuperAdminChat(chatId)) return; // chat tak dikenal -> diam-diam diabaikan
        await syncBotCommandsForChat(chatId);
        await sendTg(chatId, commandReferenceMessage(chatId), [[{ text: '🏠 Menu Utama', callback_data: 'cmd:menu' }]]);
        return;
      }

      // v3.259.0 -- BARU: input 1-baris bahasa natural -- pintasan utk yang
      // sudah hafal pola, ketik langsung "bensin 50000" atau "isi bensin
      // 50rb" tanpa lewat tanya-jawab bertahap "isi" -> pilih Isi BBM ->
      // pilih mobil -> ... -> baru ditanya nominal. Cuma nominalnya yang
      // dipintas (field WAJIB paling gampang diketik cepat) -- field lain
      // (mobil, tanggal, jenis BBM, level bensin) TETAP ditanya normal spt
      // biasa -- SENGAJA tidak sekaligus memintas SEMUA field dalam 1 pesan
      // (terlalu riskan salah tafsir utk data finansial + banyak field
      // wajib berurutan). Kalau pesannya TIDAK cocok pola ini, jatuh
      // diam-diam ke pemrosesan biasa di bawah (murni pintasan opsional,
      // BUKAN pengganti alur "isi" yang sudah ada).
      const shortcutBbmMatch = !cq ? text.match(/^(?:isi\s+)?(?:bensin|bbm)\s+([\d.,]+)\s*(rb|ribu|k|jt|juta)?$/i) : null;
      if (shortcutBbmMatch) {
        if (actorNameForChat(chatId) === 'Telegram') return; // chat tak dikenal -> diam-diam diabaikan, sama pola dgn "isi"
        let angkaShortcut = Number(shortcutBbmMatch[1].replace(/[^\d]/g, ''));
        const satuanShortcut = (shortcutBbmMatch[2] || '').toLowerCase();
        if (satuanShortcut === 'rb' || satuanShortcut === 'ribu' || satuanShortcut === 'k') angkaShortcut *= 1000;
        else if (satuanShortcut === 'jt' || satuanShortcut === 'juta') angkaShortcut *= 1000000;
        if (isFinite(angkaShortcut) && angkaShortcut > 0) {
          if (state.cars.length === 0) { await sendTg(chatId, '⚠️ Belum ada mobil terdaftar di aplikasi.'); return; }
          pendingConversations[chatId] = { kind: 'isi_bbm', step: 'sbbm_car', startedAt: Date.now(), petugas: actorNameForChat(chatId), prefilledNominal: angkaShortcut };
          if (state.cars.length === 1) {
            const satuSatunyaMobilShortcut = state.cars[0];
            pendingConversations[chatId].carId = satuSatunyaMobilShortcut.id;
            pendingConversations[chatId].step = 'sbbm_tanggal';
            await sendTg(chatId, `⛽ Oke, nominal Rp ${angkaShortcut.toLocaleString('id-ID')} dicatat. Mobil otomatis dipilih (cuma ada 1): <b>${escapeHtmlTg(carLabel(satuSatunyaMobilShortcut.id))}</b>.\n\n📅 Tanggal pengisian? Ketik <b>hari ini</b>, atau tanggal (mis. 2026-07-30, 30/7/2026, 30 Juli 2026).`, [[{ text: '📅 Hari ini', callback_data: 'sbbm:tgl:hari_ini' }]]);
            return;
          }
          await sendTg(chatId, `⛽ Oke, nominal Rp ${angkaShortcut.toLocaleString('id-ID')} dicatat. Mobil mana yang diisi bensin?`, carPickerRows('sbbm:car:'));
          return;
        }
      }

      // ---- BARU: "isi" -> menu Isi BBM / Isi Saldo E-Toll (luar trip) ----
      if (!cq && text === 'isi') {
        if (actorNameForChat(chatId) === 'Telegram') return; // chat tak dikenal (bukan sopir/admin terdaftar) -> diam-diam diabaikan, sama pola dgn "tiba"/"saldo"
        await sendTg(chatId, '⛽ Mau catat isi apa?', [[
          { text: '⛽ Isi BBM', callback_data: 'isi:bbm' },
          { text: '💳 Isi Saldo E-Toll', callback_data: 'isi:etoll' },
        ], [
          { text: '🏠 Menu Utama', callback_data: 'cmd:menu' },
        ]]);
        return;
      }
      if (cq && text === 'isi:bbm') {
        if (state.cars.length === 0) { await sendTg(chatId, '⚠️ Belum ada mobil terdaftar di aplikasi.'); return; }
        pendingConversations[chatId] = { kind: 'isi_bbm', step: 'sbbm_car', startedAt: Date.now(), petugas: actorNameForChat(chatId) };
        // v3.256.0 -- BARU: pengaturan umum "auto-pilih mobil kalau cuma 1"
        // diperluas ke alur ini (sebelumnya baru "Mulai Trip") -- lihat
        // autoSelectSingleCar() di index.html & catatan pola di worker.js
        // blok "Mulai Trip" utk alasan lengkap. Beda dari "Mulai Trip": di
        // sini SEMUA mobil dihitung (bukan cuma yg "tersedia") karena isi
        // BBM tidak peduli status pakai mobil.
        if (state.cars.length === 1) {
          const satuSatunyaMobilBbm = state.cars[0];
          pendingConversations[chatId].carId = satuSatunyaMobilBbm.id;
          pendingConversations[chatId].step = 'sbbm_tanggal';
          await sendTg(chatId, `🚗 Mobil otomatis dipilih (cuma ada 1): <b>${escapeHtmlTg(carLabel(satuSatunyaMobilBbm.id))}</b>.\n\n📅 Tanggal pengisian? Ketik <b>hari ini</b>, atau tanggal (mis. 2026-07-30, 30/7/2026, 30 Juli 2026).`, [[{ text: '📅 Hari ini', callback_data: 'sbbm:tgl:hari_ini' }]]);
          return;
        }
        await sendTg(chatId, '🚗 Mobil mana yang diisi bensin?', carPickerRows('sbbm:car:'));
        return;
      }
      if (cq && text === 'isi:etoll') {
        if (state.etollCards.length === 0) { await sendTg(chatId, '⚠️ Belum ada Kartu E-Toll terdaftar -- tambah dulu di menu Kartu E-Toll pada aplikasi.'); return; }
        pendingConversations[chatId] = { kind: 'isi_etoll', step: 'setl_card', startedAt: Date.now(), petugas: actorNameForChat(chatId) };
        await sendTg(chatId, '💳 Kartu E-Toll mana yang di-top up?', etollCardPickerRows());
        return;
      }

      // ---- BARU: "booking"/"pesan"/"boking"/"keep" -> buat Booking Mobil
      // baru langsung dari chat (status awal SELALU 'menunggu' persetujuan
      // admin -- SAMA PERSIS dgn alur approval yang sudah ada di
      // openBookingModal()/sendBookingApprovalRequest(), TIDAK diubah). ----
      if (!cq && bookingAliases().includes(text)) {
        // Prioritas identitas: kalau chatId ini terdaftar sbg SOPIR, dia
        // dianggap sopir (driverId auto-terisi dirinya sendiri) WALAUPUN
        // chatId yg sama juga terdaftar sbg admin. Baru kalau bukan sopir
        // sama sekali, dicek apakah admin.
        const driverActor = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
        const jugaTerdaftarAdmin = (state.notifAdmins || []).some(a => (a.chatId || '').toString().trim() === chatId);
        const adminActor = !driverActor ? (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === chatId) : null;
        if (!driverActor && !adminActor) return; // chat tak dikenal -> diam-diam diabaikan
        if (state.cars.length === 0) { await sendTg(chatId, '⚠️ Belum ada mobil terdaftar di aplikasi.'); return; }
        pendingConversations[chatId] = {
          kind: 'booking', step: 'bkg_car', startedAt: Date.now(),
          petugas: driverActor ? driverActor.nama : (adminActor.nama || 'Admin'),
          driverId: driverActor ? driverActor.id : null,
          driverNama: driverActor ? driverActor.nama : null,
          // v3.171.0 -- kalau yg bikin booking ini SOPIR yang chatId-nya
          // KEBETULAN juga terdaftar sbg admin approval, dia "berganti status"
          // jadi sopir biasa utk booking ini -- tidak boleh jadi approver
          // booking miliknya sendiri. excludeApproverChatId dipakai nanti di
          // sendBookingApprovalToAdminsTg() utk mencoret dia dari daftar
          // admin yang dikirimi tombol Setuju/Tolak.
          excludeApproverChatId: (driverActor && jugaTerdaftarAdmin) ? chatId : null,
        };
        // v3.256.0 -- BARU: pola sama dgn Isi BBM/Mulai Trip -- lihat catatan
        // lengkap di blok "Mulai Trip". Booking pakai SEMUA mobil (bukan cuma
        // "tersedia") -- booking untuk jadwal MASA DEPAN, status pakai mobil
        // SEKARANG tidak relevan (konflik jadwal tetap dicek terpisah nanti
        // di finalizeBooking()).
        if (state.cars.length === 1) {
          const satuSatunyaMobilBkg = state.cars[0];
          pendingConversations[chatId].carId = satuSatunyaMobilBkg.id;
          pendingConversations[chatId].step = 'bkg_jenis';
          await sendTg(chatId, `🚗 Mobil otomatis dipilih (cuma ada 1): <b>${escapeHtmlTg(carLabel(satuSatunyaMobilBkg.id))}</b>.\n\n📦 Keperluannya apa?`, [[
            { text: '📦 Pengiriman (operasional)', callback_data: 'bkg:jenis:pengiriman' },
            { text: '🏠 Pribadi', callback_data: 'bkg:jenis:pribadi' },
          ]]);
          return;
        }
        await sendTg(chatId, '🚗 Mobil mana yang mau di-booking?', carPickerRows('bkg:car:'));
        return;
      }

      // ---- BARU: "batalkan booking"/"batal booking"/dst -> daftar booking
      // AKTIF (status 'menunggu' atau 'dipesan', BELUM 'ditolak'/'dibatalkan'/
      // 'selesai') yang boleh dibatalkan chat ini, lalu tap salah satu utk
      // langsung membatalkannya (callback_data "batalbk:<bookingId>", lihat
      // handler-nya dekat blok "bkh1:batal:" -- logika ubah status SAMA
      // PERSIS dgn cancelBooking() di index.html). Sopir HANYA lihat booking
      // miliknya sendiri (driverId cocok); Admin/Administrator lihat SEMUA
      // booking aktif (sama seperti mereka boleh approve/tolak booking siapa
      // pun) -- pola otorisasi ini SENGAJA lebih longgar utk Admin drpd
      // "bkh1:batal:" (yang cuma boleh 1 chat spesifik) karena di sini
      // memang menu kelola booking utk Admin, bukan balasan reminder
      // otomatis ke 1 orang. ----
      if (!cq && batalBookingAliases().includes(text)) {
        const driverActorBb = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
        const adminActorBb = (state.notifAdmins || []).find(a => (a.chatId || '').toString().trim() === chatId) || (isAdminOrSuperAdmin(chatId) ? true : null);
        if (!driverActorBb && !adminActorBb) return; // chat tak dikenal -> diam-diam diabaikan, sama pola dgn "booking"
        const aktif = (state.bookings || []).filter(b => b.status === 'menunggu' || b.status === 'dipesan');
        const daftarBb = driverActorBb && !adminActorBb
          ? aktif.filter(b => b.driverId === driverActorBb.id)
          : aktif; // admin/notifAdmin/Administrator -> semua booking aktif
        if (daftarBb.length === 0) {
          await sendTg(chatId, 'ℹ️ Tidak ada booking aktif yang bisa dibatalkan saat ini.');
          return;
        }
        const rowsBb = daftarBb.slice(0, 20).map(b => [{
          text: `${b.status === 'menunggu' ? '⏳' : '📅'} ${carLabel(b.carId)} — ${b.tujuan || '-'} (${b.tglMulai})`,
          callback_data: `batalbk:${b.id}`,
        }]);
        await sendTg(chatId, '❌ Pilih booking yang mau dibatalkan:', withBatal(rowsBb));
        return;
      }

      // ---- BARU: "biaya"/"operasional"/"pribadi" -> menu Biaya Operasional/
      // Pribadi, HANYA kalau sopir ini sedang punya trip berjalan ----
      if (!cq && biayaAliases().includes(text)) {
        const driverBop = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
        if (!driverBop) return;
        const tripAktifBop = state.usage.find(u => u.driverId === driverBop.id && u.status === 'digunakan');
        if (!tripAktifBop) {
          await sendTg(chatId, '⚠️ Tidak ada trip yang sedang berjalan atas nama Anda -- menu Biaya cuma bisa dipakai selagi trip aktif. Kalau ini keliru, cek langsung di aplikasi.');
          return;
        }
        const isPribadiBop = tripAktifBop.jenisPenggunaan === 'pribadi';
        pendingConversations[chatId] = {
          kind: 'biaya_op', tripId: tripAktifBop.id, carId: tripAktifBop.carId,
          driverNama: driverBop.nama, isPribadi: isPribadiBop, items: [],
          step: 'bop_menu', startedAt: Date.now(),
        };
        await sendTg(chatId, biayaOpMenuText(isPribadiBop), biayaOpMenuKeyboard());
        return;
      }

      // ---- BARU: "mulai trip"/"mulai"/"jalan"/"berangkat"/"catat perjalanan"
      // -> alur Catat Perjalanan (Berangkat) lewat chat, PASANGAN dari alur
      // "tiba" (tutup trip) yang sudah ada -- HANYA sopir terdaftar, sama
      // seperti pengecekan driver di handler "tiba". ----
      if (!cq && mulaiTripAliases().includes(text)) {
        const driverMt = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
        if (!driverMt) return; // chat tak dikenal -> diam-diam diabaikan, sama pola dgn "tiba"
        const tripAktifMt = state.usage.find(u => u.driverId === driverMt.id && u.status === 'digunakan');
        if (tripAktifMt) {
          await sendTg(chatId, `⚠️ Anda masih punya trip yang sedang berjalan (${escapeHtmlTg(carLabel(tripAktifMt.carId))} — ${escapeHtmlTg(tripAktifMt.tujuan || '-')}).\n\nTutup dulu trip itu dengan ketik <b>akhiri trip</b>, baru bisa mulai trip baru.`);
          return;
        }
        if (state.cars.length === 0) { await sendTg(chatId, '⚠️ Belum ada mobil terdaftar di aplikasi.'); return; }
        const availableCarsMt = state.cars.filter(c => !state.usage.some(u => u.carId === c.id && u.status === 'digunakan'));
        if (availableCarsMt.length === 0) {
          await sendTg(chatId, '⚠️ Semua mobil sedang dipakai saat ini -- tidak ada yang bisa dipilih. Cek lagi nanti atau lihat langsung di aplikasi.');
          return;
        }
        pendingConversations[chatId] = {
          kind: 'mulai_trip', step: 'mt_car', startedAt: Date.now(),
          driverId: driverMt.id, driverNama: driverMt.nama,
        };
        // v3.253.0 -- BARU: pengaturan umum "auto-pilih mobil kalau cuma 1"
        // (pasangan dari autoSelectSingleCar() di index.html, versi web) --
        // kalau CUMA ADA 1 mobil yang tersedia (tidak sedang dipakai),
        // langsung dianggap terpilih tanpa perlu sopir tap tombol dulu --
        // hemat 1 langkah percakapan. Kalau lebih dari 1 mobil tersedia,
        // perilaku SAMA PERSIS seperti sebelumnya (tampilkan tombol
        // pilihan). Pesan & keyboard lanjutan (jenis perjalanan) SENGAJA
        // disalin persis dari handler step 'mt_car' di bawah (bukan
        // dipanggil ulang lewat fungsi bersama) supaya langkah ini tetap
        // bisa dibaca urut dari atas ke bawah tanpa lompat -- kalau
        // langkah "jenis perjalanan" berubah suatu saat, cukup ingat ada
        // 2 tempat yang harus disamakan (di sini & di handler 'mt_car').
        if (availableCarsMt.length === 1) {
          const satuSatunyaMobil = availableCarsMt[0];
          pendingConversations[chatId].carId = satuSatunyaMobil.id;
          pendingConversations[chatId].step = 'mt_jenis';
          await sendTg(chatId, `🚗 Mobil otomatis dipilih (cuma ada 1 yang tersedia): <b>${escapeHtmlTg(carLabel(satuSatunyaMobil.id))}</b>.\n\n📦 Jenis perjalanannya apa?`, withBatal([[
            { text: '📦 Pengiriman (operasional)', callback_data: 'mt:jenis:pengiriman' },
            { text: '🏠 Pribadi', callback_data: 'mt:jenis:pribadi' },
          ]]));
          return;
        }
        const rowsMobilTersedia = availableCarPickerRows('mt:car:');
        await sendTg(chatId, '🚗 Mobil mana yang mau dipakai?', withBatal(rowsMobilTersedia));
        return;
      }

      // ---- RAHASIA: PIN Kelola Admin -> menu kelola Administrator. SENGAJA
      // TIDAK pernah disebut di unknownCommandMessage() manapun -- lihat
      // catatan di definisi fungsi itu. Cuma aktif kalau chat sedang idle
      // (blok "!convo" ini), supaya PIN yg kebetulan diketik di tengah
      // proses lain (mis. odometer) tidak ke-nyasar jadi trigger ini.
      // v3.211.1 -- SEBELUMNYA PIN ini ditulis langsung di kode (hardcode),
      // sekarang jadi Cloudflare Secret FLEETOPS_TELEGRAM_ADMINISTRATOR_PIN (SAMA
      // pola dgn FLEETOPS_OPERATOR_PIN/FLEETOPS_INSIGHT_PIN) -- supaya bisa
      // diganti kapan saja lewat dashboard Cloudflare TANPA perlu edit kode
      // & deploy ulang. Kalau secret ini belum diisi di Cloudflare, trigger
      // ini otomatis TIDAK PERNAH cocok (aman, bukan kosong == kosong). ----
      const kelolaAdminPin = env.FLEETOPS_TELEGRAM_ADMINISTRATOR_PIN || "";
      if (!cq && kelolaAdminPin && textRaw.trim() === kelolaAdminPin) {
        await sendTg(chatId, '🔐 Menu Administrator:', [
          [{ text: '➕ Daftarkan Chat ID ini', callback_data: 'sa:add:self' }],
          [{ text: '➕ Daftarkan Chat ID lain', callback_data: 'sa:add:other' }],
          [{ text: '➖ Hapus Administrator', callback_data: 'sa:remove:menu' }],
          [{ text: '💰 Daftarkan Admin Finance', callback_data: 'fa:add' }],
          [{ text: '🔔 Daftarkan Admin Notifikasi', callback_data: 'na:add' }],
          [{ text: '✖️ Batal', callback_data: 'sa:cancel' }],
        ]);
        return;
      }
      if (cq && text === 'sa:cancel') {
        await sendTg(chatId, '✖️ Dibatalkan.');
        return;
      }
      if (cq && text === 'sa:add:self') {
        // BARU -- cek dulu sebelum menyimpan, supaya kalau Chat ID ini
        // ternyata SUDAH terdaftar, respon bilang itu dengan jelas (bukan
        // pesan "sekarang terdaftar" yang generik & bisa membingungkan --
        // seolah baru saja ditambahkan padahal sudah lama ada).
        const sudahAdaSelf = (state.superAdmins || []).some(a => (a.chatId || '').toString().trim() === chatId);
        if (sudahAdaSelf) {
          await sendTg(chatId, `ℹ️ Chat ID ini (${chatId}) sudah terdaftar sebagai Administrator sebelumnya -- tidak didaftarkan ulang.`);
          return;
        }
        const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
          freshRaw.data.superAdmins = freshRaw.data.superAdmins || [];
          if (!freshRaw.data.superAdmins.some(a => (a.chatId || '').toString().trim() === chatId)) {
            freshRaw.data.superAdmins.push({ id: 'SA-' + Date.now(), chatId, addedAt: Date.now() });
          }
          return true;
        });
        await sendTg(chatId, hasil.ok ? `✅ Chat ID ini (${chatId}) sekarang terdaftar sebagai Administrator.` : '❌ Gagal menyimpan, coba lagi.');
        return;
      }
      if (cq && text === 'sa:add:other') {
        pendingConversations[chatId] = { kind: 'sa_add', step: 'sa_add_chatid', startedAt: Date.now() };
        await sendTg(chatId, '🔢 Kirim Chat ID Telegram yang mau didaftarkan sebagai Administrator.');
        return;
      }
      // ---- BARU: dari menu PIN Kelola Admin -- daftarkan Admin Finance atau Admin
      // Notifikasi lewat Telegram, field demi field (nama -> Chat ID ->
      // [khusus Admin Notifikasi] jenis notifikasi trip), TANPA bisa
      // melompati satu field pun -- lihat alur lengkapnya di
      // handleNonTripConvo() (convo.kind 'fa_add' / 'na_add'). ----
      if (cq && text === 'fa:add') {
        pendingConversations[chatId] = { kind: 'fa_add', step: 'fa_nama', startedAt: Date.now() };
        await sendTg(chatId, '💰 Daftarkan Admin Finance baru.\n\n📝 Nama (label bebas, mis. "Bu Sinta") -- opsional, ketik "lewati" kalau tidak diisi:');
        return;
      }
      if (cq && text === 'na:add') {
        pendingConversations[chatId] = { kind: 'na_add', step: 'na_nama', startedAt: Date.now() };
        await sendTg(chatId, '🔔 Daftarkan Admin Notifikasi baru.\n\n📝 Nama (label bebas, mis. "Pak Budi") -- opsional, ketik "lewati" kalau tidak diisi:');
        return;
      }
      if (cq && text === 'sa:remove:menu') {
        const list = state.superAdmins || [];
        if (list.length === 0) { await sendTg(chatId, 'ℹ️ Belum ada Administrator terdaftar.'); return; }
        await sendTg(chatId, '➖ Pilih yang mau dihapus:', list.map(a => [{ text: `Chat ID ${a.chatId}`, callback_data: `sa:rm:${a.id}` }]));
        return;
      }
      if (cq && text.startsWith('sa:rm:')) {
        const targetId = textRaw.slice('sa:rm:'.length);
        const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
          freshRaw.data.superAdmins = (freshRaw.data.superAdmins || []).filter(a => a.id !== targetId);
          return true;
        });
        await sendTg(chatId, hasil.ok ? '✅ Administrator itu sudah dihapus.' : '❌ Gagal menyimpan, coba lagi.');
        return;
      }

      // ---- RAHASIA: khusus Administrator -- ringkasan & detail rata-rata
      // kecepatan sopir. Sama seperti PIN Kelola Admin di atas, SENGAJA TIDAK pernah
      // masuk unknownCommandMessage(). Kalau BUKAN Administrator yang ketik
      // kata-kata ini (termasuk kalau kebetulan sama dgn nama sopir), bot
      // diam total -- jatuh ke fallback umum di bawah seperti pesan biasa. ----
      // Fitur rahasia ini bisa dimatikan manual lewat menu "🔔 Notifikasi
      // Telegram per Peran" -> "Fitur Tersembunyi" (state.hiddenFeatures.
      // kecepatanCommand) TANPA perlu ubah kode -- default TETAP AKTIF
      // (perilaku lama) kalau belum pernah diatur.
      const kecepatanCmdAktif = !(state.hiddenFeatures && state.hiddenFeatures.kecepatanCommand === false);
      if (!cq && withAliases(['kecepatan', 'speed', 'laju'], 'kecepatan').includes(text) && isSuperAdminChat(chatId) && kecepatanCmdAktif) {
        await sendTg(chatId, buildAvgSpeedRankingText());
        return;
      }
      // ---- RAHASIA: khusus Administrator -- 7 Log Notifikasi terakhir
      // (notifikasi yang bot KIRIM KELUAR, dari notif-state.json) langsung
      // lewat chat. v3.268.0 -- kata kunci "log" TIDAK LAGI memicu ini --
      // dipindah ke "lognotif" (+ "notifikasi"/"cek notif" tetap berlaku)
      // krn "log" sekarang dipakai command BARU "Log Interaksi Bot" (semua
      // pesan MASUK dari SEMUA peran, lihat blok terpisah di bawah -- BEDA
      // total dari log ini yang cuma soal notifikasi KELUAR). Gerbang akses
      // TIDAK berubah (tetap isSuperAdminChat + togel Fitur Tersembunyi). ----
      const notifLogCmdAktif = !(state.hiddenFeatures && state.hiddenFeatures.notifLogCommand === false);
      if (!cq && withAliases(['lognotif', 'notifikasi', 'cek notif'], 'notiflog').includes(text) && isSuperAdminChat(chatId) && notifLogCmdAktif) {
        await sendTg(chatId, await buildNotifLogRingkasanText(env));
        return;
      }
      // ---- v3.266.0 -- BARU: khusus Administrator -- 5 update fitur
      // TERBARU KHUSUS Bot Telegram (lihat BOT_CHANGELOG/buildBotUpdateText()
      // dekat buildNotifLogRingkasanText() di atas). SENGAJA cuma bot, BUKAN
      // seluruh sistem -- tujuannya Administrator bisa cek cepat "bot ini
      // sekarang bisa apa aja" tanpa tercampur perubahan UI/web yang tidak
      // relevan buat percakapan Telegram. Sama pola dgn kecepatan/notiflog di
      // atas: bisa dimatikan lewat menu "🔔 Notifikasi Telegram per Peran"
      // -> "Fitur Tersembunyi" (state.hiddenFeatures.botUpdateCommand) TANPA
      // ubah kode, default TETAP AKTIF kalau belum pernah diatur. ----
      const botUpdateCmdAktif = !(state.hiddenFeatures && state.hiddenFeatures.botUpdateCommand === false);
      if (!cq && updateBotAliases().includes(text) && isSuperAdminChat(chatId) && botUpdateCmdAktif) {
        await sendTg(chatId, buildBotUpdateText());
        return;
      }
      // ---- v3.267.0 -- BARU: "id" -- ringkasan akun untuk diri sendiri,
      // TERBUKA utk SEMUA peran terdaftar (BUKAN Super Admin-only spt 3
      // command di atas, makanya TIDAK dicek isSuperAdminChat()/togel Fitur
      // Tersembunyi). buildIdSummaryText() sendiri yang memutuskan return
      // null kalau chat ini ternyata tidak terdaftar di peran manapun --
      // diam total sesuai pola yang sama dgn "menu"/"rekomendasi". ----
      if (!cq && idAliases().includes(text)) {
        const ringkasanId = buildIdSummaryText(chatId);
        if (ringkasanId) await sendTg(chatId, ringkasanId);
        return;
      }
      // ---- v3.268.0 -- BARU: "log" -- Log Interaksi Bot, SEMUA pesan MASUK
      // dari SEMUA peran (BEDA total dari "lognotif" di atas yang isinya
      // notifikasi bot KIRIM KELUAR). Gerbang aksesnya BEDA STRUKTUR dari
      // command lain di file ini -- BUKAN hardcode isSuperAdminChat/togel
      // Fitur Tersembunyi, tapi lewat botLogAccessAktif() (baca
      // state.notifRolePrefs.<peran>.botLog, diatur dari panel "🔔
      // Notifikasi Telegram per Peran" -> item "Log Interaksi Bot", default
      // HANYA Administrator). Chat yang TIDAK terdaftar di peran manapun
      // otomatis false (lihat peranUntukRolePrefs() return null). ----
      if (!cq && botLogAliases().includes(text) && botLogAccessAktif(chatId)) {
        await sendTg(chatId, await buildInteractionLogText(env));
        return;
      }
      // ---- BARU (v3.212.1): Barcode MyPertamina per mobil -- Sopir/Operator/
      // Administrator ketik salah satu kata kunci utk lihat lagi barcode QR
      // MyPertamina mobil tertentu, dikirim balik sbg FOTO pakai file_id
      // Telegram yang tersimpan di car.qrPertaminaFileId (TIDAK upload ulang
      // bytes, TIDAK membebani GitHub API sama sekali -- sama pola dgn
      // resiImageFileId yang sudah ada). Cuma mobil yang SUDAH punya barcode
      // tersimpan yang ditampilkan sbg pilihan. Finance SENGAJA dikecualikan
      // (tidak berurusan dgn pengisian BBM mobil). Bukan perintah rahasia --
      // SENGAJA tetap masuk unknownCommandMessage() supaya sopir baru tahu
      // fitur ini ada, beda dari kecepatan/log di atas. ----
      const driverQr = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
      if (!cq && withAliases(['barcode', 'code', 'bar', 'my', 'pertamina', 'my pertamina', 'spbu', 'bahlil', 'bensin'], 'qrpertamina').includes(text) && (driverQr || isAdminOrSuperAdmin(chatId))) {
        const carsWithQr = state.cars.filter(c => c.qrPertaminaFileId);
        if (carsWithQr.length === 0) {
          await sendTg(chatId, `📷 Belum ada barcode MyPertamina yang tersimpan untuk mobil manapun.${isAdminOrSuperAdmin(chatId) ? ' Ketik <b>atur barcode</b> untuk menambahkan.' : ' Minta Admin/Administrator menambahkannya lewat perintah <b>atur barcode</b>.'}`);
          return;
        }
        if (carsWithQr.length === 1) {
          await sendTgPhotoById(chatId, carsWithQr[0].qrPertaminaFileId, `⛽ Barcode MyPertamina — ${escapeHtmlTg(carLabel(carsWithQr[0].id))}`);
          return;
        }
        await sendTg(chatId, '⛽ Barcode MyPertamina — mobil yang mana?', withBatal(carsWithQr.map(c => [{ text: carLabel(c.id), callback_data: `qrview:${c.id}` }])));
        return;
      }
      if (cq && text.startsWith('qrview:')) {
        const car = state.cars.find(c => c.id === text.slice(7));
        if (!car || !car.qrPertaminaFileId) { await sendTg(chatId, '⚠️ Barcode untuk mobil ini tidak ditemukan -- mungkin sudah dihapus/diganti.'); return; }
        await sendTgPhotoById(chatId, car.qrPertaminaFileId, `⛽ Barcode MyPertamina — ${escapeHtmlTg(carLabel(car.id))}`);
        return;
      }
      // ---- BARU (v3.212.1): "atur barcode"/"atur" -- KHUSUS Operator &
      // Administrator (BUKAN Sopir/Finance) -- pilih mobil, lalu kirim foto
      // barcode BARU untuk mobil itu (menggantikan yang lama kalau sudah
      // ada). Ditampung sbg pendingConversations kind 'qr_upload' -- lihat
      // penyadap fotonya di blok isMediaMsg (HARUS diperiksa SEBELUM logika
      // nota/tanda terima generik supaya foto barcode tidak salah nyasar
      // jadi lampiran nota trip). ----
      if (!cq && withAliases(['atur barcode', 'atur'], 'aturbarcode').includes(text) && isAdminOrSuperAdmin(chatId)) {
        if (state.cars.length === 0) { await sendTg(chatId, '⚠️ Belum ada data mobil.'); return; }
        // v3.256.0 -- BARU: pola sama dgn Isi BBM/Booking/Mulai Trip -- lihat
        // catatan lengkap di blok "Mulai Trip". Alur ini beda struktur dari
        // yang lain (state pendingConversations baru dibuat SETELAH mobil
        // dipilih, bukan sebelumnya) -- jadi kalau cuma 1 mobil, langsung
        // dibuatkan state 'qr_upload'-nya di sini juga, menyalin PERSIS
        // pesan & isi convo dari handler "qrset:" di bawah.
        if (state.cars.length === 1) {
          const satuSatunyaMobilQr = state.cars[0];
          pendingConversations[chatId] = { kind: 'qr_upload', carId: satuSatunyaMobilQr.id, startedAt: Date.now() };
          await sendTg(chatId, `🔧 Mobil otomatis dipilih (cuma ada 1): <b>${escapeHtmlTg(carLabel(satuSatunyaMobilQr.id))}</b>.\n\n📷 Kirim foto barcode MyPertamina untuk mobil ini sekarang.${satuSatunyaMobilQr.qrPertaminaFileId ? '\n\n⚠️ Mobil ini sudah punya barcode tersimpan -- foto baru akan MENGGANTIKANNYA.' : ''}\n\nKetik "batal" kapan saja untuk membatalkan.`);
          return;
        }
        await sendTg(chatId, '🔧 Atur Barcode MyPertamina — pilih mobil:', withBatal(carPickerRows('qrset:')));
        return;
      }
      if (cq && text.startsWith('qrset:') && isAdminOrSuperAdmin(chatId)) {
        const carIdQrSet = text.slice(6);
        const carQrSet = state.cars.find(c => c.id === carIdQrSet);
        if (!carQrSet) { await sendTg(chatId, '⚠️ Mobil tidak ditemukan -- ketik "atur barcode" lagi ya.'); return; }
        pendingConversations[chatId] = { kind: 'qr_upload', carId: carIdQrSet, startedAt: Date.now() };
        await sendTg(chatId, `📷 Kirim foto barcode MyPertamina untuk <b>${escapeHtmlTg(carLabel(carIdQrSet))}</b> sekarang.${carQrSet.qrPertaminaFileId ? '\n\n⚠️ Mobil ini sudah punya barcode tersimpan -- foto baru akan MENGGANTIKANNYA.' : ''}\n\nKetik "batal" kapan saja untuk membatalkan.`);
        return;
      }
      // ---- BARU (v3.230.0): "kalibrasi"/"sudah kalibrasi" -- KHUSUS Operator
      // & Administrator -- tandai 1 mobil BARU SAJA selesai dikalibrasi
      // odometer GPS.id-nya (lewat gps.id/v3/vehicle, DI LUAR FleetOps),
      // supaya Pengingat Kalibrasi Odometer GPS.id (lihat computeAlerts())
      // resetcountdown-nya dari SEKARANG, bukan menunggu bucket waktu GLOBAL
      // berganti spt sebelumnya (yg sama rata utk semua mobil, tidak peduli
      // kapan mobil itu SUNGGUHAN terakhir dikalibrasi). Disimpan sbg field
      // OPSIONAL baru car.lastKalibrasiAt (pola sama dgn catatan SOP soal
      // field opsional baru, tidak mengubah makna field lama). ----
      if (!cq && withAliases(['kalibrasi', 'sudah kalibrasi', 'sudah dikalibrasi'], 'kalibrasi').includes(text) && isAdminOrSuperAdmin(chatId)) {
        const carsGps = state.cars.filter(c => c.imeiGps);
        if (carsGps.length === 0) { await sendTg(chatId, '⚠️ Belum ada mobil yang terhubung IMEI GPS.id.'); return; }
        // v3.256.0 -- BARU: pola sama dgn alur pilih-mobil lain -- lihat
        // catatan lengkap di blok "Mulai Trip". Alur ini SYNCHRONOUS (tidak
        // pakai pendingConversations, langsung tulis data begitu mobil
        // dipilih) -- jadi kalau cuma 1 mobil ber-GPS.id, langsung jalankan
        // PERSIS logika yang sama dgn handler "kalibrasi:" di bawah, cuma
        // tanpa menunggu tap tombol dulu.
        if (carsGps.length === 1) {
          const carIdKalAuto = carsGps[0].id;
          const hasilKalAuto = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
            const arr = freshRaw.data.cars || [];
            const c = arr.find(x => x.id === carIdKalAuto);
            if (!c) return false;
            c.lastKalibrasiAt = Date.now();
            return true;
          });
          if (!hasilKalAuto.ok) { await sendTg(chatId, '❌ Gagal menyimpan -- coba lagi ya.'); return; }
          const intervalHariKalAuto = Math.max(1, Number(state.notifSettings && state.notifSettings.kalibrasiGpsIntervalHari) || 30);
          await sendTg(chatId, `🛰️ Mobil otomatis dipilih (cuma ada 1 yang ber-GPS.id): <b>${escapeHtmlTg(carLabel(carIdKalAuto))}</b>.\n\n✅ Ditandai baru saja dikalibrasi (${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })} WIB). Pengingat berikutnya sekitar ${intervalHariKalAuto} hari lagi.`);
          return;
        }
        await sendTg(chatId, '🛰️ Kalibrasi Odometer GPS.id — mobil mana yang BARU SAJA selesai dikalibrasi?', withBatal(carsGps.map(c => [{ text: carLabel(c.id), callback_data: `kalibrasi:${c.id}` }])));
        return;
      }

      // ============================================================================
      // v3.261.0 -- BARU (#4): "pola" / "pola <nama mobil>" -- query cepat lewat
      // chat, TANPA perlu buka aplikasi, utk lihat Pola Kunjungan Berulang
      // (lihat runWeeklyPatternAnalysis()). "pola" saja -> semua mobil yang
      // punya pola; "pola <kata kunci>" -> disaring merk/model/plat yang cocok
      // (pencarian bebas, BUKAN harus pilih dari tombol -- beda pola dgn
      // command lain di file ini yang selalu pakai carPickerRows(), krn ini
      // murni QUERY read-only, bukan alur input data yang butuh kepastian ID
      // pasti benar).
      // ============================================================================
      if (!cq && (text === 'pola' || text.startsWith('pola ')) && isAdminOrSuperAdmin(chatId)) {
        const semuaPola = (state.recurringStopPatterns && typeof state.recurringStopPatterns === 'object') ? state.recurringStopPatterns : {};
        const carsDenganPola = state.cars.filter(c => Array.isArray(semuaPola[c.id]) && semuaPola[c.id].length > 0);
        if (!carsDenganPola.length) {
          await sendTg(chatId, '📍 Belum ada pola kunjungan terdeteksi untuk mobil manapun. Analisis berjalan otomatis tiap Senin dini hari untuk mobil yang sudah terhubung GPS.id -- butuh beberapa minggu data sebelum pola pertama muncul.');
          return;
        }
        const queryNamaPola = text.slice('pola'.length).trim();
        let carsUntukPola = carsDenganPola;
        if (queryNamaPola) {
          carsUntukPola = carsDenganPola.filter(c => `${c.merk || ''} ${c.modelMobil || ''} ${c.plat || ''}`.toLowerCase().includes(queryNamaPola));
          if (!carsUntukPola.length) {
            await sendTg(chatId, `⚠️ Tidak ditemukan mobil yang cocok dengan "${escapeHtmlTg(queryNamaPola)}" yang punya pola kunjungan. Ketik "pola" saja untuk lihat semua mobil.`);
            return;
          }
        }
        const teksPola = carsUntukPola.map(c => {
          const daftarPola = semuaPola[c.id].slice().sort((a, b) => (b.kemunculanPerMinggu || 0) - (a.kemunculanPerMinggu || 0));
          const barisPola = daftarPola.map((p, i) => {
            const matang = (p.mingguTerkumpul || 0) >= POLA_MATANG_MINGGU;
            const jarakTxt = p.jarakRataRataKm != null ? `, ±${p.jarakRataRataKm.toFixed(1)} KM` : '';
            const spbuTxt = p.kemungkinanSpbu ? ' ⛽' : '';
            return `  ${i + 1}. ${matang ? '✅' : '⏳'} ~${(p.kemunculanPerMinggu || 0).toLocaleString('id-ID', { maximumFractionDigits: 1 })}x/minggu${jarakTxt}${spbuTxt}`;
          }).join('\n');
          return `🚗 <b>${escapeHtmlTg(carLabel(c.id))}</b>\n${barisPola}`;
        }).join('\n\n');
        await sendTg(chatId, `📍 <b>Pola Kunjungan Berulang</b>\n\n${teksPola}\n\n<i>✅ = terverifikasi (≥${POLA_MATANG_MINGGU} minggu data) · ⏳ = masih terkumpul · ⛽ = kemungkinan SPBU langganan</i>\n\nDetail lengkap &amp; peta lokasi ada di aplikasi -> Pengaturan -> 📍 Pola Kunjungan Berulang.`);
        return;
      }
      if (cq && text.startsWith('kalibrasi:') && isAdminOrSuperAdmin(chatId)) {
        const carIdKal = text.slice('kalibrasi:'.length);
        const carKal = state.cars.find(c => c.id === carIdKal);
        if (!carKal) { await sendTg(chatId, '⚠️ Mobil tidak ditemukan -- ketik "kalibrasi" lagi ya.'); return; }
        const hasilKal = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
          const arr = freshRaw.data.cars || [];
          const c = arr.find(x => x.id === carIdKal);
          if (!c) return false;
          c.lastKalibrasiAt = Date.now();
          return true;
        });
        if (!hasilKal.ok) { await sendTg(chatId, '❌ Gagal menyimpan -- coba lagi ya.'); return; }
        const intervalHariKal = Math.max(1, Number(state.notifSettings && state.notifSettings.kalibrasiGpsIntervalHari) || 30);
        await sendTg(chatId, `✅ <b>${escapeHtmlTg(carLabel(carIdKal))}</b> ditandai baru saja dikalibrasi (${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })} WIB). Pengingat berikutnya sekitar ${intervalHariKal} hari lagi.`);
        return;
      }
      // ---- BARU -- Atur Notifikasi Telegram per Peran langsung dari chat,
      // KHUSUS Administrator/Super Admin (isAdminOrSuperAdmin). Format bebas:
      // "<nyalakan/matikan> notifikasi <kategori> untuk <peran>", mis.
      // "matikan notifikasi mesin nyala untuk admin". SENGAJA masih perlu
      // konfirmasi tap "✅ Ya, terapkan" sebelum benar2 tersimpan (BUKAN
      // eksekusi langsung dari teks) -- kalau kategori/peran mirip-mirip lalu
      // bot salah tebak, admin masih sempat batalkan sebelum notifikasi
      // penting diam2 mati. Regex WAJIB pola lengkap "<aksi> notifikasi ...
      // untuk ..." -- SENGAJA supaya tidak PERNAH bentrok dgn kata kunci
      // dasar single-word yang sudah ada di alur lain (ya/tidak/batal/
      // kembali/menu/dst) -- kata2 itu juga SENGAJA tidak dimasukkan ke
      // alias kategori/peran manapun di bawah.
      const NOTIF_PERAN_KATEGORI_ALIASES = [
        { key: 'doc', label: 'Dokumen Kadaluarsa', aliases: ['dokumen kadaluarsa', 'dokumen mobil', 'dokumen'] },
        { key: 'service', label: 'Servis/Ganti Oli', aliases: ['servis ganti oli', 'ganti oli', 'servis', 'service'] },
        { key: 'etoll', label: 'Saldo E-Toll Rendah', aliases: ['saldo e-toll', 'saldo etoll', 'e-toll', 'etoll'] },
        { key: 'bbm', label: 'BBM Menipis', aliases: ['bbm menipis', 'bahan bakar', 'bensin', 'bbm'] },
        { key: 'booking', label: 'Reminder Booking', aliases: ['reminder booking', 'booking'] },
        { key: 'tripLama', label: 'Trip Kelamaan Belum Diakhiri', aliases: ['trip kelamaan', 'trip lama', 'trip belum diakhiri'] },
        { key: 'budget', label: 'Budget Bulanan', aliases: ['budget bulanan', 'anggaran bulanan', 'budget'] },
        { key: 'kalibrasi', label: 'Kalibrasi Odometer GPS.id', aliases: ['kalibrasi odometer', 'kalibrasi gps', 'kalibrasi'] },
        { key: 'speed', label: 'Kecepatan Berlebih', aliases: ['kecepatan berlebih', 'kecepatan', 'ngebut'] },
        { key: 'resi', label: 'Resi Perjalanan', aliases: ['resi perjalanan', 'resi trip', 'resi'] },
        { key: 'bookingApproval', label: 'Approval Booking', aliases: ['approval booking', 'persetujuan booking'] },
        { key: 'laporanBulanan', label: 'Laporan Bulanan', aliases: ['laporan bulanan', 'laporan'] },
        { key: 'simGps', label: 'Masa Aktif SIM GPS Tracker', aliases: ['masa aktif sim', 'sim gps tracker', 'sim gps', 'pulsa gps'] },
        { key: 'gpsAlert', label: 'Alert Bawaan GPS.id', aliases: ['alert bawaan gps', 'alert gps', 'rem mendadak'] },
        { key: 'routeDeviation', label: 'Peringatan Rute Menyimpang', aliases: ['rute menyimpang', 'peringatan rute'] },
        { key: 'botLog', label: 'Log Interaksi Bot', aliases: ['log interaksi bot', 'log interaksi', 'log bot'] },
        { key: 'engineOn', label: 'Mesin Dinyalakan', aliases: ['mesin dinyalakan', 'mesin menyala', 'mesin nyala', 'mobil menyala', 'mobil jalan'] },
      ];
      const NOTIF_PERAN_ROLE_ALIASES = [
        { key: 'sopir', label: 'Sopir', aliases: ['sopir', 'driver'] },
        { key: 'finance', label: 'Finance', aliases: ['finance', 'keuangan'] },
        { key: 'admin', label: 'Admin', aliases: ['admin notifikasi', 'administrator', 'admin'] },
        { key: 'superadmin', label: 'Super Admin', aliases: ['super admin', 'superadmin', 'super akses'] },
      ];
      function cariAliasTerbaik(teks, daftar) {
        const t = ' ' + teks.trim() + ' ';
        let terbaik = null;
        daftar.forEach(item => {
          item.aliases.forEach(a => {
            if (t.includes(' ' + a + ' ') || t.trim() === a) {
              if (!terbaik || a.length > terbaik._aliasLen) terbaik = { key: item.key, label: item.label, _aliasLen: a.length };
            }
          });
        });
        return terbaik;
      }
      const notifPeranCmdMatch = !cq && text.match(/^(nyalakan|aktifkan|hidupkan|buka|matikan|nonaktifkan|non-aktifkan|tutup)\s+notifikasi\s+(.+?)\s+untuk\s+(.+)$/);
      if (notifPeranCmdMatch && isAdminOrSuperAdmin(chatId)) {
        const nyalakanNp1 = ['nyalakan', 'aktifkan', 'hidupkan', 'buka'].includes(notifPeranCmdMatch[1]);
        const kategoriMatchNp = cariAliasTerbaik(notifPeranCmdMatch[2], NOTIF_PERAN_KATEGORI_ALIASES);
        const peranMatchNp = cariAliasTerbaik(notifPeranCmdMatch[3], NOTIF_PERAN_ROLE_ALIASES);
        if (!kategoriMatchNp || !peranMatchNp) {
          const daftarKategoriTxt = NOTIF_PERAN_KATEGORI_ALIASES.map(k => `• ${k.label}`).join('\n');
          await sendTg(chatId, `⚠️ Tidak dikenali. Format: <b>"nyalakan/matikan notifikasi &lt;kategori&gt; untuk &lt;peran&gt;"</b>, mis. "matikan notifikasi mesin nyala untuk admin".\n\nPeran: Sopir / Finance / Admin / Super Admin.\n\nKategori yang tersedia:\n${daftarKategoriTxt}`);
          return;
        }
        await sendTg(chatId,
          `❓ Konfirmasi: <b>${nyalakanNp1 ? 'NYALAKAN' : 'MATIKAN'}</b> notifikasi <b>"${escapeHtmlTg(kategoriMatchNp.label)}"</b> untuk peran <b>${escapeHtmlTg(peranMatchNp.label)}</b>?`,
          withBatal([[{ text: '✅ Ya, terapkan', callback_data: `notifperan:apply:${kategoriMatchNp.key}:${peranMatchNp.key}:${nyalakanNp1 ? 1 : 0}` }]])
        );
        return;
      }
      if (cq && text.startsWith('notifperan:apply:') && isAdminOrSuperAdmin(chatId)) {
        const bagianNp = textRaw.slice('notifperan:apply:'.length).split(':');
        const kategoriKeyNp = bagianNp[0], peranKeyNp = bagianNp[1], nilaiNp = bagianNp[2];
        const kategoriInfoNp = NOTIF_PERAN_KATEGORI_ALIASES.find(k => k.key === kategoriKeyNp);
        const peranInfoNp = NOTIF_PERAN_ROLE_ALIASES.find(r => r.key === peranKeyNp);
        if (!kategoriInfoNp || !peranInfoNp) { await sendTg(chatId, '⚠️ Data tidak valid, ulangi lagi ya.'); return; }
        const nyalakanNp2 = nilaiNp === '1';
        const hasilNp = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
          const d = freshRaw.data;
          d.notifRolePrefs = (d.notifRolePrefs && typeof d.notifRolePrefs === 'object') ? d.notifRolePrefs : {};
          d.notifRolePrefs[peranKeyNp] = (d.notifRolePrefs[peranKeyNp] && typeof d.notifRolePrefs[peranKeyNp] === 'object') ? d.notifRolePrefs[peranKeyNp] : {};
          d.notifRolePrefs[peranKeyNp][kategoriKeyNp] = nyalakanNp2;
          return true;
        });
        if (!hasilNp.ok) { await sendTg(chatId, '❌ Gagal menyimpan -- coba lagi ya.'); return; }
        await sendTg(chatId, `✅ Notifikasi <b>"${escapeHtmlTg(kategoriInfoNp.label)}"</b> untuk peran <b>${escapeHtmlTg(peranInfoNp.label)}</b> sekarang <b>${nyalakanNp2 ? 'AKTIF' : 'NONAKTIF'}</b>.`);
        return;
      }
      // ---- BARU (v3.282.0) -- tombol rekomendasi cepat "🔕 Matikan notifikasi
      // ini", ditempel LANGSUNG di badan pesan alert oleh runNotifyCheck()
      // (lihat komentar di sana) KHUSUS utk penerima Admin/Super Admin --
      // Sopir & Finance TIDAK pernah dapat tombol ini krn keduanya memang
      // tidak lolos isAdminOrSuperAdmin() (gerbang yg SAMA dgn command teks
      // bebas "matikan notifikasi ... untuk ..." di atas), jadi kalaupun
      // ditempel tetap tidak akan berfungsi -- runNotifyCheck() SENGAJA
      // sudah tidak menempelkannya sama sekali utk 2 peran itu, ini cuma
      // pengaman kedua (defense in depth), bukan gerbang utama.
      // callback_data-nya numpang PERSIS format `notifperan:apply:` yang
      // sudah ada (cuma prefix beda, "suggest" bukan "apply") supaya tetap
      // ada jeda konfirmasi "✅ Ya, terapkan" sebelum benar2 tersimpan --
      // SENGAJA TIDAK langsung apply dari tap 1x, alasannya sama persis dgn
      // command teks bebas di atas (kalau bot/pemetaan kategori keliru,
      // admin masih sempat batalkan sebelum notifikasi penting mati diam2).
      if (cq && text.startsWith('notifperan:suggest:') && isAdminOrSuperAdmin(chatId)) {
        const bagianSg = textRaw.slice('notifperan:suggest:'.length).split(':');
        const kategoriKeySg = bagianSg[0], peranKeySg = bagianSg[1], nilaiSg = bagianSg[2];
        const kategoriInfoSg = NOTIF_PERAN_KATEGORI_ALIASES.find(k => k.key === kategoriKeySg);
        const peranInfoSg = NOTIF_PERAN_ROLE_ALIASES.find(r => r.key === peranKeySg);
        if (!kategoriInfoSg || !peranInfoSg) { await sendTg(chatId, '⚠️ Data tidak valid, ulangi lagi ya.'); return; }
        const nyalakanSg = nilaiSg === '1';
        await sendTg(chatId,
          `❓ Konfirmasi: <b>${nyalakanSg ? 'NYALAKAN' : 'MATIKAN'}</b> notifikasi <b>"${escapeHtmlTg(kategoriInfoSg.label)}"</b> untuk peran <b>${escapeHtmlTg(peranInfoSg.label)}</b>?`,
          withBatal([[{ text: '✅ Ya, terapkan', callback_data: `notifperan:apply:${kategoriInfoSg.key}:${peranInfoSg.key}:${nilaiSg}` }]])
        );
        return;
      }
      // ---- BARU (v3.216.0): "tiba"/"sampai" -- KHUSUS trip yg py lebih dari
      // 1 tujuan (Tujuan Tambahan) -- tandai 1 TITIK tujuan sudah dikunjungi.
      // TIDAK LAGI menutup trip (itu sekarang "akhiri trip"/"selesai trip",
      // lihat tibaAliases()) -- perubahan SENGAJA per permintaan eksplisit,
      // supaya "tiba"/"sampai" konsisten artinya "sampai di 1 titik", bukan
      // "trip selesai". Untuk trip 1-tujuan (mayoritas kasus), sopir TETAP
      // DIARAHKAN jelas ke "akhiri trip" -- BUKAN dibiarkan diam, supaya
      // yang masih kebiasaan lama tidak bingung/mengira bot rusak.
      function totalTujuanTrip(trip) {
        return 1 + (Array.isArray(trip.tujuanTambahan) ? trip.tujuanTambahan.length : 0);
      }
      function namaTujuanKe(trip, nomor) {
        if (nomor === 1) return trip.tujuan || null;
        const idx = nomor - 2;
        return (Array.isArray(trip.tujuanTambahan) && trip.tujuanTambahan[idx]) ? trip.tujuanTambahan[idx] : null;
      }
      function selesaiCountTrip(trip) {
        return Object.keys(trip.tujuanSelesaiAt || {}).length;
      }
      function buildSampaiKeyboard(trip) {
        const total = totalTujuanTrip(trip);
        const selesaiMap = trip.tujuanSelesaiAt || {};
        const rows = [];
        for (let n = 1; n <= total; n++) {
          if (selesaiMap[n]) continue;
          const nama = namaTujuanKe(trip, n);
          if (!nama) continue;
          rows.push([{ text: `📍 ${nama}`, callback_data: `sampai:${n}` }]);
        }
        rows.push([{ text: '🏁 Akhiri Trip', callback_data: 'cmd:akhiritrip' }]);
        return rows;
      }
      async function prosesTandaiSampai(chatIdSp, nomor) {
        const driverSp = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatIdSp);
        if (!driverSp) return;
        const tripSp = state.usage.find(u => u.driverId === driverSp.id && u.status === 'digunakan');
        if (!tripSp) { await sendTg(chatIdSp, '⚠️ Tidak ditemukan trip yang sedang berjalan atas nama Anda.'); return; }
        const total = totalTujuanTrip(tripSp);
        if (!Number.isInteger(nomor) || nomor < 1 || nomor > total) {
          await sendTg(chatIdSp, `⚠️ Nomor tujuan tidak valid. Trip ini punya ${total} tujuan (1-${total}).`);
          return;
        }
        const nama = namaTujuanKe(tripSp, nomor);
        const tripIdSp = tripSp.id;
        const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
          const arr = freshRaw.data.usage || [];
          const u = arr.find(x => x.id === tripIdSp);
          if (!u) return false;
          u.tujuanSelesaiAt = u.tujuanSelesaiAt || {};
          u.tujuanSelesaiAt[nomor] = Date.now();
          return true;
        });
        if (!hasil.ok) { await sendTg(chatIdSp, '❌ Gagal menandai -- coba lagi ya.'); return; }
        tripSp.tujuanSelesaiAt = tripSp.tujuanSelesaiAt || {};
        tripSp.tujuanSelesaiAt[nomor] = Date.now();
        const sisaTotal = total - selesaiCountTrip(tripSp);
        let pesan = `✅ Tercatat sampai di <b>${escapeHtmlTg(nama)}</b> (tujuan ke-${nomor} dari ${total}).`;
        if (sisaTotal > 0) {
          pesan += `\n\n${sisaTotal} tujuan lagi belum ditandai. Ketik <b>sampai</b> lagi kalau sudah di titik berikutnya, atau <b>akhiri trip</b> kalau sudah selesai semua.`;
        } else {
          pesan += `\n\n🎉 Semua tujuan sudah dikunjungi! Ketik <b>akhiri trip</b> untuk menyelesaikan.`;
        }
        await sendTg(chatIdSp, pesan);
      }
      if ((!cq && withAliases(['tiba', 'sampai'], 'sampai').includes(text)) || (cq && text === 'sampai:menu')) {
        const driverSp0 = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
        if (!driverSp0) return;
        const tripSp0 = state.usage.find(u => u.driverId === driverSp0.id && u.status === 'digunakan');
        if (!tripSp0) { await sendTg(chatId, '⚠️ Tidak ditemukan trip yang sedang berjalan atas nama Anda.'); return; }
        const total0 = totalTujuanTrip(tripSp0);
        if (total0 <= 1) {
          await sendTg(chatId, '📍 Untuk mengakhiri perjalanan ini, sekarang ketik <b>akhiri trip</b> (bukan "tiba"/"sampai" lagi ya) -- kata "tiba"/"sampai" sekarang khusus dipakai kalau trip Anda mampir ke lebih dari 1 tujuan.');
          return;
        }
        const sisa0 = total0 - selesaiCountTrip(tripSp0);
        if (sisa0 <= 0) {
          await sendTg(chatId, '🎉 Semua tujuan trip ini sudah ditandai selesai. Ketik <b>akhiri trip</b> untuk menyelesaikan perjalanan.');
          return;
        }
        await sendTg(chatId, `📍 Trip ini punya ${total0} tujuan (${selesaiCountTrip(tripSp0)} sudah dikunjungi). Anda baru sampai di mana?`, withBatal(buildSampaiKeyboard(tripSp0)));
        return;
      }
      if (!cq && /^(tiba|sampai)\s+\d+$/i.test(text)) {
        const nomorSp = Number(text.replace(/^(tiba|sampai)\s+/i, ''));
        await prosesTandaiSampai(chatId, nomorSp);
        return;
      }
      if (cq && text.startsWith('sampai:')) {
        const nomorSp = Number(text.slice(7));
        await prosesTandaiSampai(chatId, nomorSp);
        return;
      }
      // v3.229.0 -- BARU: tombol "❌ Belum" di pesan konfirmasi proaktif
      // Auto-deteksi Sampai (lihat computeGeofenceArrivalCandidates di
      // worker.js) -- cuma perlu dibalas ramah, tidak ada aksi data apa pun.
      if (cq && text === 'geoarrival_no') {
        await sendTg(chatId, '👍 Baik, lanjutkan perjalanan. Ketik "sampai" nanti kalau sudah benar-benar tiba.');
        return;
      }
      // Fitur rahasia ini juga bisa dimatikan manual lewat panel "Fitur
      // Tersembunyi" (state.hiddenFeatures.namaSopirLookup) -- default AKTIF.
      const namaSopirLookupAktif = !(state.hiddenFeatures && state.hiddenFeatures.namaSopirLookup === false);
      if (!cq && isSuperAdminChat(chatId) && namaSopirLookupAktif) {
        const namaCocok = state.drivers.find(d => (d.nama || '').trim().toLowerCase() === text);
        if (namaCocok) {
          await sendTg(chatId, buildDriverStatsText(namaCocok));
          return;
        }
        // BARU: teks yang diketik BUKAN nama sopir manapun di data. Kasih
        // tahu EKSPLISIT "tidak ditemukan" (bukan diam / bukan daftar menu
        // generik yang membingungkan) -- ini titik terakhir sebelum fallback
        // umum, jadi di sini sudah pasti bukan salah satu kata kunci lain
        // yang dikenali bot. Dikecualikan "akhiri trip" -- itu tetap harus
        // lolos ke alur tutup trip di bawah, karena Administrator bisa juga sopir aktif.
        if (text && !tibaAliases().includes(text)) {
          await sendTg(chatId, `❓ Tidak ditemukan sopir dengan nama "${escapeHtmlTg(textRaw)}". Pastikan penulisannya persis sama dengan Data Sopir di aplikasi, atau ketik <b>kecepatan</b> untuk lihat ranking semua sopir.`);
          return;
        }
      }

      // ==========================================================================
      // v3.252.0 -- BARU: NLP ringan bertingkat, titik TERAKHIR sebelum pesan
      // sopir benar-benar dianggap "tidak dikenal" (unknownCommandMessage() di
      // bawah). Cuma jalan kalau SEMUA pengecekan exact-match Tingkat 1
      // (`withAliases(...).includes(text)`) di atas titik ini sudah gagal semua
      // -- tidak menyentuh/mengubah satu pun blok exact-match yang sudah ada.
      //
      // Tingkat 1.5 = pemindaian KATA UTUH (whole-word scan, lihat
      //   wholeWordCategoryScan() di atas function ini) -- murni JS, TANPA API
      //   luar, selalu aktif. Beda dari Tingkat 2 (yang membandingkan SELURUH
      //   kalimat ke 1 kata kunci demi toleransi typo): Tingkat 1.5 memecah
      //   kalimat jadi kata per kata, lalu cek apakah ADA kata yang PERSIS sama
      //   dengan salah satu alias -- menangkap kalimat berisi kata basa-basi
      //   spt "tolong cek dong" atau "mau booking mobil ya" TANPA perlu AI.
      //   PENGAMAN WAJIB: kalau kalimat ternyata mengandung kata kunci dari
      //   LEBIH DARI 1 kategori berbeda sekaligus (mis. "cek saldo saya" ->
      //   kata "cek" & "saldo" dua kategori beda), Tingkat 1.5 SENGAJA
      //   menyerah (return null) alih-alih asal pilih salah satu -- kasus
      //   begini diserahkan ke Tingkat 3 (AI) yang memang bisa memahami
      //   maksud SELURUH kalimat, bukan cuma mencocokkan kata lepas.
      // Tingkat 2 = fuzzy match (Levenshtein, lihat bestFuzzyCommandMatch() di
      //   atas function ini) -- murni JS, TANPA panggilan API luar sama sekali, selalu
      //   aktif, tidak butuh Cloudflare Secret apa pun. Menangkap typo/singkatan
      //   1 kata spt "brngkt" -> "berangkat", "sampe" -> "sampai".
      // Tingkat 3 = fallback ke Cloudflare Workers AI (lihat nlpWorkersAiFallback()
      //   di atas file) -- GRATIS (10.000 neuron/hari), TIDAK butuh API key
      //   pihak ketiga. Cuma dicoba kalau Tingkat 1.5 & 2 gagal DAN teksnya
      //   "berkalimat" (>=2 kata) -- kata tunggal aneh cukup diserahkan ke
      //   Tingkat 2/dianggap tidak dikenal saja, supaya tidak boros neuron utk
      //   kasus yang sudah cukup dijawab tanpa AI.
      //
      // Safety net WAJIB: Tingkat 2 & 3 TIDAK PERNAH langsung mengeksekusi
      // command hasil tebakan -- SELALU dikonfirmasi dulu lewat tombol Ya/Tidak
      // (pola sama dgn confirm_odo_gps yang sudah ada). Tap "Ya" SENGAJA numpang
      // mekanisme "cmd:" yang SUDAH ADA (lihat isMenuCmdTap di paling atas
      // function ini) -- replay-nya lewat KODE command asli yang PERSIS sama
      // dgn kalau sopir mengetik kata kuncinya sendiri secara manual (termasuk
      // semua gerbang izin/rolenya), BUKAN logika eksekusi duplikat baru.
      // Tap "Bukan" (callback_data 'nlpno') cukup dibalas ramah, tidak ada aksi
      // data apa pun -- lihat blok penanganannya tepat di bawah blok ini.
      //
      // Cuma jalan utk pesan ketik manual (bukan tap tombol lain) & chat yang
      // "dikenal" -- predikat SAMA PERSIS dgn gerbang anti-spam yang sudah ada
      // di unknownCommandMessage() di bawah, supaya bot tetap tidak "berisik"
      // membalas orang asing yang menyasar webhook.
      // ==========================================================================
      if (cq && text === 'nlpno') {
        // v3.265.0 -- hapus pending "belajar alias" (kalau ada) begitu sopir
        // tap "Bukan" -- mencegah tap TIDAK TERKAIT di kemudian hari (dalam
        // jendela TTL 15 menit) yang KEBETULAN replay-nya sama ikut ke-commit
        // jadi alias, padahal tebakan sebelumnya sudah ditolak eksplisit.
        hapusNlpPendingKv(env, chatId).catch(() => {});
        await sendTg(chatId, '👍 Oke, diabaikan. Ketik <b>rekomendasi</b> untuk lihat daftar perintah yang tersedia.');
        return;
      }
      const nlpChatDikenal = actorNameForChat(chatId) !== 'Telegram' || isSaldoAllowedUser(chatId) || isSuperAdminChat(chatId);
      if (!cq && text && !tibaAliases().includes(text) && nlpChatDikenal) {
        // v3.265.0 -- field `kategori` BARU: kalau ada, artinya keyword
        // kandidat ini berasal dari withAliases(...,'kategoriIni') yang bisa
        // diedit Administrator lewat menu "✏️ Alias" (index.html) -- dipakai
        // fitur "Tingkat 3 mengajari Tingkat 1.5" (lihat
        // commitBelajarAliasDariTapNlp() dekat pushMainDataUpdate() di atas
        // file) utk tahu HARUS ditulis ke kategori alias mana. 'Cek Saldo' &
        // 'Pola Kunjungan' SENGAJA TIDAK diberi `kategori` -- keduanya belum
        // pernah dibungkus withAliases() (keywords-nya array polos), jadi
        // belum ada tempat menyimpan alias tambahan utk keduanya. Efeknya:
        // Tingkat 3 tetap bisa menebak & menjawab 2 command ini spt biasa,
        // cuma tidak ikut "belajar" kata baru -- aman, bukan regresi (perilaku
        // sebelum fitur belajar ini ditambahkan).
        const nlpCandidates = [
          { label: 'Mulai Trip', replay: 'berangkat', keywords: mulaiTripAliases(), kategori: 'mulaitrip' },
          { label: 'Akhiri Trip', replay: 'akhiri trip', keywords: tibaAliases(), kategori: 'tiba' },
          { label: 'Catat Biaya', replay: 'biaya', keywords: biayaAliases(), kategori: 'biaya' },
          { label: 'Booking Mobil', replay: 'booking', keywords: bookingAliases(), kategori: 'booking' },
          { label: 'Batalkan Booking', replay: 'batalkan booking', keywords: batalBookingAliases(), kategori: 'batalbooking' },
          { label: 'Cek Mobil', replay: 'cek', keywords: CEK_MOBIL_KEYWORDS, kategori: 'cek' },
          { label: 'Lokasi Mobil', replay: 'lokasi', keywords: LOKASI_KEYWORDS, kategori: 'lokasi' },
          { label: 'Servis Mobil', replay: 'service', keywords: SERVICE_KEYWORDS, kategori: 'service' },
          { label: 'Oli / Servis Mobil Saya', replay: 'oli', keywords: DRIVER_OLI_KEYWORDS, kategori: 'oli' },
          // BARU -- 'saldo' (E-Toll/BBM/Dokumen/Budget, tergantung role) --
          // sengaja dimasukkan TANPA gerbang izin di sini; kalau chat ini
          // ternyata tidak berhak (bukan isSaldoAllowedUser/isFinanceAdminChat),
          // replay 'cmd:saldo' otomatis tidak menghasilkan apa-apa (gerbang izin
          // asli command 'saldo' yang menangani, SAMA seperti kalau diketik
          // manual oleh orang yang tidak berhak) -- tidak ada celah izin baru.
          { label: 'Cek Saldo', replay: 'saldo', keywords: ['saldo'] },
          // v3.261.0 -- BARU: lihat command "pola" (#4, query Pola Kunjungan
          // Berulang) -- gerbang izin (isAdminOrSuperAdmin) tetap ditangani
          // handler asli command 'pola', sama pola dgn 'saldo' di atas.
          { label: 'Pola Kunjungan', replay: 'pola', keywords: ['pola', 'kunjungan'] },
          { label: 'Menu Utama', replay: 'menu', keywords: menuAliases(), kategori: 'menu' },
          { label: 'Rekomendasi Perintah', replay: 'rekomendasi', keywords: rekomendasiAliases(), kategori: 'rekomendasi' },
          { label: 'Update Bot', replay: 'update', keywords: updateBotAliases(), kategori: 'botupdate' },
          { label: 'Ringkasan Akun (ID)', replay: 'id', keywords: idAliases(), kategori: 'id' },
          { label: 'Log Interaksi Bot', replay: 'log', keywords: botLogAliases(), kategori: 'botlog' },
        ];
        let nlpTebakan = wholeWordCategoryScan(text, nlpCandidates); // Tingkat 1.5
        if (!nlpTebakan) nlpTebakan = bestFuzzyCommandMatch(text, nlpCandidates); // Tingkat 2
        let nlpDariTingkat3 = false;
        if (!nlpTebakan && text.split(/\s+/).length >= 2) {
          nlpTebakan = await nlpWorkersAiFallback(env, textRaw, nlpCandidates); // Tingkat 3
          nlpDariTingkat3 = !!nlpTebakan;
        }
        if (nlpTebakan) {
          // v3.265.0 -- "Tingkat 3 mengajari Tingkat 1.5": HANYA kalau
          // tebakan ini datang dari AI (bukan Tingkat 1.5/2 yang memang sudah
          // kenal katanya tanpa AI) DAN kandidatnya punya `kategori` alias,
          // simpan DULU sbg "menunggu konfirmasi" (KV `nlppending:<chatId>`,
          // TTL 15 menit) -- BELUM ditulis permanen. Baru benar-benar dicatat
          // ke state.commandAliases kalau sopir tap "✅ Ya, benar" (lihat
          // commitBelajarAliasDariTapNlp(), dipanggil dari titik isMenuCmdTap
          // dekat awal function ini) -- supaya yang tersimpan permanen sudah
          // pasti diverifikasi manusia, prinsip yang SAMA dgn OCR nominal BBM
          // (v3.259.0: "data ... TIDAK PERNAH boleh langsung dipercaya tanpa
          // verifikasi manusia").
          if (nlpDariTingkat3 && nlpTebakan.kategori) {
            const kataBaru = cariKataBaruUntukDipelajari(text, nlpCandidates);
            if (kataBaru) {
              writeGpsKvJson(env, `nlppending:${chatId}`, { replay: nlpTebakan.replay, kategori: nlpTebakan.kategori, kataBaru }, 900)
                .catch(e => console.log('webhook: gagal simpan nlppending (diabaikan):', e.message));
            }
          }
          await sendTg(chatId, `🤔 Sepertinya maksud Anda perintah <b>${escapeHtmlTg(nlpTebakan.label)}</b>. Benar?`, [[
            { text: '✅ Ya, benar', callback_data: `cmd:${nlpTebakan.replay}` },
            { text: '❌ Bukan', callback_data: 'nlpno' },
          ]]);
          return;
        }
      }

      const isAkhiriPaksa = cq && text === 'akhiritrip:paksa';
      if (!tibaAliases().includes(text) && !isAkhiriPaksa) {
        // BARU -- teks tidak cocok satu pun perintah yang dikenal ('akhiri
        // trip', 'isi', 'biaya'/'operasional'/'pribadi', 'saldo') -> daripada
        // diam saja, kasih rekomendasi perintah yang bisa dipakai. Hanya
        // dibalas kalau chat ini memang dikenal (sopir/admin/pengguna saldo)
        // supaya bot tidak "berisik" membalas orang asing/spam yang menyasar webhook.
        if (!cq) {
          const dikenal = actorNameForChat(chatId) !== 'Telegram' || isSaldoAllowedUser(chatId) || isSuperAdminChat(chatId);
          if (dikenal) await sendTg(chatId, unknownCommandMessage(chatId), menuCommandKeyboard(chatId));
        }
        return;
      }
      const driver = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
      if (!driver) return;
      const tripAktif = state.usage.find(u => u.driverId === driver.id && u.status === 'digunakan');
      if (!tripAktif) {
        await sendTg(chatId, '⚠️ Tidak ditemukan trip yang sedang berjalan atas nama Anda -- kalau ini keliru, cek langsung di aplikasi.');
        return;
      }
      // BARU -- peringatan "ada tujuan terlewat": kalau trip ini punya lebih
      // dari 1 Tujuan Tambahan dan masih ada yang belum ditandai "sampai",
      // tanya konfirmasi dulu sebelum benar-benar menutup trip. Jaring
      // pengaman kecil, BUKAN larangan -- sopir tetap bisa lanjut akhiri
      // trip via tombol "Ya, akhiri saja" (callback 'akhiritrip:paksa', lihat
      // isAkhiriPaksa di atas) kalau memang sengaja/lupa tandai tapi sudah
      // benar-benar selesai.
      if (!isAkhiriPaksa) {
        const totalTujuanAkhir = totalTujuanTrip(tripAktif);
        const sisaTujuanAkhir = totalTujuanAkhir - selesaiCountTrip(tripAktif);
        if (totalTujuanAkhir > 1 && sisaTujuanAkhir > 0) {
          const daftarBelum = [];
          for (let n = 1; n <= totalTujuanAkhir; n++) {
            if ((tripAktif.tujuanSelesaiAt || {})[n]) continue;
            const namaBelum = namaTujuanKe(tripAktif, n);
            if (namaBelum) daftarBelum.push(namaBelum);
          }
          const daftarTeks = daftarBelum.length ? ('\n' + daftarBelum.map(n => `• ${escapeHtmlTg(n)}`).join('\n')) : '';
          await sendTg(
            chatId,
            `⚠️ Masih ada ${sisaTujuanAkhir} dari ${totalTujuanAkhir} tujuan trip ini yang belum ditandai <b>sampai</b>:${daftarTeks}\n\nYakin mau akhiri trip sekarang?`,
            [
              [{ text: '🏁 Ya, akhiri saja', callback_data: 'akhiritrip:paksa' }],
              [{ text: '📍 Belum, tandai dulu', callback_data: 'sampai:menu' }],
            ]
          );
          return;
        }
      }
      const carUntukTrip = state.cars.find(c => c.id === tripAktif.carId);
      pendingConversations[chatId] = {
        kind: 'tutup_trip',
        tripId: tripAktif.id, carId: tripAktif.carId, odoKeluar: tripAktif.odoKeluar,
        driverNama: driver.nama, tujuan: tripAktif.tujuan || '-',
        etollCardId: tripAktif.etollCardId || null,
        step: 'odometer', startedAt: Date.now(),
      };

      // v3.144.0 -- Kalau mobil ini sudah dihubungkan IMEI GPS.id-nya (Data
      // Mobil), tanya-konfirmasi dulu odometer dari GPS.id sebelum minta
      // ketik manual -- lebih cepat & mengurangi salah ketik. Kalau GPS.id
      // gagal/tidak ada datanya, diam-diam jatuh ke alur manual seperti biasa
      // (TIDAK memblokir penutupan trip).
      // v3.150.0 -- digate GPS_ODO_AUTOFILL_ENABLED (lihat definisinya di
      // atas file): odometer GPS.id vs odometer asli dashboard selisihnya
      // jauh, jadi bot tidak lagi menyarankan angka ini sampai dinyalakan lagi.
      const gpsOdoKm = (GPS_ODO_AUTOFILL_ENABLED && carUntukTrip && carUntukTrip.imeiGps)
        ? await getGpsIdMileageForImei(env, carUntukTrip.imeiGps)
        : null;

      if (gpsOdoKm != null) {
        pendingConversations[chatId].step = 'confirm_odo_gps';
        pendingConversations[chatId].gpsOdoSuggestion = gpsOdoKm;
        await sendTg(chatId, `📍 Oke, ${escapeHtmlTg(driver.nama)}! Trip ${escapeHtmlTg(carLabel(tripAktif.carId))} (${escapeHtmlTg(tripAktif.tujuan || '-')}) akan ditutup.\n\n🛰️ Sistem GPS mendeteksi odometer sekarang: <b>${gpsOdoKm.toLocaleString('id-ID')} KM</b>. Apakah benar?\n\nKetik <b>ya</b> kalau benar, atau <b>tidak</b> kalau mau isi manual.\n\n<i>Ketik "batal" kapan saja untuk membatalkan.</i>`, KB_YA_TIDAK);
      } else {
        await sendTg(chatId, `📍 Oke, ${escapeHtmlTg(driver.nama)}! Trip ${escapeHtmlTg(carLabel(tripAktif.carId))} (${escapeHtmlTg(tripAktif.tujuan || '-')}) akan ditutup.\n\n🔢 Odometer sekarang (KM)? Contoh: 45230\n\n<i>Ketik "batal" kapan saja untuk membatalkan.</i>`);
      }
      console.log(`webhook: ${driver.nama} mulai percakapan tutup trip (${tripAktif.id}).`);
      return;
    }

    // v3.155.0 -- alur "tiba" (tutup trip) di bawah ini HANYA untuk
    // convo.kind==='tutup_trip' (atau convo lama yang belum punya field
    // "kind" sama sekali, dari sebelum fitur "isi"/"biaya" ditambahkan).
    // convo.kind lain ('isi_bbm'/'isi_etoll'/'biaya_op') ditangani di blok
    // masing-masing di bawah (lihat akhir fungsi ini).
    if (convo.kind && convo.kind !== 'tutup_trip') {
      await handleNonTripConvo(chatId, convo, text, textRaw, pendingConversations);
      return;
    }

    const car = state.cars.find(c => c.id === convo.carId);
    if (!car) {
      delete pendingConversations[chatId];
      await sendTg(chatId, '⚠️ Data mobil untuk trip ini sudah tidak ditemukan -- percakapan dibatalkan otomatis. Cek langsung di aplikasi.');
      return;
    }

    // v3.144.0 -- Langkah tanya-konfirmasi odometer GPS.id (cuma muncul
    // kalau mobilnya punya IMEI GPS.id terhubung, lihat blok "!convo" di
    // atas). "ya" -> odometer dari GPS.id langsung dipakai, lanjut ke
    // pertanyaan BBM. "tidak" -> turun ke alur manual (step 'odometer')
    // seperti biasa, TIDAK menutup trip dulu.
    if (convo.step === 'confirm_odo_gps') {
      const jawaban = text.trim();
      const isYa = yaAliases().includes(jawaban);
      const isTidak = tidakAliases().includes(jawaban);

      if (isYa) {
        const angka = convo.gpsOdoSuggestion;
        if (convo.odoKeluar != null && angka < convo.odoKeluar) {
          convo.step = 'odometer';
          await sendTg(chatId, `⚠️ Odometer dari GPS.id (${angka.toLocaleString('id-ID')} KM) malah lebih kecil dari odometer saat berangkat (${Number(convo.odoKeluar).toLocaleString('id-ID')} KM) -- kemungkinan data GPS belum ter-update. Silakan ketik manual odometer sekarang (KM). Contoh: 45230`);
          return;
        }
        convo.odometerValue = angka;
        convo.step = 'bbm';
        await sendTg(chatId, pertanyaanBbm(car));
        return;
      }
      if (isTidak) {
        convo.step = 'odometer';
        await sendTg(chatId, '🔢 Oke, silakan ketik odometer sekarang (KM). Contoh: 45230');
        return;
      }
      await sendTg(chatId, `Belum jelas 🙏 Ketik <b>ya</b> kalau odometer ${Number(convo.gpsOdoSuggestion).toLocaleString('id-ID')} KM benar, atau <b>tidak</b> kalau mau isi manual.`, KB_YA_TIDAK);
      return;
    }

    if (convo.step === 'odometer') {
      const digitSaja = textRaw.replace(/[^\d]/g, '');
      const angka = Number(digitSaja);
      if (digitSaja === '' || !isFinite(angka)) {
        await sendTg(chatId, '⚠️ Belum berupa angka yang valid. Coba ketik ulang, contoh: 45230 (boleh pakai titik: 45.230)');
        return;
      }
      if (convo.odoKeluar != null && angka < convo.odoKeluar) {
        await sendTg(chatId, `⚠️ Odometer (${angka.toLocaleString('id-ID')} KM) tidak boleh lebih kecil dari odometer saat berangkat (${Number(convo.odoKeluar).toLocaleString('id-ID')} KM). Coba cek lagi &amp; ketik ulang.`);
        return;
      }
      convo.odometerValue = angka;
      convo.step = 'bbm';
      await sendTg(chatId, pertanyaanBbm(car));
      return;
    }

    if (convo.step === 'bbm') {
      const angka = Number(textRaw.replace(',', '.'));
      if (!isFinite(angka) || textRaw.trim() === '') {
        await sendTg(chatId, '⚠️ Belum berupa angka yang valid. ' + pertanyaanBbm(car));
        return;
      }
      const maxBar = car.maxBarBbm || 8;
      const batasAtas = car.tipeIndikatorBbm === 'bar' ? maxBar : 100;
      if (angka < 0 || angka > batasAtas) {
        await sendTg(chatId, `⚠️ Harus di antara 0-${batasAtas}. ` + pertanyaanBbm(car));
        return;
      }
      convo.bensinKembaliPercent = car.tipeIndikatorBbm === 'bar' ? convertBarToPercent(angka, maxBar) : angka;

      // v3.154.0 (poin G) -- validasi real-time: bandingkan rasio KM/L yg
      // TERSIRAT dari level BBM yg baru saja diketik (jarak trip ini dibagi
      // estimasi liter dari neraca tangki, TANPA literBeli krn bot belum tahu
      // itu -- literBeli baru dicatat lewat dashboard) terhadap rasio
      // rata-rata historis mobil ini. Kalau melenceng jauh (di luar 50%-200%
      // rata-rata), kemungkinan besar salah baca/ketik level BBM-nya --
      // ditanya-konfirmasi dulu SEBELUM trip ditutup, bukan menunggu ditandai
      // di Deteksi Anomali setelah data kesimpan. Cuma DIPERINGATKAN &
      // dikonfirmasi -- kalau sopir memang yakin ("ya"), tetap lanjut, tidak
      // ada data yang dipaksa/diblokir.
      const tripRecordBbm = state.usage.find(u => u.id === convo.tripId);
      const keluarPercentBbm = tripRecordBbm ? (tripRecordBbm.bensinKeluar != null ? Number(tripRecordBbm.bensinKeluar) : (tripRecordBbm.sisaBensin != null ? Number(tripRecordBbm.sisaBensin) : null)) : null;
      const jarakTripBbm = (convo.odometerValue != null && convo.odoKeluar != null) ? (convo.odometerValue - convo.odoKeluar) : null;
      if (keluarPercentBbm != null && jarakTripBbm != null && jarakTripBbm > 0 && car.kapasitasTangkiLiter != null) {
        const literTerpakaiTripBbm = ((keluarPercentBbm - convo.bensinKembaliPercent) / 100) * Number(car.kapasitasTangkiLiter);
        if (literTerpakaiTripBbm > 0) {
          const ratioTripBbm = jarakTripBbm / literTerpakaiTripBbm;
          const avgRatioBbm = simpleCarAvgRatio(state, car);
          const BATAS_BAWAH_RATIO = 0.5, BATAS_ATAS_RATIO = 2.0; // di luar 50%-200% rata-rata historis mobil ini
          if (avgRatioBbm != null && (ratioTripBbm < avgRatioBbm * BATAS_BAWAH_RATIO || ratioTripBbm > avgRatioBbm * BATAS_ATAS_RATIO)) {
            convo.step = 'confirm_bbm_anomaly';
            convo.bensinKembaliAngkaMentah = angka;
            await sendTg(chatId, `⚠️ Sebentar -- dari jarak ${jarakTripBbm.toLocaleString('id-ID')} KM & level BBM yang baru diketik, hasilnya sekitar ${ratioTripBbm.toFixed(1)} KM/L. Biasanya mobil ini sekitar ${avgRatioBbm.toFixed(1)} KM/L -- ini beda cukup jauh, kemungkinan salah baca/ketik levelnya.\n\nKetik <b>ya</b> kalau angkanya memang benar begitu, atau <b>tidak</b> untuk ketik ulang.`, KB_YA_TIDAK);
            return;
          }
        }
      }

      if (convo.etollCardId) {
        convo.step = 'etoll';
        await sendTg(chatId, '💳 Saldo kartu E-Toll (Rp) sekarang berapa?\n\nKalau nggak sempat cek, ketik 0. Kalau nggak lewat tol sama sekali, ketik "tidak".');
        return;
      }
      await finalizeTutupTrip(chatId, convo, null);
      delete pendingConversations[chatId];
      return;
    }

    // v3.154.0 (poin G) -- jawaban atas peringatan rasio KM/L tidak wajar di
    // atas. "ya" -> lanjut persis seperti kalau validasinya lolos dari awal
    // (etoll kalau ada, atau langsung tutup trip). "tidak" -> balik ke step
    // 'bbm', minta ketik ulang levelnya.
    if (convo.step === 'confirm_bbm_anomaly') {
      const jawaban = text.trim();
      const isYa = yaAliases().includes(jawaban);
      const isTidak = tidakAliases().includes(jawaban);
      if (isYa) {
        if (convo.etollCardId) {
          convo.step = 'etoll';
          await sendTg(chatId, '💳 Saldo kartu E-Toll (Rp) sekarang berapa?\n\nKalau nggak sempat cek, ketik 0. Kalau nggak lewat tol sama sekali, ketik "tidak".');
          return;
        }
        await finalizeTutupTrip(chatId, convo, null);
        delete pendingConversations[chatId];
        return;
      }
      if (isTidak) {
        convo.step = 'bbm';
        await sendTg(chatId, '🔁 Oke, ' + pertanyaanBbm(car));
        return;
      }
      await sendTg(chatId, 'Belum jelas 🙏 Ketik <b>ya</b> kalau levelnya memang benar begitu, atau <b>tidak</b> untuk ketik ulang.', KB_YA_TIDAK);
      return;
    }

    if (convo.step === 'etoll') {
      if (/^(tidak|nggak|enggak|gak|ga|tdk|no)\b/i.test(textRaw) || textRaw === '-') {
        convo.tidakLewatTol = true;
        convo.saldoEtollValue = null;
        await finalizeTutupTrip(chatId, convo, (trip, usageArr) => {
          const saldoAkhir = findSaldoAkhirEtollJikaTidakLewatTol(usageArr, convo);
          if (saldoAkhir != null) trip.saldoEtoll = saldoAkhir;
        });
        delete pendingConversations[chatId];
        return;
      }
      const digitSaja = textRaw.replace(/[^\d]/g, '');
      const angka = Number(digitSaja);
      if (digitSaja === '' || !isFinite(angka)) {
        await sendTg(chatId, '⚠️ Belum berupa angka yang valid. Saldo kartu E-Toll (Rp) sekarang berapa? Contoh: 50000. Atau ketik "tidak" kalau tidak lewat tol.');
        return;
      }
      if (angka === 0) {
        const tripSnapshot = state.usage.find(u => u.id === convo.tripId);
        const netTopupTrip = tripSnapshot ? usageEtollNetTopupTotal(tripSnapshot) : 0;
        if (netTopupTrip > 0) {
          convo.netTopupPendingConfirm = netTopupTrip;
          convo.step = 'etoll_confirm_zero';
          await sendTg(chatId, `⚠️ Kamu sempat isi top-up E-Toll ${fmtMoney(netTopupTrip)} di trip ini. Yakin TIDAK lewat tol sama sekali?\n\nKetik "ya" kalau yakin, atau ketik ulang saldo E-Toll sekarang (Rp) kalau ternyata ada yang kepakai.`);
          return;
        }
        convo.saldoEtollValue = null;
        await finalizeTutupTrip(chatId, convo, null);
      } else {
        convo.saldoEtollValue = angka;
        await finalizeTutupTrip(chatId, convo, (trip) => { trip.saldoEtoll = angka; });
      }
      delete pendingConversations[chatId];
      return;
    }

    if (convo.step === 'etoll_confirm_zero') {
      if (/^(ya|yakin|iya|yes|bener|betul|benar)\b/i.test(textRaw)) {
        convo.tidakLewatTol = true;
        convo.saldoEtollValue = null;
        await finalizeTutupTrip(chatId, convo, (trip, usageArr) => {
          const saldoAkhir = findSaldoAkhirEtollJikaTidakLewatTol(usageArr, convo);
          if (saldoAkhir != null) trip.saldoEtoll = saldoAkhir;
        });
        delete pendingConversations[chatId];
        return;
      }
      const digitSaja2 = textRaw.replace(/[^\d]/g, '');
      const angka2 = Number(digitSaja2);
      if (digitSaja2 === '' || !isFinite(angka2)) {
        await sendTg(chatId, `⚠️ Belum jelas. Ketik "ya" kalau yakin tidak lewat tol, atau ketik saldo E-Toll sekarang (Rp) yang sebenarnya. Contoh: 50000.`);
        return;
      }
      convo.saldoEtollValue = angka2;
      await finalizeTutupTrip(chatId, convo, (trip) => { trip.saldoEtoll = angka2; });
      delete pendingConversations[chatId];
      return;
    }
  });
}

/* ============================================================================
   ============================================================================
   ---- runNotifyCheck() -- INTI notifikasi berkala + balas chat sopir ----
   PORTING PERSIS dari telegram-notify.mjs (yang dulu dijalankan GitHub
   Actions cron). Semua RUMUS/LOGIKA sengaja disalin apa adanya (bukan
   ditulis ulang) supaya hasilnya tidak pernah beda dengan lonceng
   notifikasi di aplikasi (index.html, computeAlerts()) -- kalau nanti
   computeAlerts() di index.html diubah, SALIN ULANG perubahan yang sama
   persis ke sini juga.

   Perbedaan dari versi GitHub Actions (murni krn lingkungannya beda):
   - Baca/tulis fleetops-data.json & notif-state.json lewat GitHub Contents
     API (bukan baca file lokal hasil actions/checkout -- Worker tidak
     punya "disk" seperti runner GitHub).
   - process.exit(n) diganti jadi return{...} biasa (tidak ada proses OS
     yang perlu dihentikan di Worker).
   - process.env.GITHUB_EVENT_NAME==='workflow_dispatch' diganti jadi
     opts.isManualDispatch (dikirim eksplisit oleh pemanggil).
   ============================================================================
   ============================================================================ */
async function runNotifyCheck(env, opts) {
  const logLines = [];
  const log = (...args) => { const line = args.join(' '); console.log(line); logLines.push(line); };

  const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  // TELEGRAM_CHAT_ID sekarang boleh diisi LEBIH DARI 1 nomor, dipisah koma
  // (mis. "111111111,222222222") -- semua nomor di sini akan menerima
  // notifikasi berkala DAN notifikasi "sopir menutup trip lewat chat".
  const ADMIN_CHAT_IDS = (env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const DATA_PATH = env.FLEETOPS_DATA_PATH || 'data/fleetops-data.json';
  const dirOfData = DATA_PATH.includes('/') ? DATA_PATH.slice(0, DATA_PATH.lastIndexOf('/') + 1) : '';
  const STATE_PATH = env.FLEETOPS_NOTIF_STATE_PATH || (dirOfData + 'notif-state.json');

  if (!BOT_TOKEN) {
    log('❌ TELEGRAM_BOT_TOKEN belum diatur di dasbor Cloudflare. Berhenti.');
    return { ok: false, reason: 'no-bot-token', log: logLines };
  }

  // ---- MODE TES: kirim 1 pesan sederhana, tidak sentuh logika alert sama sekali ----
  if (opts.testChatId && !opts.testCategory) {
    log(`🔬 Mode tes -- mengirim 1 pesan percobaan ke Chat ID ${opts.testChatId}...`);
    const testText = [
      '🔬 <b>Ini pesan TES dari FleetOps</b>', '',
      'Kalau Anda menerima pesan ini, artinya notifikasi Telegram sudah tersambung dengan benar ke nomor ini.', '',
      `<i>Dikirim manual (mode tes) ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })} WIB</i>`,
    ].join('\n');
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: opts.testChatId, text: testText, parse_mode: 'HTML' })
      });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok || !resBody.ok) {
        log(`❌ Gagal kirim pesan tes ke ${opts.testChatId}:`, JSON.stringify(resBody));
        return { ok: false, reason: 'test-send-failed', log: logLines };
      }
      log(`✅ Pesan tes berhasil terkirim ke ${opts.testChatId}.`);
      return { ok: true, mode: 'test', log: logLines };
    } catch (e) {
      log(`❌ Gagal kirim pesan tes ke ${opts.testChatId}:`, e.message);
      return { ok: false, reason: 'test-send-error', log: logLines };
    }
  }

  // ---- Baca data utama ----
  let dataRead;
  try {
    dataRead = await ghReadJson(env, DATA_PATH);
  } catch (e) {
    log(`❌ Gagal baca "${DATA_PATH}":`, e.message);
    return { ok: false, reason: 'data-read-failed', log: logLines };
  }
  if (!dataRead.exists) {
    log(`ℹ️ Belum ada file data di "${DATA_PATH}" — kemungkinan belum pernah ada device yang sinkron ke repo ini. Dilewati.`);
    return { ok: true, skipped: true, log: logLines };
  }
  const raw = dataRead.json;
  const state = raw.data || {};
  state.cars = state.cars || [];
  state.usage = state.usage || [];
  state.services = state.services || [];
  state.documents = state.documents || [];
  state.drivers = state.drivers || [];
  state.etollCards = state.etollCards || [];
  // BARU -- sama seperti di processTelegramUpdate (fungsi ini scope-nya
  // TERPISAH, jadi butuh salinan sendiri): baca alias kustom Administrator
  // utk kata "batal"/"tiba"/"ya"/"tidak" yang dipakai di alur percakapan
  // notifikasi berkala (mis. konfirmasi 5-jam kirim nota) di bawah.
  state.commandAliases = state.commandAliases || {};
  function withAliases(defaults, kategori) {
    const custom = Array.isArray(state.commandAliases[kategori]) ? state.commandAliases[kategori] : [];
    const bersih = custom.map(a => String(a || '').trim().toLowerCase()).filter(Boolean);
    return Array.from(new Set([...defaults, ...bersih]));
  }
  function batalAliases(){ return withAliases(['batal'], 'batal'); }
  function tibaAliases(){ return withAliases(['akhiri trip', 'akhiritrip', 'selesai trip', 'selesaitrip'], 'tiba'); }
  function yaAliases(){ return withAliases(['ya', 'iya', 'y', 'benar', 'betul', 'yes', 'ok', 'oke'], 'ya'); }
  function tidakAliases(){ return withAliases(['tidak', 'gak', 'ga', 'enggak', 'nggak', 'no', 'salah'], 'tidak'); }
  state.bookings = state.bookings || [];
  state.notifAdmins = state.notifAdmins || []; // v3.137.0 -- admin notifikasi diatur dari app, bukan cuma env TELEGRAM_CHAT_ID
  // BARU: Admin Finance -- daftar TERPISAH TOTAL dari notifAdmins, cuma
  // dipakai pengingat "nota/tanda terima belum dikirim" di bawah (blok
  // "Pengingat 5 jam"), TIDAK ikut alur computeAlerts()/toSend biasa sama
  // sekali -- supaya perannya tidak bercampur dengan Admin Penerima
  // Notifikasi Telegram.
  state.financeAdmins = state.financeAdmins || [];
  // BARU -- Notifikasi Telegram per Peran (menu khusus Administrator, PIN
  // 009900 di web). Dibaca lewat getNotifRolePrefsTg(state) yang otomatis
  // isi default kalau kosong/belum pernah diatur -- inisialisasi {} di sini
  // cuma jaga-jaga supaya state.notifRolePrefs selalu berupa objek.
  state.notifRolePrefs = (state.notifRolePrefs && typeof state.notifRolePrefs === 'object') ? state.notifRolePrefs : {};

  /* ---- BAGIAN PORTING PERSIS dari index.html / telegram-notify.mjs (jangan diubah rumusnya sendirian) ---- */

  function today() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }); // format YYYY-MM-DD
  }

  const NOTIF_CATEGORIES = [
    { key: 'doc', prefix: 'doc-' },
    { key: 'service', prefix: 'svc-' },
    { key: 'etoll', prefix: 'etoll-' },
    { key: 'bbm', prefix: 'bbm-' },
    { key: 'booking', prefix: 'booking-h' },
    { key: 'tripLama', prefix: 'trip-lama-' },
    // BARU (menu khusus "Notifikasi Telegram per Peran") -- 3 kategori ini
    // SEBELUMNYA tidak dikenali categoryOfAlertId() sama sekali (selalu
    // dianggap Admin-only lewat targetDriverIds:[] hardcode di alert
    // creation-nya) -- sekarang perlu dikenali supaya bisa diatur lewat
    // notifRolePrefs.sopir/.finance/.admin.
    { key: 'budget', prefix: 'budget-' },
    { key: 'kalibrasi', prefix: 'kalibrasi-' },
    { key: 'speed', prefix: 'speed-' },
    // BARU -- 2 kategori GPS.id tambahan: Reminder Masa Aktif SIM GPS
    // Tracker (field expired_gsm dari /vehicle, belum pernah dipakai) &
    // Alert Bawaan GPS.id (SOS/rem mendadak/dst, dari alert/alert_data).
    { key: 'simGps', prefix: 'simgps-' },
    { key: 'gpsAlert', prefix: 'gpsalert-' },
    // BARU -- Peringatan Rute Menyimpang: posisi GPS.id trip aktif (>1
    // tujuan) konsisten menjauh dari titik tujuan berikutnya. Info ringan
    // ke admin, bukan larangan -- lihat catatan lengkap di
    // computeRouteDeviationFlags().
    { key: 'routeDeviation', prefix: 'routedev-' },
    // BARU -- Notifikasi Mesin Dinyalakan (Telegram, lewat cron/worker --
    // beda dari popup "Mesin Dinyalakan" di index.html yang cuma tampil di
    // layar kalau aplikasi web sedang dibuka). v3.271.0: deteksi transisi
    // OFF->ON yang presisi -- lihat blok "Notifikasi Mesin Dinyalakan" di
    // computeAlerts() untuk detailnya.
    { key: 'engineOn', prefix: 'engineon-' },
  ];
  function categoryOfAlertId(id) {
    const found = NOTIF_CATEGORIES.find(c => id.startsWith(c.prefix));
    return found ? found.key : null;
  }
  // v3.282.0 -- BARU: label singkat per kategori, KHUSUS dipakai teks tombol
  // rekomendasi "🔕 Matikan notifikasi ini" (lihat blok pengiriman alert di
  // bawah + handler `notifperan:suggest:` di processTelegramUpdateInner).
  // SENGAJA daftar TERPISAH dari `NOTIF_PERAN_KATEGORI_ALIASES` (nested di
  // processTelegramUpdateInner, closure BEDA yang tidak bisa diakses dari
  // sini) -- BUKAN duplikasi berbahaya krn cuma dipakai utk teks tombol
  // (kosmetik), bukan logika bisnis; kalaupun labelnya sempat tidak sinkron
  // (mis. lupa update salah satu setelah kategori baru ditambah), akibatnya
  // PALING BURUK cuma teks tombol generik/kurang rapi -- BUKAN salah kategori
  // yang ke-toggle (itu tetap dijamin benar oleh key, bukan label). Kalau
  // menambah kategori alert baru ke `NOTIF_CATEGORIES` di atas, sebaiknya
  // (tidak wajib) ikut tambahkan baris label singkatnya di sini juga.
  const NOTIF_KATEGORI_LABEL_SINGKAT_TG = {
    doc: 'Dokumen Kadaluarsa', service: 'Servis/Ganti Oli', etoll: 'Saldo E-Toll Rendah', bbm: 'BBM Menipis',
    booking: 'Reminder Booking', tripLama: 'Trip Kelamaan', budget: 'Budget Bulanan', kalibrasi: 'Kalibrasi Odometer GPS.id',
    speed: 'Kecepatan Berlebih', simGps: 'Masa Aktif SIM GPS Tracker', gpsAlert: 'Alert Bawaan GPS.id',
    routeDeviation: 'Peringatan Rute Menyimpang', engineOn: 'Mesin Dinyalakan',
  };
  // v3.282.0 -- BARU: bangun 1 tombol rekomendasi cepat "🔕 Matikan notifikasi
  // ini" KALAU DAN HANYA KALAU pesan yang mau dikirim isinya cuma 1 kategori
  // (menyerah/tidak menempelkan tombol apa pun kalau alert-nya gabungan >1
  // kategori sekaligus -- SENGAJA, prinsip sama dgn `wholeWordCategoryScan()`/
  // `cariKataBaruUntukDipelajari()`: kalau ambigu kategori mana yang dimaksud
  // "notifikasi ini", jangan menebak). `peranKey` HARUS salah satu yang admin
  // penerimanya benar2 lolos isAdminOrSuperAdmin() di pemanggil (lihat
  // pengaman berlapis di handler `notifperan:suggest:`) -- fungsi ini sendiri
  // tidak mengecek izin, itu tanggung jawab pemanggil.
  function buildNotifRekomendasiKeyboard(alertsUntukPesanIni, peranKey) {
    const katUnik = [...new Set(alertsUntukPesanIni.map(a => categoryOfAlertId(a.id)).filter(Boolean))];
    if (katUnik.length !== 1) return null;
    const kat = katUnik[0];
    const labelKat = NOTIF_KATEGORI_LABEL_SINGKAT_TG[kat] || kat;
    return [[{ text: `🔕 Matikan notifikasi "${labelKat}" ini`, callback_data: `notifperan:suggest:${kat}:${peranKey}:0` }]];
  }
  // BARU -- porting PERSIS dari getNotifRolePrefs()/NOTIF_ROLE_PREFS_DEFAULT
  // di index.html (menu khusus Administrator, PIN 009900). Kalau nanti default
  // di sana diubah, ubah juga persis di sini.
  const NOTIF_ROLE_PREFS_DEFAULT = {
    sopir:   { doc: true, service: true, etoll: true, bbm: true, booking: true, tripLama: true, budget: false, kalibrasi: false, speed: false, simGps: false, gpsAlert: false, routeDeviation: false, engineOn: false },
    finance: { doc: true, service: true, etoll: false, bbm: false, booking: false, tripLama: false, budget: false, kalibrasi: false, speed: false, simGps: false, gpsAlert: false, routeDeviation: false, engineOn: false },
    admin:   { doc: true, service: true, etoll: true, bbm: true, booking: true, tripLama: true, budget: true, kalibrasi: true, speed: true, simGps: true, gpsAlert: true, routeDeviation: true, engineOn: true },
    // v3.184.0 -- Administrator sekarang juga ikut diatur (kolom "👑 Super
    // Admin" di menu Notifikasi Telegram per Peran). Default 9 kategori
    // alert ini meniru PERSIS perilaku lama (dulu Administrator selalu dapat
    // semua) -- resi/bookingApproval/laporanBulanan TIDAK dimasukkan di sini
    // (defaultnya OFF, dibaca via `=== true`, bukan lewat objek default ini
    // -- lihat blok masing-masing di bawah).
    // engineOn (Mesin Dinyalakan) dikembalikan ke default AKTIF (Agu 2026) --
    // sebelumnya sempat dimatikan karena badan pesannya kelihatan kosong,
    // tapi itu sudah diperbaiki (lihat bugfix di buildAlertMessageText di
    // atas) DAN keterangannya sudah ditulis ulang lebih profesional (lihat
    // blok "Notifikasi Mesin Dinyalakan" di computeAlerts()), jadi aman
    // dinyalakan lagi.
    superadmin: { doc: true, service: true, etoll: true, bbm: true, booking: true, tripLama: true, budget: true, kalibrasi: true, speed: true, simGps: true, gpsAlert: true, routeDeviation: true, engineOn: true },
  };
  function getNotifRolePrefsTg(state) {
    const saved = (state.notifRolePrefs && typeof state.notifRolePrefs === 'object') ? state.notifRolePrefs : {};
    const out = {};
    for (const peran of ['sopir', 'finance', 'admin', 'superadmin']) {
      out[peran] = { ...NOTIF_ROLE_PREFS_DEFAULT[peran], ...(saved[peran] || {}) };
    }
    return out;
  }
  function alertsForDriver(allAlerts, driver, rolePrefsSopir) {
    const kategoriDipilih = Array.isArray(driver.notifKategori) ? driver.notifKategori : null;
    return allAlerts.filter(a => {
      const kategori = categoryOfAlertId(a.id);
      // BARU -- gerbang level-PERAN (menu khusus Administrator) dulu, di ATAS
      // langganan per-driver yang sudah ada -- kalau perannya (Sopir) saja
      // sudah dimatikan utk kategori ini, tidak peduli langganan individual
      // si sopir, tetap tidak dikirim.
      if (kategori && rolePrefsSopir && rolePrefsSopir[kategori] === false) return false;
      if (kategori !== 'booking' && kategoriDipilih && !kategoriDipilih.includes(kategori)) return false;
      if (Array.isArray(a.targetDriverIds) && !a.targetDriverIds.includes(driver.id)) return false;
      return true;
    });
  }

  const NOTIF_SETTINGS_DEFAULT = { docExpiryDays: 30, serviceWarnPct: 80, bbmMinDefault: 20, etollMinDefault: 25000, budgetWarnPct: 80, checkIntervalMinutes: 60, tripDurationWarnHours: 24,
    // v3.262.0 -- SALINAN PERSIS dari NOTIF_SETTINGS_DEFAULT di index.html --
    // lihat catatan lengkap di sana. Dibaca di dueForAlertCheck di bawah.
    reminderMode: 'fixed', reminderFixedHourWib: 8,
    // v3.147.0 -- SALINAN PERSIS dari NOTIF_SETTINGS_DEFAULT di index.html --
    // lihat catatan Alert Kecepatan Berlebih di sana.
    speedAlertEnabled: true, speedLimitKmh: 120, speedAlertCooldownMinutes: 15,
    // v3.151.0 -- SALINAN PERSIS dari NOTIF_SETTINGS_DEFAULT di index.html --
    // lihat catatan Pengingat Kalibrasi Odometer GPS.id di sana.
    kalibrasiGpsEnabled: true, kalibrasiGpsIntervalHari: 30,
    // BARU -- SALINAN PERSIS dari NOTIF_SETTINGS_DEFAULT di index.html --
    // lihat catatan Peringatan Rute Menyimpang di sana. minCyclesStreak=3 ->
    // harus menjauh 3x cron BERTURUT-TURUT (±15 menit, cron tiap 5 menit)
    // baru dianggap sinyal valid, bukan cuma 1x kebetulan. minIncreaseMeters
    // =200 -> kenaikan jarak per siklus wajib >200m spy tidak salah tangkap
    // gara-gara ketidakakuratan GPS/pembulatan kecil.
    routeDeviationEnabled: true, routeDeviationCooldownMinutes: 30, routeDeviationMinCyclesStreak: 3, routeDeviationMinIncreaseMeters: 200,
    // v3.229.0 -- SALINAN PERSIS dari NOTIF_SETTINGS_DEFAULT di index.html --
    // lihat catatan Auto-deteksi Sampai di sana. radiusMeters=300 & maxSpeedKmh=5
    // dipilih supaya "kelihatan dekat & berhenti" cukup yakin sebelum nanya
    // (radius sekecil ini jarang salah tangkap "cuma lewat depan").
    geofenceArrivalEnabled: true, geofenceArrivalRadiusMeters: 300, geofenceArrivalMaxSpeedKmh: 5,
    // BARU -- SALINAN PERSIS dari NOTIF_SETTINGS_DEFAULT di index.html --
    // lihat catatan "Notifikasi Mesin Dinyalakan" di computeAlerts(). v3.271.0:
    // deteksi transisi OFF->ON yang presisi (BUKAN lagi pola cooldown/bucket
    // spt Alert Kecepatan) -- engineOnCooldownMinutes sekarang cuma jaga-jaga
    // anti-flapping (kontak mati-nyala cepat berkali-kali), bukan interval
    // pengulangan normal. Default penerima HANYA Admin/Super Admin (lihat
    // NOTIF_ROLE_PREFS_DEFAULT.engineOn), bisa dibuka ke Sopir/Finance lewat
    // menu "Notifikasi Telegram per Peran" kapan saja tanpa ubah kode.
    engineOnAlertEnabled: true, engineOnCooldownMinutes: 30,
    // v3.261.0 -- SALINAN PERSIS dari NOTIF_SETTINGS_DEFAULT di index.html --
    // lihat catatan lengkap di sana. Dibaca di runWeeklyPatternAnalysis()
    // sebelum mengirim pertanyaan "jadikan Data Tujuan?" ke admin.
    polaKunjunganTanyaEnabled: true };
  function getNotifSettings() {
    return { ...NOTIF_SETTINGS_DEFAULT, ...(state.notifSettings || {}) };
  }

  function daysBetween(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const t = new Date(today() + 'T00:00:00');
    return Math.round((d - t) / 86400000);
  }
  function fmtMoney(n) {
    n = Number(n) || 0;
    return 'Rp ' + n.toLocaleString('id-ID');
  }
  function carLabel(carId) {
    const c = state.cars.find(x => x.id === carId);
    return c ? (c.merk + ' ' + c.modelMobil + ' — ' + c.plat) : '(mobil telah dihapus)';
  }
  function driverLabel(driverId, legacyDriverText) {
    if (driverId) {
      const d = state.drivers.find(x => x.id === driverId);
      if (d) return d.nama;
      return legacyDriverText || '(sopir telah dihapus)';
    }
    return legacyDriverText || '-';
  }
  // v3.138.0 -- PORTING PERSIS dari subjectLabel() di index.html. Dokumen
  // sekarang bisa milik Mobil ATAU Sopir (d.subjek) -- lihat catatan
  // lengkapnya di index.html.
  function subjectLabel(d) {
    return d.subjek === 'sopir' ? driverLabel(d.driverId) : carLabel(d.carId);
  }
  function getTripDurationMinutes(u) {
    if (!u.tglKeluar || !u.tglKembali) return null;
    const start = new Date(u.tglKeluar + 'T' + (u.jamKeluar || '00:00') + ':00');
    const end = new Date(u.tglKembali + 'T' + (u.jamKembali || '00:00') + ':00');
    if (isNaN(start) || isNaN(end)) return null;
    const diffMin = Math.round((end - start) / 60000);
    return diffMin >= 0 ? diffMin : null;
  }
  function convertBarToPercent(barCount, maxBar) {
    if (barCount == null || barCount === '' || !maxBar) return null;
    return (Number(barCount) / Number(maxBar)) * 100;
  }
  function fmtDurationMinutes(mins) {
    if (mins == null || !isFinite(mins) || mins < 0) return '-';
    mins = Math.round(mins);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;
    const parts = [];
    if (days > 0) parts.push(days + ' hari');
    if (hours > 0) parts.push(hours + ' jam');
    if (minutes > 0 || parts.length === 0) parts.push(minutes + ' menit');
    return parts.join(' ');
  }
  function usageBiayaOpItems(u) { return Array.isArray(u.biayaOperasional) ? u.biayaOperasional : []; }
  // PORTING PERSIS dari index.html -- dipakai fitur Budget Bulanan di bawah.
  function serviceItems(s) {
    if (Array.isArray(s.items)) return s.items;
    if (s.jenis) return [{ id: 'legacy-' + s.id, kategori: s.jenis, biaya: Number(s.biaya) || 0, catatan: s.catatan || '' }];
    return [];
  }
  // v3.137.0 -- Budget Bulanan per mobil (lihat computeAlerts() di bawah):
  // rumus grandTotal PERSIS SAMA dengan computeMonthlyReport() di index.html
  // (BBM + Tol + Operasional-lain[bukan trip Pribadi] + Servis), supaya
  // angkanya selalu konsisten dengan yang dilihat admin di Laporan Bulanan.
  function computeMonthlyCostForCar(carId, yearMonth) {
    const trips = state.usage.filter(u => u.carId === carId && (u.tglKeluar || '').startsWith(yearMonth));
    const biayaBbm = trips.reduce((sum, u) => sum + (Number(u.biayaBensin) || 0), 0);
    const biayaTol = trips.reduce((sum, u) => { const info = getBiayaTolTerpakai(u); return sum + (info ? info.biayaTol : 0); }, 0);
    const biayaOperasional = trips.reduce((sum, u) => {
      if (u.jenisPenggunaan === 'pribadi') return sum;
      return sum + usageBiayaOpItems(u).filter(it => it.kategori !== 'Isi BBM' && it.kategori !== 'Isi E-Toll').reduce((s, it) => s + (Number(it.nominal) || 0), 0);
    }, 0);
    const biayaServis = state.services
      .filter(s => s.carId === carId && (s.tanggal || '').startsWith(yearMonth))
      .reduce((sum, s) => sum + serviceItems(s).reduce((s2, it) => s2 + (Number(it.biaya) || 0), 0), 0);
    return biayaBbm + biayaTol + biayaOperasional + biayaServis;
  }
  function usageEtollNetTopupTotal(u) {
    return usageBiayaOpItems(u)
      .filter(it => it.kategori === 'Isi E-Toll')
      .reduce((sum, it) => sum + ((Number(it.nominal) || 0) - (Number(it.biayaAdmin) || 0)), 0);
  }
  function usageEtollTimeKey(u) {
    return (u.tglKembali || u.tglKeluar || '') + (u.jamKembali || u.jamKeluar || '');
  }
  function getBiayaTolTerpakai(u) {
    if (u.status !== 'selesai' || u.saldoEtoll == null) return null;
    let saldoAwal = (u.saldoEtollAwal != null) ? Number(u.saldoEtollAwal) : null;
    if (saldoAwal == null) {
      if (!u.etollCardId) return null;
      const timeKeyU = usageEtollTimeKey(u);
      const kandidat = state.usage
        .filter(x => x.id !== u.id && x.etollCardId === u.etollCardId && x.status === 'selesai' && x.saldoEtoll != null && usageEtollTimeKey(x) <= timeKeyU)
        .sort((a, b) => usageEtollTimeKey(b).localeCompare(usageEtollTimeKey(a)));
      if (kandidat.length === 0) return null;
      saldoAwal = Number(kandidat[0].saldoEtoll);
    }
    const netTopup = usageEtollNetTopupTotal(u);
    const biayaTol = saldoAwal + netTopup - Number(u.saldoEtoll);
    return { biayaTol };
  }
  function escapeHtmlTg(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
  }
  function buildTripReceiptText(u) {
    const jarak = (u.odoKeluar != null && u.odoKembali != null && u.odoKembali >= u.odoKeluar) ? (u.odoKembali - u.odoKeluar) : null;
    const biayaTolInfo = getBiayaTolTerpakai(u);
    const biayaTol = biayaTolInfo ? biayaTolInfo.biayaTol : 0;
    const biayaOpItems = usageBiayaOpItems(u);
    const biayaOpTotalUntukTotal = biayaOpItems
      .filter(it => it.kategori !== 'Isi BBM' && it.kategori !== 'Isi E-Toll')
      .reduce((sum, it) => sum + (Number(it.nominal) || 0), 0);
    const grandTotal = (Number(u.biayaBensin) || 0) + biayaTol + biayaOpTotalUntukTotal;
    const lines = [
      `🧾 <b>Tanda Terima Perjalanan</b>`, '',
      `<b>Mobil:</b> ${escapeHtmlTg(carLabel(u.carId))}`,
      `<b>Sopir:</b> ${escapeHtmlTg(driverLabel(u.driverId, u.driver))}`,
      `<b>Jenis:</b> ${u.jenisPenggunaan === 'pribadi' ? '🏠 Pribadi' : '🧾 Operasional'}`,
      `<b>Tujuan:</b> ${escapeHtmlTg(u.tujuan || '-')}${(Array.isArray(u.tujuanTambahan) && u.tujuanTambahan.length) ? ' + ' + u.tujuanTambahan.length + ' tujuan lainnya (' + escapeHtmlTg(u.tujuanTambahan.join(', ')) + ')' : ''}`,
      `<b>Berangkat:</b> ${escapeHtmlTg(u.tglKeluar || '-')}${u.jamKeluar ? ', ' + u.jamKeluar : ''}`,
      `<b>Tiba:</b> ${u.tglKembali ? escapeHtmlTg(u.tglKembali) + (u.jamKembali ? ', ' + u.jamKembali : '') : '-'}`,
      `<b>Durasi:</b> ${fmtDurationMinutes(getTripDurationMinutes(u))}`, '',
      `Jarak Tempuh: ${jarak != null ? jarak.toLocaleString('id-ID') + ' KM' : '-'}`,
    ];
    if (u.literBensin) lines.push(`<b>Total BBM Diisi:</b> ${u.literBensin} L`);
    lines.push(`<b>Biaya BBM (total):</b> ${fmtMoney(u.biayaBensin || 0)}`);
    biayaOpItems.filter(it => it.kategori === 'Isi BBM').forEach(it => {
      lines.push(`   ↳ <i>${escapeHtmlTg(it.jenisBbm || 'BBM')}${it.catatan ? ' — ' + escapeHtmlTg(it.catatan) : ''}: ${fmtMoney(it.nominal)}</i>`);
    });
    if (biayaTolInfo) lines.push(`<b>Biaya Tol (total):</b> ${fmtMoney(biayaTol)}`);
    biayaOpItems.filter(it => it.kategori === 'Isi E-Toll').forEach(it => {
      lines.push(`   ↳ <i>${it.catatan ? escapeHtmlTg(it.catatan) : 'Isi E-Toll'}: ${fmtMoney(it.nominal)}</i>`);
    });
    const adaIsiEtollTg = biayaOpItems.some(it => it.kategori === 'Isi E-Toll');
    if (adaIsiEtollTg || u.saldoEtoll != null) {
      const linkedCardTg = u.etollCardId ? state.etollCards.find(c => c.id === u.etollCardId) : null;
      const nomorRingkasTg = linkedCardTg ? (linkedCardTg.nomorKartu.length > 4 ? '•••• ' + linkedCardTg.nomorKartu.slice(-4) : linkedCardTg.nomorKartu) : '';
      lines.push(`<b>Saldo E-Toll${nomorRingkasTg ? ' (' + nomorRingkasTg + ')' : ''}:</b> ${u.saldoEtoll != null ? fmtMoney(u.saldoEtoll) : '-'}`);
    }
    const itemLain = biayaOpItems.filter(it => it.kategori !== 'Isi BBM' && it.kategori !== 'Isi E-Toll');
    if (itemLain.length > 0) {
      lines.push('');
      lines.push('<b>Biaya Lain-lain:</b>');
      itemLain.forEach(it => {
        lines.push(`<b>${escapeHtmlTg(it.kategori)}</b>${it.catatan ? ' (' + escapeHtmlTg(it.catatan) + ')' : ''}: ${fmtMoney(it.nominal)}`);
      });
    }
    lines.push('');
    lines.push(`<b>TOTAL BIAYA: ${fmtMoney(grandTotal)}</b>`);
    lines.push('');
    lines.push(`<i>Dikirim otomatis begitu perjalanan ditandai selesai. Detail lengkap (termasuk Efisiensi BBM) ada di aplikasi FleetOps.</i>`);
    return lines.join('\n');
  }

  function convertPercentToBar(percent, maxBar) {
    if (percent == null || percent === '' || !maxBar) return null;
    return Math.round((Number(percent) / 100) * Number(maxBar));
  }
  function formatBensinDisplay(percentValue, car) {
    if (percentValue == null || isNaN(percentValue)) return null;
    if (car && car.tipeIndikatorBbm === 'bar') {
      const maxBar = car.maxBarBbm || 8;
      const bar = convertPercentToBar(percentValue, maxBar);
      return `${bar} Bar`;
    }
    return `${percentValue}%`;
  }
  function monthsBetween(dateStr, todayStr) {
    const d1 = new Date(dateStr + 'T00:00:00');
    const d2 = new Date(todayStr + 'T00:00:00');
    return (d2 - d1) / (1000 * 60 * 60 * 24 * 30.44);
  }
  const RATA2_KM_HARIAN_JENDELA_HARI = 90;
  function computeAvgKmPerDay(carId) {
    const batasBawah = new Date();
    batasBawah.setDate(batasBawah.getDate() - RATA2_KM_HARIAN_JENDELA_HARI);
    const batasBawahStr = batasBawah.toISOString().slice(0, 10);
    const trips = state.usage.filter(u => u.carId === carId && (u.tglKeluar || '') >= batasBawahStr);
    const totalKm = trips.reduce((sum, u) => {
      if (u.odoKeluar != null && u.odoKembali != null && u.odoKembali >= u.odoKeluar) return sum + (u.odoKembali - u.odoKeluar);
      return sum;
    }, 0);
    if (totalKm <= 0) return null;
    return totalKm / RATA2_KM_HARIAN_JENDELA_HARI;
  }
  // v4.0 -- REFACTOR: dipecah jadi pengingat generik per-kategori (Ganti Oli
  // & Servis Berkala, masing2 interval & acuan catatan terakhirnya sendiri),
  // konsisten dengan refactor yang sama di index.html & closure lain di file
  // ini (processTelegramUpdate). Dua alert independen dibangun dari sini:
  // svc-oli-<carId> dan svc-berkala-<carId> (lihat pemanggilnya di bawah).
  function computeMaintenanceReminder(car, opts) {
    const { kategori, intervalKm, intervalBulan, labelBelumAda, labelSudahWaktunya, labelSegera, labelMasihJauh } = opts;
    if (!intervalKm && !intervalBulan) return null;
    const lastRecord = state.services
      .filter(s => s.carId === car.id && serviceItems(s).some(it => (it.kategori || '').trim() === kategori))
      .sort((a, b) => b.tanggal.localeCompare(a.tanggal))[0];
    if (!lastRecord) return { level: 'warn', text: labelBelumAda };
    let pctKm = null, pctBulan = null;
    if (intervalKm && lastRecord.odometer != null && car.odometerSaatIni != null) {
      pctKm = (car.odometerSaatIni - lastRecord.odometer) / intervalKm;
    }
    if (intervalBulan) pctBulan = monthsBetween(lastRecord.tanggal, today()) / intervalBulan;
    if (pctKm === null && pctBulan === null) return { level: 'warn', text: 'Data odometer belum cukup untuk hitung pengingat' };
    const pct = Math.max(pctKm || 0, pctBulan || 0);
    let perkiraanTanggal = null;
    if (intervalBulan && lastRecord.tanggal) {
      const d = new Date(lastRecord.tanggal);
      d.setMonth(d.getMonth() + intervalBulan);
      perkiraanTanggal = d;
    }
    if (intervalKm && lastRecord.odometer != null && car.odometerSaatIni != null) {
      const avgKmPerDay = computeAvgKmPerDay(car.id);
      if (avgKmPerDay && avgKmPerDay > 0) {
        const dKm = new Date(lastRecord.tanggal);
        dKm.setDate(dKm.getDate() + Math.round(intervalKm / avgKmPerDay));
        if (!perkiraanTanggal || dKm < perkiraanTanggal) perkiraanTanggal = dKm;
      }
    }
    const perkiraanText = perkiraanTanggal
      ? ` (perkiraan ${perkiraanTanggal.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })})`
      : '';
    if (pct >= 1) return { level: 'danger', text: labelSudahWaktunya };
    if (pct >= (getNotifSettings().serviceWarnPct / 100)) return { level: 'warn', text: labelSegera + perkiraanText };
    return { level: 'ok', text: labelMasihJauh + perkiraanText };
  }
  function oilReminderInfo(car) {
    return computeMaintenanceReminder(car, {
      kategori: 'Ganti Oli', intervalKm: car.intervalKm, intervalBulan: car.intervalBulan,
      labelBelumAda: 'Belum ada riwayat Ganti Oli tercatat',
      labelSudahWaktunya: 'Sudah waktunya ganti oli',
      labelSegera: 'Segera ganti oli (mendekati jadwal)',
      labelMasihJauh: 'Ganti oli masih jauh'
    });
  }
  function serviceReminderInfo(car) { return oilReminderInfo(car); }
  function servisBerkalaReminderInfo(car) {
    return computeMaintenanceReminder(car, {
      kategori: 'Servis Berkala / Tune Up', intervalKm: car.intervalKmServis, intervalBulan: car.intervalBulanServis,
      labelBelumAda: 'Belum ada riwayat Servis Berkala tercatat',
      labelSudahWaktunya: 'Sudah waktunya servis berkala',
      labelSegera: 'Segera servis berkala (mendekati jadwal)',
      labelMasihJauh: 'Servis berkala masih jauh'
    });
  }
  function getBensinKeluar(u) {
    if (u.bensinKeluar != null) return Number(u.bensinKeluar);
    if (u.sisaBensin != null) return Number(u.sisaBensin);
    return null;
  }
  function getBensinKembali(u) {
    return u.bensinKembali != null ? Number(u.bensinKembali) : null;
  }
  function getBensinTerkini(u) {
    const k = getBensinKembali(u);
    if (k != null) return k;
    return getBensinKeluar(u);
  }
  function fuelBatasFor(car) {
    return car.batasMinimumBensin != null ? Number(car.batasMinimumBensin) : getNotifSettings().bbmMinDefault;
  }
  function fuelLatestReading(carId) {
    return state.usage
      .filter(u => u.carId === carId && getBensinTerkini(u) != null)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  }

  // v3.138.0 -- PORTING PERSIS dari DOC_EXPIRY_MILESTONES_DAYS + computeAlerts()
  // di index.html (jangan diubah sendirian di 1 sisi saja -- lihat catatan
  // lengkap alasannya di index.html). Titik pengingat TETAP: ~2 bulan (60
  // hari), ~1 bulan (30 hari), 1 minggu (7 hari) sebelum kadaluarsa, plus
  // begitu sudah lewat (danger, terus muncul sampai diperpanjang). Berlaku
  // utk dokumen Mobil MAUPUN Sopir (d.subjek).
  const DOC_EXPIRY_MILESTONES_DAYS = [60, 30, 7];
  function docExpiryAlertLevel(sisa) {
    if (sisa < 0) return 'danger';
    if (sisa <= 7) return 'danger';
    return 'warn';
  }

  function computeAlerts() {
    const alerts = [];
    const ns = getNotifSettings();

    state.documents.forEach(d => {
      const sisa = daysBetween(d.tglExpired);
      const isMilestone = sisa < 0 || DOC_EXPIRY_MILESTONES_DAYS.some(m => sisa <= m);
      if (isMilestone) {
        alerts.push({
          id: 'doc-' + d.id,
          ic: sisa < 0 ? '⛔' : '📄', level: docExpiryAlertLevel(sisa),
          judul: `${d.jenis} ${sisa < 0 ? 'kedaluwarsa' : 'akan habis'}`,
          keterangan: `${subjectLabel(d)} — ${sisa < 0 ? Math.abs(sisa) + ' hari lalu' : sisa + ' hari lagi'}. Dapat diabaikan apabila dokumen sudah diperpanjang.`,
          // Dokumen Sopir (SIM, dll) dikirim LANGSUNG cuma ke sopir
          // bersangkutan -- dokumen Mobil tetap disiarkan seperti biasa.
          targetDriverIds: (d.subjek === 'sopir' && d.driverId) ? [d.driverId] : null,
        });
      }
    });

    // v4.0 -- Ganti Oli & Servis Berkala sekarang 2 alert INDEPENDEN (dulu
    // digabung jadi satu "Servis/Ganti Oli" yang cuma menghitung Ganti Oli
    // saja). Masing2 SENGAJA ikut ditarget ke sopir yg SEDANG memakai mobil
    // ini ("sopir terkait") lewat targetDriverIds -- bukan cuma disiarkan ke
    // semua sopir (targetDriverIds:null) atau cuma Admin (targetDriverIds:[]).
    // Kalau tidak ada sopir yg sedang memakai, targetDriverIds:[] (Admin/
    // Finance/Administrator saja) -- tidak ada gunanya "menebak" sopir lain yg
    // kebetulan pernah pakai mobil ini tapi tidak sedang bertanggung jawab.
    function sopirTerkaitUntukMobil(carId) {
      const aktif = state.usage.find(u => u.carId === carId && u.status === 'digunakan' && u.driverId);
      return aktif ? [aktif.driverId] : [];
    }
    state.cars.forEach(c => {
      const targetDriverIds = sopirTerkaitUntukMobil(c.id);
      const rOli = oilReminderInfo(c);
      if (rOli && (rOli.level === 'warn' || rOli.level === 'danger')) {
        alerts.push({ id: 'svc-oli-' + c.id, ic: '🔧', level: rOli.level, judul: 'Ganti Oli', keterangan: `${carLabel(c.id)} — ${rOli.text}`, targetDriverIds });
      }
      const rServis = servisBerkalaReminderInfo(c);
      if (rServis && (rServis.level === 'warn' || rServis.level === 'danger')) {
        alerts.push({ id: 'svc-berkala-' + c.id, ic: '🔧', level: rServis.level, judul: 'Servis Berkala', keterangan: `${carLabel(c.id)} — ${rServis.text}`, targetDriverIds });
      }
    });

    state.etollCards.forEach(card => {
      const batas = card.batasMinimum != null ? Number(card.batasMinimum) : ns.etollMinDefault;
      const saldo = Number(card.saldo) || 0;
      if (saldo < batas) {
        alerts.push({ id: 'etoll-' + card.id, ic: '💳', level: 'danger', judul: 'Saldo E-Toll rendah', keterangan: `${card.nomorKartu} — ${fmtMoney(saldo)}` });
      }
    });

    state.cars.forEach(c => {
      const latest = fuelLatestReading(c.id);
      const sisaTerkini = latest ? getBensinTerkini(latest) : null;
      if (sisaTerkini != null) {
        const batas = fuelBatasFor(c);
        if (sisaTerkini < batas) {
          alerts.push({ id: 'bbm-' + c.id, ic: '⛽', level: sisaTerkini <= batas / 2 ? 'danger' : 'warn', judul: 'BBM menipis', keterangan: `${carLabel(c.id)} — sisa ${formatBensinDisplay(sisaTerkini, c)}` });
        }
      }
    });

    // v3.137.0 -- Budget/Limit Biaya Bulanan per mobil -- PORTING PERSIS dari
    // index.html. targetDriverIds: null -- BUKAN lagi array kosong hardcode
    // spt sebelumnya. Sekarang siapa yang boleh terima diatur lewat menu
    // khusus Administrator "Notifikasi Telegram per Peran" (rolePrefs.sopir.
    // budget, default MATI -- budget tetap urusan pengelola sampai Super
    // Admin sendiri yang menyalakannya utk Sopir).
    const bulanIniStr = today().slice(0, 7);
    state.cars.forEach(c => {
      const budget = Number(c.budgetBulanan) || 0;
      if (budget <= 0) return;
      const totalBiaya = computeMonthlyCostForCar(c.id, bulanIniStr);
      const pct = totalBiaya / budget;
      if (pct >= (ns.budgetWarnPct / 100)) {
        alerts.push({
          id: 'budget-' + c.id, ic: '💰', level: pct >= 1 ? 'danger' : 'warn',
          judul: pct >= 1 ? 'Budget bulanan terlampaui' : 'Mendekati budget bulanan',
          keterangan: `${carLabel(c.id)} — ${fmtMoney(totalBiaya)} dari ${fmtMoney(budget)} (${Math.round(pct * 100)}%)`,
          targetDriverIds: null,
        });
      }
    });

    // v3.151.0 -- Pengingat Kalibrasi Odometer GPS.id. targetDriverIds: null
    // -- lihat catatan menu khusus Administrator di atas (rolePrefs.sopir.
    // kalibrasi, default MATI).
    // v3.230.0 -- BARU: kalau mobil punya car.lastKalibrasiAt (ditandai lewat
    // perintah bot "kalibrasi" -- lihat handler di processTelegramUpdate()),
    // pengingat dihitung PER-MOBIL dari tanggal itu (belum jatuh tempo ->
    // alert dilewati SAMA SEKALI, bukan cuma dedup) -- lebih akurat drpd
    // sebelumnya yg pakai "bucket" hari GLOBAL (kelipatan
    // kalibrasiGpsIntervalHari sejak epoch, SAMA rata utk semua mobil, tidak
    // peduli kapan mobil itu SUNGGUHAN terakhir dikalibrasi). Mobil yang
    // belum PERNAH ditandai lewat perintah itu (lastKalibrasiAt kosong)
    // TETAP pakai fallback bucket lama PERSIS spt sebelumnya -- supaya
    // perilaku default tidak berubah diam-diam sampai fitur baru ini
    // sungguh dipakai.
    if (ns.kalibrasiGpsEnabled !== false) {
      const kalibrasiIntervalHari = Math.max(1, Number(ns.kalibrasiGpsIntervalHari) || 30);
      const kalibrasiIntervalMs = kalibrasiIntervalHari * 86400000;
      const kalibrasiBucket = Math.floor(Math.floor(Date.now() / 86400000) / kalibrasiIntervalHari);
      state.cars.forEach(c => {
        if (!c.imeiGps) return;
        let idSuffix;
        if (c.lastKalibrasiAt) {
          const msSinceKalibrasi = Date.now() - c.lastKalibrasiAt;
          if (msSinceKalibrasi < kalibrasiIntervalMs) return; // belum jatuh tempo -- tidak dibuat sama sekali
          // Sudah lewat jatuh tempo -> re-fire tiap kelipatan interval
          // berikutnya (pola sama dgn bucket lama: id ikut berubah tiap
          // kelipatan, supaya alert BOLEH terkirim ULANG kalau dibiarkan
          // lama, bukan cuma sekali lalu diam selamanya).
          idSuffix = `sejak${c.lastKalibrasiAt}-${Math.floor(msSinceKalibrasi / kalibrasiIntervalMs)}`;
        } else {
          idSuffix = `bucket${kalibrasiBucket}`; // fallback lama -- mobil ini belum pernah ditandai via perintah "kalibrasi"
        }
        alerts.push({
          id: `kalibrasi-${c.id}-${idSuffix}`,
          ic: '🛰️', level: 'warn',
          judul: 'Kalibrasi Odometer GPS.id',
          keterangan: `${carLabel(c.id)} — bandingkan odometer dashboard asli dengan GPS.id, reset kalau selisihnya sudah jauh. Caranya: buka gps.id/v3/vehicle → Vehicle Management → klik ikon Mileage di baris mobil ini → sesuaikan "New Mileage" (odometer asli KM × 1000, dalam meter) → klik Reset Mileage. Pengingat rutin tiap ${kalibrasiIntervalHari} hari. Sudah dikalibrasi? Ketik "kalibrasi" di chat Telegram ini (Operator/Administrator) untuk reset pengingat ini.`,
          targetDriverIds: null,
        });
      });
    }

    // v3.147.0 -- Alert Kecepatan Berlebih. Kecepatan diambil dari GPS.id
    // SEKALI di awal runNotifyCheck() lewat getGpsIdSpeedMap() (bukan fetch
    // di sini -- computeAlerts() harus tetap fungsi sinkron), hasilnya
    // dioper lewat closure `gpsSpeedMap`. targetDriverIds: null -- lihat
    // catatan menu khusus Administrator di atas (rolePrefs.sopir.speed,
    // default MATI). Beda dari alert lain: id memakai
    // "bucket" waktu (kelipatan speedAlertCooldownMinutes) supaya alert
    // BOLEH terkirim ULANG selama kendaraan masih di atas batas -- alert
    // lain sengaja cuma terkirim 1x per kenaikan level (dedup permanen),
    // tapi itu tidak cocok utk kecepatan (nilainya berubah tiap detik).
    if (ns.speedAlertEnabled !== false) {
      const cooldownMs = Math.max(1, Number(ns.speedAlertCooldownMinutes) || 15) * 60000;
      const speedBucket = Math.floor(Date.now() / cooldownMs);
      state.cars.forEach(c => {
        if (!c.imeiGps) return;
        const speed = gpsSpeedMap[String(c.imeiGps)];
        if (speed == null) return;
        const batas = (c.batasKecepatanKmh != null && c.batasKecepatanKmh !== '') ? Number(c.batasKecepatanKmh) : (Number(ns.speedLimitKmh) || 120);
        if (speed > batas) {
          alerts.push({
            id: `speed-${c.id}-${speedBucket}`, ic: '🚨', level: 'danger',
            judul: 'Kecepatan berlebih',
            keterangan: `${carLabel(c.id)} — melaju ${speed} km/j (batas ${batas} km/j)`,
            targetDriverIds: null, // diatur lewat rolePrefs.sopir.speed (menu khusus Administrator), default MATI
            urgent: true, // bypass interval cek berkala -- dicek tiap kali cron jalan
          });
        }
      });
    }

    // v3.271.0 -- Notifikasi Mesin Dinyalakan: deteksi TRANSISI OFF->ON yang
    // presisi (persis saat kontak baru diputar), BUKAN lagi "info berkala
    // selama mesin menyala" tiap `engineOnCooldownMinutes` seperti versi
    // sebelumnya. Status acc SEMUA kendaraan sudah diambil SEKALI di atas
    // (gpsAccMap, dari data GPS.id yang sama dgn Reminder SIM Tracker --
    // tidak menambah panggilan API), dioper lewat closure `gpsAccMap`.
    // Dibandingkan dgn `engineAccPrevMap` (status siklus cron SEBELUMNYA,
    // dibaca dari notif-state.json, lihat deklarasinya di atas) -- tetap
    // pakai field acc GPS.id (BUKAN kecepatan/speed), jadi tetap terdeteksi
    // walau mobil diam di tempat, bukan cuma pas mobil mulai jalan.
    // targetDriverIds: null -- diatur lewat rolePrefs.sopir/.finance/.admin
    // .engineOn (menu khusus Administrator), default HANYA Admin/Super
    // Admin yg dapat. Catatan jujur: ini tetap lewat cron periodik (bukan
    // webhook/push real-time), jadi transisinya baru "ketahuan" pas siklus
    // cron BERIKUTNYA jalan (maks. beberapa menit setelah kontak diputar,
    // sesuai interval cron) -- tapi begitu ketahuan, alert cuma dikirim
    // SEKALI per transisi (bukan berulang selama mesin menyala), sampai
    // sempat balik OFF dulu baru boleh kirim lagi.
    if (ns.engineOnAlertEnabled !== false) {
      const cooldownMsEngine = Math.max(1, Number(ns.engineOnCooldownMinutes) || 30) * 60000;
      state.cars.forEach(c => {
        if (!c.imeiGps) return;
        const imei = String(c.imeiGps);
        const accOn = gpsAccMap[imei]; // true/false/null (null = data GPS.id tidak jelas)
        const accWasOn = engineAccPrevMap[imei] === true;
        // Simpan status TERBARU dulu (dipakai siklus cron berikutnya lewat
        // persistState() di bawah) -- SEBELUM keputusan kirim/tidak, supaya
        // tetap tersimpan walau alert-nya sendiri dilewati (mis. masih
        // dalam jeda anti-flapping). Kalau accOn null (data tidak jelas),
        // JANGAN timpa status lama -- biarkan seperti sebelumnya, supaya 1x
        // data GPS.id kosong/nyasar tidak bikin status "lupa" lalu salah
        // dianggap transisi baru begitu data jelas lagi.
        if (accOn === true || accOn === false) engineAccPrevMap[imei] = accOn;
        if (accOn !== true) return; // false atau null -- tidak ada yg perlu dikirim
        if (accWasOn) return; // sudah ON sejak siklus cron sebelumnya -- bukan transisi baru
        const lastAlertAt = Number(engineOnLastAlertAt[imei]) || 0;
        if (Date.now() - lastAlertAt < cooldownMsEngine) return; // jeda anti-flapping (kontak mati-nyala cepat berkali-kali)
        engineOnLastAlertAt[imei] = Date.now();
        // BARU -- lampirkan link peta lokasi live (OpenStreetMap, BUKAN
        // Google Maps) kalau posisi GPS.id kendaraan ini jelas (gpsLatLonMap,
        // dari data yang SAMA dgn deteksi acc di atas, TIDAK ada panggilan
        // API tambahan). null kalau posisi belum jelas -- baris link
        // otomatis dilewati saat pesan dirangkai (lihat buildAlertMessageText).
        const posisiEngineOn = gpsLatLonMap[imei] || null;
        alerts.push({
          id: `engineon-${c.id}-${Date.now()}`, ic: '🔑', level: 'info',
          judul: 'Mesin Kendaraan Dinyalakan',
          keterangan: `Mesin kendaraan ${carLabel(c.id)} telah dinyalakan.`,
          mapsLink: posisiEngineOn ? osmMapsLink(posisiEngineOn.lat, posisiEngineOn.lon) : null,
          mapsLinkLabel: '📍 Lihat lokasi live di peta (OpenStreetMap)',
          targetDriverIds: null, // diatur lewat rolePrefs.sopir/.finance/.admin.engineOn (menu khusus Administrator), default cuma Admin/Super Admin
          urgent: true, // bypass interval cek berkala -- dicek tiap kali cron jalan
        });
      });
    }

    // BARU -- Peringatan Rute Menyimpang. Hasil deteksi tren jarak (lihat
    // computeRouteDeviationFlags() di atas) sudah dihitung SEBELUM
    // computeAlerts() dipanggil (butuh async KV+GPS.id), dioper lewat
    // closure `routeDeviationFlags`. targetDriverIds: null -- diatur lewat
    // rolePrefs (menu khusus Administrator), default HANYA Admin/Super
    // Admin yg dapat (BUKAN sopir -- ini utk pemantauan admin, bukan
    // teguran ke sopir). ID pakai "bucket" waktu (kelipatan
    // routeDeviationCooldownMinutes) spy alert BOLEH terkirim ULANG selama
    // kondisinya masih berlangsung (pola sama dgn Alert Kecepatan) -- bukan
    // dedup permanen spt alert dokumen/servis.
    if (ns.routeDeviationEnabled !== false && routeDeviationFlags.length) {
      const cooldownMsRd = Math.max(1, Number(ns.routeDeviationCooldownMinutes) || 30) * 60000;
      const rdBucket = Math.floor(Date.now() / cooldownMsRd);
      routeDeviationFlags.forEach(f => {
        const jarakKmTxt = (Math.round(f.jarakMeter / 100) / 10).toFixed(1);
        // v3.254.0 -- BARU: label jaraknya sekarang jujur soal sumbernya --
        // "jalan" kalau berhasil dihalusin lewat ORS Matrix
        // (orsRoadDistanceMeters()), "garis lurus (estimasi)" kalau ORS
        // tidak bisa dipakai (fail-open, PERSIS label lama sebelum fitur
        // ini ada -- tidak ada perilaku yang berubah utk kasus fallback).
        const jarakLabelTxt = f.jarakSumber === 'jalan' ? 'jarak jalan' : 'garis lurus (estimasi)';
        alerts.push({
          id: `routedev-${f.tripId}-${rdBucket}`, ic: '🧭', level: 'warn',
          judul: 'Kemungkinan menyimpang dari rute',
          keterangan: `${carLabel(f.carId)} — posisi GPS terkini konsisten menjauh dari tujuan berikutnya (${f.namaTujuanBerikutnya}, ±${jarakKmTxt} km ${jarakLabelTxt}). Bersifat informatif, bukan indikasi pelanggaran -- kemungkinan penyebab: kemacetan, keperluan mendadak, atau rute alternatif.`,
          targetDriverIds: null, // diatur lewat rolePrefs.sopir/.admin.routeDeviation (menu khusus Administrator), default cuma Admin/Super Admin
          urgent: true, // bypass interval cek berkala -- dicek tiap kali cron jalan
        });
      });
    }

    const hariIniStr = today();
    const jamBatasTripLama = getNotifSettings().tripDurationWarnHours || 24;
    state.usage.forEach(u => {
      if (u.status !== 'digunakan' || !u.tglKeluar) return;
      const berangkat = new Date(u.tglKeluar + 'T' + (u.jamKeluar || '00:00') + ':00+07:00');
      if (isNaN(berangkat)) return;
      const jamBerlalu = (Date.now() - berangkat.getTime()) / 3600000;
      if (jamBerlalu < jamBatasTripLama) return;
      alerts.push({
        id: `trip-lama-${u.id}-${hariIniStr}`, ic: '⏳', level: 'warn',
        judul: 'Trip belum ditandai Tiba', keterangan: `${carLabel(u.carId)} — ${u.tujuan || '(tanpa tujuan)'}, sudah ${Math.floor(jamBerlalu)} jam sejak berangkat. Dapat diabaikan apabila perjalanan memang masih berlangsung.`,
        targetDriverIds: u.driverId ? [u.driverId] : null,
        hanyaJam06: true,
      });
    });

    const [thnIni, blnIni, tglIni] = hariIniStr.split('-').map(Number);
    const besokDate = new Date(Date.UTC(thnIni, blnIni - 1, tglIni + 1));
    const besokStr = `${besokDate.getUTCFullYear()}-${String(besokDate.getUTCMonth() + 1).padStart(2, '0')}-${String(besokDate.getUTCDate()).padStart(2, '0')}`;
    log(`📅 Cek Booking -- hari ini (WIB): ${hariIniStr}, besok: ${besokStr}. Total booking di data: ${(state.bookings || []).length}.`);
    (state.bookings || []).forEach(b => {
      if (b.status !== 'dipesan') return;
      if (b.tglMulai === besokStr) {
        alerts.push({ id: 'booking-h1-' + b.id, ic: '📅', level: 'warn', judul: 'Booking besok', keterangan: `${carLabel(b.carId)} — ${b.tujuan || '(tanpa tujuan)'}${b.jamMulai ? ' · ' + b.jamMulai : ''} · ${b.jenisPenggunaan === 'pribadi' ? 'Pribadi' : 'Pengiriman'} · Sopir: ${b.driverId ? driverLabel(b.driverId) : '(belum dipilih)'}`, targetDriverIds: Array.isArray(b.notifDriverIds) ? b.notifDriverIds : null });
      } else if (b.tglMulai === hariIniStr) {
        alerts.push({ id: 'booking-h0-' + b.id, ic: '📅', level: 'danger', judul: 'Booking hari ini', keterangan: `${carLabel(b.carId)} — ${b.tujuan || '(tanpa tujuan)'}${b.jamMulai ? ' · ' + b.jamMulai : ''} · ${b.jenisPenggunaan === 'pribadi' ? 'Pribadi' : 'Pengiriman'} · Sopir: ${b.driverId ? driverLabel(b.driverId) : '(belum dipilih)'}`, targetDriverIds: Array.isArray(b.notifDriverIds) ? b.notifDriverIds : null, urgent: true });
      }
    });

    // BARU -- Reminder Masa Aktif SIM GPS Tracker (field expired_gsm dari
    // GPS.id, BEDA dari "Dokumen Kadaluarsa" yang sudah ada -- itu dokumen
    // fisik kendaraan/sopir, ini pulsa/masa aktif kartu SIM DI DALAM alat
    // GPS-nya sendiri). Pola milestone SAMA PERSIS dgn dokumen (60/30/7
    // hari + lewat). Kalau expired_gsm habis, tracking GPS mobil ini
    // berhenti total tanpa peringatan lain apa pun -- makanya kategori ini
    // penting walau kelihatan mirip dokumen biasa.
    if (gpsVehicleListForAlerts) {
      state.cars.forEach(c => {
        if (!c.imeiGps) return;
        const v = gpsVehicleListForAlerts.find(x => String(x.imei ?? x.IMEI ?? '') === String(c.imeiGps));
        if (!v || !v.expired_gsm) return;
        const sisa = daysBetween(v.expired_gsm);
        if (isNaN(sisa)) return;
        const isMilestone = sisa < 0 || DOC_EXPIRY_MILESTONES_DAYS.some(m => sisa <= m);
        if (isMilestone) {
          alerts.push({
            id: 'simgps-' + c.id,
            ic: sisa < 0 ? '⛔' : '📶', level: docExpiryAlertLevel(sisa),
            judul: `Masa Aktif SIM GPS Tracker ${sisa < 0 ? 'sudah habis' : 'akan habis'}`,
            keterangan: `${carLabel(c.id)} — ${sisa < 0 ? Math.abs(sisa) + ' hari lalu' : sisa + ' hari lagi'}. Kalau habis, tracking GPS mobil ini berhenti total (lokasi, kecepatan, kalibrasi odometer) tanpa peringatan lain -- segera perpanjang pulsa/paket data SIM di alat GPS-nya.`,
            targetDriverIds: [],
          });
        }
      });
    }

    // BARU -- Alert Bawaan GPS.id (SOS/rem mendadak/power cut/dst -- deteksi
    // tingkat PERANGKAT, beda dari alert kecepatan yang FleetOps hitung
    // sendiri dari data lokasi). Administrator pilih sendiri kode alert mana
    // yang relevan lewat state.gpsAlertWatchlist (menu Notifikasi Telegram
    // per Peran, index.html) -- default KOSONG (tidak ada yang diteruskan)
    // sampai sengaja diisi, supaya fitur ini tidak diam-diam mulai kirim
    // notifikasi sebelum Administrator tahu & pilih kode yang diinginkan.
    // dipush lewat pushGpsAlertsIntoAlerts() di bawah computeAlerts() --
    // BUKAN sinkron di sini krn butuh fetch async ke GPS.id per kode alert.

    alerts.sort((a, b) => (a.level === 'danger' ? 0 : 1) - (b.level === 'danger' ? 0 : 1));
    return alerts;
  }

  function isWithinQuietHours(ns) {
    if (!ns.quietHoursEnabled) return false;
    const jakartaHM = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
    const [nowH, nowM] = jakartaHM.split(':').map(Number);
    const nowMin = nowH * 60 + nowM;
    const [startH, startM] = (ns.quietHoursStart || '22:00').split(':').map(Number);
    const [endH, endM] = (ns.quietHoursEnd || '06:00').split(':').map(Number);
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;
    if (startMin === endMin) return false;
    if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
    return nowMin >= startMin || nowMin < endMin;
  }

  // v3.147.0 -- Alert Kecepatan Berlebih: ambil kecepatan SEMUA kendaraan
  // dari GPS.id SEKALI di sini (bukan di dalam computeAlerts(), yang harus
  // tetap fungsi sinkron) -- hasilnya dibaca computeAlerts() lewat closure.
  // Gagal diam-diam (map kosong) supaya pengecekan notifikasi lain tetap
  // jalan normal walau GPS.id sedang bermasalah.
  let gpsSpeedMap = {};
  try {
    gpsSpeedMap = await getGpsIdSpeedMap(env);
  } catch (e) {
    log('⚠️ Gagal ambil data kecepatan GPS.id untuk Alert Kecepatan Berlebih:', e.message);
  }

  // BARU -- daftar kendaraan LENGKAP dari GPS.id (termasuk field
  // expired_gsm) utk Reminder Masa Aktif SIM GPS Tracker di bawah. Lewat
  // fetchGpsIdVehicleData() yang SAMA (cache/cooldown bersama dgn
  // getGpsIdSpeedMap() di atas) -- di sini HAMPIR SELALU cuma pakai cache
  // yang baru saja terisi, TIDAK menambah panggilan API baru ke GPS.id.
  let gpsVehicleListForAlerts = null;
  try {
    const vd = await fetchGpsIdVehicleData(env);
    gpsVehicleListForAlerts = vd.list || null;
  } catch (e) {
    log('⚠️ Gagal ambil daftar kendaraan GPS.id untuk Reminder SIM Tracker:', e.message);
  }

  // BARU -- Notifikasi Mesin Dinyalakan: status acc (kontak ON/OFF) SEMUA
  // kendaraan, dari `gpsVehicleListForAlerts` YANG SAMA (sudah diambil di
  // atas) -- TIDAK menambah panggilan API baru ke GPS.id. Field acc dibaca
  // dgn fallback yang SAMA dgn dashboard "Sedang Jalan" di index.html
  // (v.acc / v.acc_status / v.status_mesin), supaya konsisten dgn indikator
  // yang sudah ada. map { imei: true/false/null (null = data tidak jelas) }.
  let gpsAccMap = {};
  // BARU -- posisi terakhir (lat/lon) SEMUA kendaraan, dari
  // `gpsVehicleListForAlerts` YANG SAMA (TIDAK menambah panggilan API baru
  // ke GPS.id). Field lat/lon dibaca dgn fallback yang SAMA dgn kartu Lacak
  // Kendaraan di index.html (v.latitude/v.lat, v.longitude/v.lon). Dipakai
  // utk lampirkan link peta lokasi live ke notifikasi Telegram (mis. Mesin
  // Dinyalakan) -- link ke OpenStreetMap (BUKAN Google Maps), konsisten dgn
  // peta mini Leaflet + OpenStreetMap yang sudah dipakai di popup "🛰️
  // Lacak" app ini (lihat CHANGELOG v3.246-an). map { imei: {lat, lon} } --
  // entry TIDAK ada kalau datanya tidak jelas.
  let gpsLatLonMap = {};
  if (gpsVehicleListForAlerts) {
    gpsVehicleListForAlerts.forEach(v => {
      const imei = v.imei ?? v.IMEI ?? null;
      if (imei == null) return;
      const accRaw = v.acc ?? v.acc_status ?? v.status_mesin ?? null;
      if (accRaw == null) { gpsAccMap[String(imei)] = null; }
      else { gpsAccMap[String(imei)] = (accRaw === true || accRaw === 1 || accRaw === '1' || String(accRaw).toUpperCase() === 'ON'); }
      const latRaw = v.latitude ?? v.lat ?? null;
      const lonRaw = v.longitude ?? v.lon ?? null;
      if (latRaw != null && lonRaw != null && !isNaN(Number(latRaw)) && !isNaN(Number(lonRaw))) {
        gpsLatLonMap[String(imei)] = { lat: Number(latRaw), lon: Number(lonRaw) };
      }
    });
  }

  // Link peta OpenStreetMap (BUKAN Google Maps) dari koordinat lat/lon --
  // dipakai bareng-bareng oleh alert manapun yang mau lampirkan lokasi live
  // (lihat field `mapsLink` di alerts.push() & buildAlertMessageText()).
  function osmMapsLink(lat, lon) {
    if (lat == null || lon == null) return null;
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
  }

  // ---- Baca notif-state.json (dipindah ke sini -- dibutuhkan LEBIH AWAL
  // oleh Alert Bawaan GPS.id di bawah, sebelum posisi baca aslinya) ----
  let stateRead;
  try {
    stateRead = await ghReadJson(env, STATE_PATH);
  } catch (e) {
    log(`❌ Gagal baca "${STATE_PATH}":`, e.message);
    stateRead = { exists: false, sha: null, json: null };
  }
  const prevStateRaw = stateRead.exists ? (stateRead.json || {}) : {};
  const stateSha = stateRead.exists ? stateRead.sha : null;
  // BARU -- Alert Bawaan GPS.id: kursor waktu "sudah dicek sampai kapan",
  // supaya tiap siklus cron cuma nanya rentang waktu yang BELUM pernah
  // dicek (bukan query ulang dari awal terus-terusan). Default 30 menit ke
  // belakang kalau belum pernah ada (kunjungan pertama fitur ini aktif).
  let gpsAlertLastCheckedAt = prevStateRaw.gpsAlertLastCheckedAt || (Date.now() - 30 * 60000);

  // v3.271.0 -- BARU: Notifikasi Mesin Dinyalakan diubah dari pola "info
  // berkala selama mesin menyala" jadi deteksi TRANSISI OFF->ON yang
  // presisi (persis saat kontak baru diputar, BUKAN saat mobil mulai
  // jalan -- tetap dibaca dari field acc GPS.id, independen dari
  // kecepatan/gerak). Worker ini stateless antar-invocation cron, jadi
  // status acc siklus SEBELUMNYA wajib disimpan lintas siklus -- dibaca
  // di sini dari notif-state.json (prevStateRaw, SUDAH terbaca di atas),
  // ditulis balik lewat payload persistState() di bawah. Kunci pakai imei
  // (bukan c.id) supaya tetap valid walau nomor urut c.id berubah.
  // - engineAccPrevMap: imei -> true/false (status acc TERAKHIR yang
  //   benar2 jelas terbaca; entry TIDAK ada = belum pernah kebaca).
  // - engineOnLastAlertAt: imei -> timestamp alert transisi TERAKHIR yang
  //   terkirim -- jaga-jaga anti-flapping (mis. kontak dimatikan-nyalakan
  //   cepat berkali-kali), pakai setting jeda (engineOnCooldownMinutes)
  //   yang sama dgn sebelumnya supaya menu Pengaturan tidak perlu berubah.
  let engineAccPrevMap = { ...(prevStateRaw.engineAccPrevMap || {}) };
  let engineOnLastAlertAt = { ...(prevStateRaw.engineOnLastAlertAt || {}) };

  // BARU -- Peringatan Rute Menyimpang: butuh baca/tulis KV (async), makanya
  // dihitung SEBELUM computeAlerts() dipanggil (sama pola dgn gpsSpeedMap di
  // atas) -- hasilnya dioper lewat closure `routeDeviationFlags`. Dipakai
  // gpsVehicleListForAlerts YANG SAMA (sudah diambil di atas utk Reminder
  // SIM Tracker) -- TIDAK menambah panggilan API baru ke GPS.id.
  let routeDeviationFlags = [];
  try {
    const nsForRouteDev = getNotifSettings();
    if (nsForRouteDev.routeDeviationEnabled !== false && gpsVehicleListForAlerts) {
      routeDeviationFlags = await computeRouteDeviationFlags(env, state, gpsVehicleListForAlerts, nsForRouteDev);
    }
  } catch (e) {
    log('⚠️ Gagal cek Peringatan Rute Menyimpang:', e.message);
  }

  // v3.229.0 -- BARU: "Auto-deteksi Sampai" (idea #1) -- lihat
  // computeGeofenceArrivalCandidates() di atas. Beda dari Rute Menyimpang:
  // ini kirim pesan LANGSUNG ke SOPIR (bukan lewat sistem alert admin),
  // jadi dikirim manual di sini via fetch langsung -- bukan lewat
  // alerts.push()/computeAlerts() yg memang didesain khusus utk notifikasi
  // ke peran admin/finance/superadmin.
  try {
    const nsForGeoArrival = getNotifSettings();
    if (nsForGeoArrival.geofenceArrivalEnabled !== false && gpsVehicleListForAlerts) {
      const geofenceCandidates = await computeGeofenceArrivalCandidates(env, state, gpsVehicleListForAlerts, nsForGeoArrival);
      const BOT_TOKEN_GA = env.TELEGRAM_BOT_TOKEN;
      for (const c of geofenceCandidates) {
        try {
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN_GA}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: c.chatId,
              parse_mode: 'HTML',
              text: `📍 Posisi GPS terkini kelihatan sudah dekat & berhenti di sekitar <b>${c.namaTujuanBerikutnya}</b> (±${c.jarakMeter} meter).\n\nSudah sampai di sana?`,
              reply_markup: { inline_keyboard: [[
                { text: '✅ Ya, tandai sampai', callback_data: `sampai:${c.nomorTujuan}` },
                { text: '❌ Belum', callback_data: 'geoarrival_no' },
              ]] },
            }),
          });
        } catch (e) { log('⚠️ Gagal kirim konfirmasi Auto-deteksi Sampai ke', c.chatId, ':', e.message); }
      }
    }
  } catch (e) {
    log('⚠️ Gagal cek Auto-deteksi Sampai:', e.message);
  }

  const alerts = computeAlerts();

  // BARU -- Alert Bawaan GPS.id (SOS/rem mendadak/dst), lihat catatan di
  // pushGpsAlertsIntoAlerts(). Gagal diam-diam (log saja) -- kalau GPS.id
  // sedang bermasalah, pengecekan notifikasi lain tetap jalan normal.
  let newGpsAlertLastCheckedAt = gpsAlertLastCheckedAt;
  try {
    const hasil = await pushGpsAlertsIntoAlerts(env, state, alerts, gpsAlertLastCheckedAt, log);
    newGpsAlertLastCheckedAt = hasil.checkedUntil;
  } catch (e) {
    log('⚠️ Gagal cek Alert Bawaan GPS.id:', e.message);
  }

  // ============================================================================
  // BARU -- MODE TES PER KATEGORI (tombol "🔬 Tes" di panel Notifikasi
  // Telegram per Peran, index.html). Beda dari MODE TES generik di atas:
  // ini kirim SATU pesan yang ISINYA benar-benar dari data asli (kalau ada)
  // utk kategori yang dipilih, supaya Administrator bisa lihat format/isi
  // pesan sungguhan tanpa perlu menunggu kondisi aslinya terjadi. Dikirim
  // HANYA ke opts.testChatId (tidak pernah ke daftar penerima asli) &
  // SELALU diberi label "🔬 [TES]" di baris pertama supaya jelas ini
  // bukan notifikasi sungguhan.
  //
  // WAJIB DEV: kalau menambah kategori BARU ke computeAlerts() (alert
  // berkala baru), tambahkan juga prefix id-nya ke TEST_CATEGORY_ALERT_
  // PREFIXES di bawah supaya tombol tes-nya otomatis dapat data asli --
  // kalau tidak ditambahkan, tombol tes kategori itu jatuh ke pesan
  // penjelasan generik (masih jalan, cuma tidak pakai data asli).
  // ============================================================================
  if (opts.testChatId && opts.testCategory) {
    const TEST_CATEGORY_ALERT_PREFIXES = {
      doc: ['doc-'], service: ['svc-oli-', 'svc-berkala-'], etoll: ['etoll-'], bbm: ['bbm-'],
      booking: ['booking-h1-', 'booking-h0-'], tripLama: ['trip-lama-'], budget: ['budget-'],
      kalibrasi: ['kalibrasi-'], speed: ['speed-'], engineOn: ['engineon-'],
    };
    const prefixes = TEST_CATEGORY_ALERT_PREFIXES[opts.testCategory];
    let testText;
    if (prefixes) {
      const contoh = alerts.find(a => prefixes.some(p => a.id.startsWith(p)));
      if (contoh) {
        testText = [
          '🔬 <b>[TES] Contoh notifikasi kategori ini (data asli)</b>', '',
          `${contoh.ic} <b>${escapeHtmlTg(contoh.judul)}</b>`,
          escapeHtmlTg(contoh.keterangan), '',
          '<i>Ini contoh pesan sungguhan yang SEDANG memenuhi syarat terkirim saat ini -- kalau nanti kondisinya berubah (mis. sudah diperpanjang/dilunasi), isi & jumlahnya juga akan berubah.</i>',
        ].join('\n');
      } else {
        testText = [
          '🔬 <b>[TES] Kategori ini sedang tidak ada data yang memicu</b>', '',
          'Ini pertanda BAIK, bukan error -- tidak ada dokumen/servis/dsb yang saat ini memenuhi syarat kategori ini. Pesan asli baru akan terkirim otomatis kalau nanti ada yang memenuhi syarat.',
        ].join('\n');
      }
    } else if (opts.testCategory === 'resi') {
      const tripTerbaru = [...state.usage].reverse().find(u => u.status === 'selesai' && u.jenisPenggunaan !== 'pribadi');
      testText = tripTerbaru
        ? ['🔬 <b>[TES] Contoh Resi Perjalanan (data asli)</b>', '', `Trip: ${escapeHtmlTg(carLabel(tripTerbaru.carId))} — ${escapeHtmlTg(tripTerbaru.tujuan || '-')}`, `Sopir: ${escapeHtmlTg(driverLabel(tripTerbaru.driverId, tripTerbaru.driver))}`, '', '<i>Resi sungguhan berbentuk gambar Tanda Terima, dikirim otomatis begitu trip Operasional ditutup.</i>'].join('\n')
        : ['🔬 <b>[TES] Resi Perjalanan</b>', '', 'Belum ada trip Operasional yang sudah selesai di data -- resi dikirim otomatis (berbentuk gambar) begitu sopir menutup trip Operasional lewat "akhiri trip".'].join('\n');
    } else if (opts.testCategory === 'bookingApproval') {
      const pendingCount = (state.bookings || []).filter(b => b.status === 'menunggu').length;
      testText = ['🔬 <b>[TES] Approval Booking</b>', '', `Saat ini ada ${pendingCount} booking yang menunggu approval.`, '', '<i>Pesan asli berisi detail 1 booking + tombol Setuju/Tolak, dikirim otomatis begitu ada booking baru yang butuh persetujuan.</i>'].join('\n');
    } else if (opts.testCategory === 'laporanBulanan') {
      testText = ['🔬 <b>[TES] Laporan Bulanan</b>', '', 'Laporan berisi rekap biaya & aktivitas bulan berjalan, dikirim otomatis ke Admin & Admin Finance di awal bulan berikutnya.', '', `Total mobil terdaftar saat ini: ${state.cars.length}.`].join('\n');
    } else {
      // Perintah on-demand (dipicu pengguna ketik ke bot), bukan notifikasi
      // push -- tidak ada "data yang menunggu dikirim" utk disimulasikan,
      // jadi kasih penjelasan jujur + saran cara tes yang paling akurat.
      testText = [
        '🔬 <b>[TES] Perintah ini bersifat on-demand</b>', '',
        'Perintah ini dijalankan begitu PENGGUNA mengetiknya ke bot -- bukan notifikasi yang dikirim otomatis, jadi tidak ada contoh "isi pesan" yang bisa disimulasikan dari sini.', '',
        '<i>Cara tes paling akurat: ketik langsung salah satu alias/kata kunci kategori ini (lihat daftar di panel) ke bot Telegram Anda.</i>',
      ].join('\n');
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: opts.testChatId, text: testText, parse_mode: 'HTML' })
      });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok || !resBody.ok) {
        log(`❌ Gagal kirim tes kategori "${opts.testCategory}" ke ${opts.testChatId}:`, JSON.stringify(resBody));
        return { ok: false, reason: 'test-category-send-failed', log: logLines };
      }
      log(`✅ Tes kategori "${opts.testCategory}" berhasil terkirim ke ${opts.testChatId}.`);
      return { ok: true, mode: 'test-category', log: logLines };
    } catch (e) {
      log(`❌ Gagal kirim tes kategori "${opts.testCategory}" ke ${opts.testChatId}:`, e.message);
      return { ok: false, reason: 'test-category-send-error', log: logLines };
    }
  }

  // BARU -- menu khusus Administrator "Notifikasi Telegram per Peran" (PIN
  // 009900 di web). Dihitung sekali di sini (sebelum dipakai blok Finance
  // & Administrator di bawah, serta loop pengiriman utama Admin & Sopir).
  const rolePrefs = getNotifRolePrefsTg(state);
  const ns = getNotifSettings();

  // ---- notif-state.json sudah dibaca lebih awal di atas (prevStateRaw,
  // stateSha, gpsAlertLastCheckedAt) -- lanjutan turunannya di sini ----
  // v3.140.0 -- Laporan Bulanan Otomatis: kunci dedup TERPISAH dari
  // dedup/history alert biasa -- nyimpen bulan (format "YYYY-MM", bulan yg
  // DILAPORKAN, bukan bulan saat dikirim) yang laporannya SUDAH terkirim,
  // supaya cron yang jalan tiap beberapa menit tidak kirim ulang laporan
  // yang sama berkali-kali sepanjang jendela toleransi (tanggal 1-7).
  let monthlyReportSentFor = prevStateRaw.monthlyReportSentFor || null;
  // BARU -- Log Notifikasi per-penerima (tombol "Cek log notifikasi" di
  // menu Notifikasi Telegram per Peran, index.html). 50 entri TERBARU
  // (bukan riwayat lengkap) -- cukup utk "kok sopir ini belum dapat
  // notifikasi X" tanpa bikin notif-state.json membengkak. BEDA dari
  // `history` yang sudah ada (itu ringkasan per-SIKLUS cron, ini per-
  // PENERIMA per-kategori). WAJIB DEV: kalau menambah titik kirim
  // sendMessage baru di runNotifyCheck, panggil pushNotifLog() di situ
  // juga supaya tidak "yatim" -- tidak tercatat di log ini sama sekali.
  let notifLog = Array.isArray(prevStateRaw.notifLog) ? prevStateRaw.notifLog : [];
  function pushNotifLog(entry) {
    notifLog = [{ waktu: Date.now(), ...entry }, ...notifLog].slice(0, 50);
  }
  // BARU -- beberapa titik kirim cuma punya `label` gabungan (mis. "Admin:
  // Ari", "Finance: Dewi", "Administrator: 12345", "Admin 1 (Secret)") --
  // pecah jadi {nama, peran} utk kolom terpisah di Log Notifikasi.
  function parseLabelPeran(label) {
    const s = String(label || '');
    if (s.startsWith('Admin: ')) return { nama: s.slice(7), peran: 'admin' };
    if (s.startsWith('Finance: ')) return { nama: s.slice(9), peran: 'finance' };
    if (s.startsWith('Administrator: ')) return { nama: s.slice(15), peran: 'superadmin' };
    if (s.startsWith('Admin')) return { nama: s, peran: 'admin' };
    return { nama: s || '-', peran: 'sopir' };
  }

  const isOldFlatFormat = prevStateRaw && typeof prevStateRaw === 'object' && !('dedup' in prevStateRaw) && !('history' in prevStateRaw);
  const prevDedup = isOldFlatFormat ? prevStateRaw : (prevStateRaw.dedup || {});
  const prevHistory = Array.isArray(prevStateRaw.history) ? prevStateRaw.history : [];
  let newReceiptsSent = Array.isArray(prevStateRaw.receiptsSent) ? prevStateRaw.receiptsSent : [];
  // v3.137.0 -- dedup KHUSUS notifikasi admin saat trip selesai (kunci
  // "usageId:adminId", beda dari newReceiptsSent yang cuma per-usageId untuk
  // sopir) -- perlu per-pasangan karena 1 trip bisa dikirim ke BEBERAPA admin.
  let newAdminReceiptsSent = Array.isArray(prevStateRaw.adminReceiptsSent) ? prevStateRaw.adminReceiptsSent : [];
  // v3.184.0 -- dedup KHUSUS resi Administrator (opt-in, kategori BARU utk
  // kolom Administrator di menu "Notifikasi Telegram per Peran"), kunci
  // "usageId:superAdminId" -- pola SAMA dgn newAdminReceiptsSent di atas,
  // sengaja array terpisah supaya tidak bentrok dgn dedup Admin biasa.
  let newSuperAdminReceiptsSent = Array.isArray(prevStateRaw.superAdminReceiptsSent) ? prevStateRaw.superAdminReceiptsSent : [];
  // BARU: dedup Konfirmasi Booking H-1 Jam (SEKALI tanya per booking) --
  // dideklarasikan di sini (SEBELUM persistState() didefinisikan di bawah)
  // supaya aman kalau persistState() sempat dipanggil lebih dulu lewat jalur
  // "toSend kosong -> return awal" (lihat closure payload di persistState()).
  const bookingH1JamAskedSet = new Set(Array.isArray(prevStateRaw.bookingH1JamAsked) ? prevStateRaw.bookingH1JamAsked : []);
  // BARU: dedup notifikasi Finance (Ganti Oli & Dokumen Mobil) -- objek
  // {alertId: level terakhir yg sudah dikirim ke Finance}, sama alasan
  // dideklarasikan di sini (dipakai closure payload persistState() di bawah).
  let financeAssetNotifSentNew = { ...(prevStateRaw.financeAssetNotifSent || {}) };
  // BARU: dedup notifikasi Administrator (Ganti Oli & Servis Berkala) -- pola
  // SAMA PERSIS dengan financeAssetNotifSentNew di atas, cuma kunci/state
  // terpisah supaya "sudah dikirim ke Finance" tidak otomatis berarti "sudah
  // dikirim ke Administrator" juga (levelnya bisa naik & butuh dikirim ulang
  // ke satu pihak tapi belum ke pihak lain kalau baru saja ditambahkan).
  let superAdminAssetNotifSentNew = { ...(prevStateRaw.superAdminAssetNotifSent || {}) };
  let newLastUpdateId = Number(prevStateRaw.lastUpdateId) || 0;
  const CONVO_EXPIRY_MS = 60 * 60 * 1000;
  let newPendingConversations = { ...(prevStateRaw.pendingConversations || {}) };
  Object.keys(newPendingConversations).forEach(chatId => {
    if (Date.now() - (newPendingConversations[chatId].startedAt || 0) > CONVO_EXPIRY_MS) {
      delete newPendingConversations[chatId];
    }
  });

  const isManualDispatch = !!opts.isManualDispatch;
  const lastAlertCheckAt = Number(prevStateRaw.lastAlertCheckAt) || 0;
  // v3.262.0 -- BARU: mode "Jam Tetap" (default, lihat NOTIF_SETTINGS_DEFAULT)
  // -- notifikasi BERKALA (non-urgent) sekarang SELALU dikirim jam
  // reminderFixedHourWib:00 WIB tiap hari, bukan lagi tiap checkIntervalMinutes
  // menit sepanjang hari. "Due" = sedang berada di JAM yang ditentukan DAN
  // belum pernah due hari ini (dicek dari tanggal WIB lastAlertCheckAt vs
  // tanggal WIB sekarang) -- supaya dari ~12x tick cron dalam jam itu (tiap
  // 5 menit), cuma tick PERTAMA yang benar2 dianggap "due", bukan berulang
  // tiap 5 menit selama jam itu berlangsung. Notifikasi urgent:true SAMA
  // SEKALI TIDAK terpengaruh field ini (lihat toSendCandidates di bawah,
  // `!dueForAlertCheck && !a.urgent` -- urgent selalu lolos apa pun nilai
  // dueForAlertCheck). Mode 'interval' (lama) tetap tersedia sbg fallback
  // kalau reminderMode diubah manual balik ke situ.
  let dueForAlertCheck;
  if (isManualDispatch) {
    dueForAlertCheck = true;
  } else if ((ns.reminderMode || 'fixed') === 'interval') {
    const checkIntervalMs = Math.max(5, Number(ns.checkIntervalMinutes) || 60) * 60000;
    dueForAlertCheck = (Date.now() - lastAlertCheckAt) >= checkIntervalMs;
  } else {
    const jamTetap = Math.min(23, Math.max(0, Number(ns.reminderFixedHourWib) ?? 8));
    const nowWibHM = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
    const sedangJamTetap = Number(nowWibHM.split(':')[0]) === jamTetap;
    const tglTerakhirWib = lastAlertCheckAt ? new Date(lastAlertCheckAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }) : null;
    const tglSekarangWib = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
    const sudahDueHariIni = tglTerakhirWib === tglSekarangWib;
    dueForAlertCheck = sedangJamTetap && !sudahDueHariIni;
  }

  const LEVEL_RANK = { warn: 1, danger: 2 };
  const toSendCandidates = alerts.filter(a => {
    if (!dueForAlertCheck && !a.urgent) return false;
    const prevLevel = prevDedup[a.id];
    if (!prevLevel) return true;
    return LEVEL_RANK[a.level] > LEVEL_RANK[prevLevel];
  });

  const inQuietHours = isWithinQuietHours(ns);
  const suppressedByQuietHours = inQuietHours ? toSendCandidates.filter(a => a.level !== 'danger') : [];
  const jakartaHM = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
  const sedangJam06 = jakartaHM >= '06:00' && jakartaHM < '07:00';
  const suppressedByJam06 = !sedangJam06 ? toSendCandidates.filter(a => a.hanyaJam06) : [];
  const suppressedIds = new Set([...suppressedByQuietHours, ...suppressedByJam06].map(a => a.id));
  const toSend = toSendCandidates.filter(a => !suppressedIds.has(a.id));

  if (suppressedByQuietHours.length > 0) {
    log(`🌙 Jam sunyi aktif (${ns.quietHoursStart}–${ns.quietHoursEnd} WIB) -- ${suppressedByQuietHours.length} notifikasi level "warn" ditunda.`);
  }
  if (suppressedByJam06.length > 0) {
    log(`⏳ ${suppressedByJam06.length} pengingat "Trip Kelamaan" ditunda -- cuma dikirim jam 06:00-06:59 WIB, sekarang ${jakartaHM} WIB.`);
  }

  const newDedup = {};
  alerts.forEach(a => {
    const checked = dueForAlertCheck || a.urgent;
    if (!checked || suppressedIds.has(a.id)) {
      if (prevDedup[a.id]) newDedup[a.id] = prevDedup[a.id];
      return;
    }
    newDedup[a.id] = a.level;
  });

  async function persistState(historyEntry) {
    const newHistory = historyEntry ? [historyEntry, ...prevHistory].slice(0, 100) : prevHistory;
    const payload = {
      dedup: newDedup, history: newHistory, receiptsSent: newReceiptsSent, adminReceiptsSent: newAdminReceiptsSent, superAdminReceiptsSent: newSuperAdminReceiptsSent,
      lastAlertCheckAt: dueForAlertCheck ? Date.now() : lastAlertCheckAt,
      lastUpdateId: newLastUpdateId,
      pendingConversations: newPendingConversations,
      monthlyReportSentFor,
      // BARU: dedup Konfirmasi Booking H-1 Jam -- SEKALI tanya per booking
      // (lihat blok "Konfirmasi Booking H-1 Jam" di bawah).
      bookingH1JamAsked: Array.from(bookingH1JamAskedSet).slice(-1000),
      // BARU: dedup notifikasi Finance (Ganti Oli & Dokumen Mobil jatuh
      // tempo) -- kunci per id alert ('svc-'/'doc-'), value level terakhir
      // yg sudah dikirim ke Finance (lihat blok "Notifikasi Finance" di bawah).
      financeAssetNotifSent: financeAssetNotifSentNew,
      // BARU: dedup notifikasi Administrator (Ganti Oli & Servis Berkala) --
      // lihat blok "Notifikasi Administrator" di bawah.
      superAdminAssetNotifSent: superAdminAssetNotifSentNew,
      // BARU: kursor waktu "sudah dicek sampai kapan" utk Alert Bawaan
      // GPS.id (lihat pushGpsAlertsIntoAlerts()).
      gpsAlertLastCheckedAt: newGpsAlertLastCheckedAt,
      // BARU: Log Notifikasi 50 entri terbaru (lihat pushNotifLog()).
      notifLog,
      // v3.271.0 -- BARU: status acc (kontak) TERAKHIR & waktu alert transisi
      // TERAKHIR per kendaraan, utk deteksi transisi OFF->ON Notifikasi Mesin
      // Dinyalakan yang presisi (lihat blok terkait di computeAlerts()).
      engineAccPrevMap,
      engineOnLastAlertAt,
    };
    // v3.??? -- BARU: retry SEKALI kalau simpan bentrok (HTTP 409/422 --
    // SHA sudah berubah krn ada penulis lain nulis STATE_PATH di antara baca
    // & tulis kita, mis. webhook chat & cron notifikasi jalan hampir
    // bersamaan). SEBELUMNYA cuma log peringatan & berhenti -- akibatnya
    // status "sudah dikirim" (dedup/superAdminAssetNotifSent/
    // financeAssetNotifSent/dst) di siklus itu GAGAL tersimpan, jadi
    // notifikasi yang seharusnya cuma 1x per interval (mis. Kalibrasi
    // Odometer GPS.id, harusnya sekali per 30 hari) malah bisa terkirim
    // ULANG di siklus berikutnya walau belum jatuh tempo -- pola retry SAMA
    // PERSIS dgn pushMainDataUpdate() (baca ulang SHA terbaru, coba simpan
    // lagi SEKALI, bukan bikin loop tanpa batas).
    let putRes = await ghWriteJson(env, STATE_PATH, payload, stateSha, `chore: update notif-state — ${new Date().toISOString()}`);
    if (!putRes.ok && (putRes.status === 409 || putRes.status === 422)) {
      try {
        const ulangBaca = await ghReadJson(env, STATE_PATH);
        const shaTerbaru = ulangBaca.exists ? ulangBaca.sha : null;
        putRes = await ghWriteJson(env, STATE_PATH, payload, shaTerbaru, `chore: update notif-state (retry) — ${new Date().toISOString()}`);
      } catch (e) { log(`⚠️ Retry simpan "${STATE_PATH}" juga gagal: ${e.message}`); }
    }
    if (!putRes.ok) log(`⚠️ Gagal simpan "${STATE_PATH}" (HTTP ${putRes.status}).`);
  }

  async function sendTg(chatId, text, keyboard) {
    try {
      const body = { chat_id: chatId, text, parse_mode: 'HTML' };
      if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const resBody = await res.json().catch(() => ({}));
      return res.ok && resBody.ok; // BARU -- dipakai pemanggil utk catat status di Log Notifikasi
    } catch (e) { log(`❌ Gagal kirim pesan ke ${chatId}:`, e.message); return false; }
  }
  // v3.??? -- ATURAN ANTI-SPAM (dedup Chat ID), versi cadangan/berkala --
  // PORTING PERSIS dari sendTgUnique() di processTelegramUpdate(), lihat
  // komentar lengkap di sana & di menu "Notifikasi Telegram" (index.html).
  // recipients: array of { chatId, text, keyboard? }
  async function sendTgUnique(recipients) {
    const sudahDikirim = new Set();
    for (const r of recipients) {
      const cid = (r && r.chatId != null) ? r.chatId.toString().trim() : '';
      if (!cid || sudahDikirim.has(cid)) continue;
      sudahDikirim.add(cid);
      await sendTg(cid, r.text, r.keyboard);
    }
  }
  // v3.145.0 -- tombol Ya/Tidak, dipakai konfirmasi odometer GPS.id di
  // checkIncomingReplies() (mirror dari KB_YA_TIDAK di processTelegramUpdate).
  const KB_YA_TIDAK = [[{ text: '✅ Ya, benar', callback_data: 'ya' }, { text: '✏️ Isi manual', callback_data: 'tidak' }]];
  // v3.140.0 -- Kirim 1 file (CSV, dibuka Excel/Sheets tanpa masalah) sbg
  // dokumen Telegram. SENGAJA CSV (bukan .xlsx biner) -- Worker ini murni
  // JS tanpa langkah build/bundling (di-paste apa adanya ke dasbor
  // Cloudflare), jadi tidak ada library xlsx yang bisa dipakai di sini;
  // CSV cukup & tetap langsung kebuka rapi sebagai tabel di Excel.
  async function sendTgDocument(chatId, filename, csvText, caption) {
    try {
      const csvWithBom = '\uFEFF' + csvText; // BOM supaya Excel baca UTF-8 (é, —, dst) dgn benar, bukan karakter aneh
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', caption || '');
      form.append('parse_mode', 'HTML');
      form.append('document', new Blob([csvWithBom], { type: 'text/csv' }), filename);
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok || !resBody.ok) { log(`❌ Gagal kirim file ke ${chatId}:`, JSON.stringify(resBody)); return false; }
      return true;
    } catch (e) { log(`❌ Gagal kirim file ke ${chatId}:`, e.message); return false; }
  }
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ---------------- PDF Laporan Bulanan (BARU) ----------------
     Meniru PERSIS tampilan tombol "📊 Export PDF" di index.html
     (exportMonthlyReportPdf, berbasis library jsPDF) -- TAPI ditulis manual
     tanpa library luar, karena Worker ini tidak punya `window`/DOM tempat
     jsPDF biasa jalan (jsPDF di index.html dimuat lewat <script> dari CDN,
     hanya jalan kalau ada admin yg membuka app & klik tombolnya -- cron
     otomatis di sini tidak punya "tombol" untuk diklik).
     Cukup tulis struktur file PDF mentah (objek PDF standar) utk teks +
     garis lurus + banyak halaman -- itu semua yang dipakai laporan ini.
     Font pakai Helvetica/Helvetica-Bold BAWAAN PDF (14 font standar semua
     pembaca PDF wajib dukung), jadi tidak perlu file font terpisah. */
  const PDF_MM = 2.834645669; // 1 mm dalam pt (satuan asli PDF) -- biar koordinat SAMA PERSIS dgn versi jsPDF (unit:'mm')
  const PDF_PAGE_W = 595.28, PDF_PAGE_H = 841.89; // A4 dalam pt, sama seperti jsPDF format:'a4'

  // PDF standar cuma wajib dukung karakter Latin-1 dasar (WinAnsiEncoding)
  // tanpa font tambahan -- karakter di luar itu (mis. emoji) diganti '?'
  // supaya tidak merusak isi file. Tanda pisah "—"/"–" & kutip pintar
  // diganti versi ASCII biasa dulu supaya tetap kebaca normal.
  function pdfSanitizeText(s) {
    return String(s == null ? '' : s)
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\u00A0/g, ' ')
      .replace(/[^\x20-\x7E]/g, '?');
  }
  function pdfEscapeText(s) {
    return pdfSanitizeText(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  // pages: array of { texts:[{x,y (mm, dari kiri-atas, SAMA seperti jsPDF), size, bold, color:[r,g,b] 0-255, text}],
  //                    lines:[{x1,y1,x2,y2 (mm), color:[r,g,b], width}] }
  // Return: Uint8Array (bytes file PDF siap kirim).
  function buildSimplePdfBytes(pages) {
    const objs = []; // objs[n] = isi objek PDF ke-n (1-based)
    const pageCount = pages.length;
    const catalogNum = 1, pagesNum = 2, fontRegNum = 3, fontBoldNum = 4;
    const pageNums = pages.map((_, i) => 5 + i);
    const contentNums = pages.map((_, i) => 5 + pageCount + i);

    objs[catalogNum] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
    objs[pagesNum] = `<< /Type /Pages /Kids [${pageNums.map(n => n + ' 0 R').join(' ')}] /Count ${pageCount} >>`;
    objs[fontRegNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
    objs[fontBoldNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;

    pages.forEach((page, i) => {
      let stream = '';
      (page.lines || []).forEach(ln => {
        const [r, g, b] = ln.color.map(c => (c / 255).toFixed(3));
        const y1 = (PDF_PAGE_H - ln.y1 * PDF_MM).toFixed(2), y2 = (PDF_PAGE_H - ln.y2 * PDF_MM).toFixed(2);
        const x1 = (ln.x1 * PDF_MM).toFixed(2), x2 = (ln.x2 * PDF_MM).toFixed(2);
        stream += `${r} ${g} ${b} RG ${(ln.width || 0.5).toFixed(2)} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
      });
      (page.texts || []).forEach(t => {
        const [r, g, b] = t.color.map(c => (c / 255).toFixed(3));
        const x = (t.x * PDF_MM).toFixed(2), y = (PDF_PAGE_H - t.y * PDF_MM).toFixed(2);
        const font = t.bold ? 'F2' : 'F1';
        stream += `BT /${font} ${t.size} Tf ${r} ${g} ${b} rg ${x} ${y} Td (${pdfEscapeText(t.text)}) Tj ET\n`;
      });
      objs[pageNums[i]] = `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${PDF_PAGE_W.toFixed(2)} ${PDF_PAGE_H.toFixed(2)}] /Resources << /Font << /F1 ${fontRegNum} 0 R /F2 ${fontBoldNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`;
      objs[contentNums[i]] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
    });

    const totalObjs = 4 + pageCount * 2;
    let out = '%PDF-1.4\n';
    const offsets = [0];
    for (let n = 1; n <= totalObjs; n++) {
      offsets[n] = out.length;
      out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
    }
    const xrefStart = out.length;
    out += `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= totalObjs; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${totalObjs + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

    // Konversi string biner (1 karakter = 1 byte, aman krn semua teks sudah
    // disaring ke ASCII lewat pdfSanitizeText) jadi bytes sungguhan.
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF;
    return bytes;
  }

  // PORTING PERSIS dari computeMonthlyReport() di index.html (termasuk
  // rumus & pengecualian yang sama -- Isi BBM/E-Toll tidak dobel hitung,
  // trip Pribadi dikecualikan total, dst) -- supaya angka di PDF Telegram
  // ini SELALU identik dengan yang dilihat admin di menu Laporan Bulanan
  // aplikasi, bukan hitung ulang dgn rumus terpisah yang bisa melenceng.
  function computeMonthlyReportFull(yearMonth) {
    const usageBulanIni = state.usage.filter(u => (u.tglKeluar || '').startsWith(yearMonth));
    const servicesBulanIni = state.services.filter(s => (s.tanggal || '').startsWith(yearMonth));
    const perMobil = state.cars.map(car => {
      const trips = usageBulanIni.filter(u => u.carId === car.id);
      const jarak = trips.reduce((sum, u) => (u.odoKeluar != null && u.odoKembali != null && u.odoKembali >= u.odoKeluar) ? sum + (u.odoKembali - u.odoKeluar) : sum, 0);
      const literBeli = trips.reduce((sum, u) => sum + (Number(u.literBensin) || 0), 0);
      const biayaBbm = trips.reduce((sum, u) => sum + (Number(u.biayaBensin) || 0), 0);
      const biayaTol = trips.reduce((sum, u) => { const info = getBiayaTolTerpakai(u); return sum + (info ? info.biayaTol : 0); }, 0);
      const biayaOperasional = trips.reduce((sum, u) => {
        if (u.jenisPenggunaan === 'pribadi') return sum;
        return sum + usageBiayaOpItems(u).filter(it => it.kategori !== 'Isi BBM' && it.kategori !== 'Isi E-Toll').reduce((s, it) => s + (Number(it.nominal) || 0), 0);
      }, 0);
      const biayaServis = servicesBulanIni.filter(s => s.carId === car.id).reduce((sum, s) => sum + serviceItems(s).reduce((s2, it) => s2 + (Number(it.biaya) || 0), 0), 0);
      const efisiensi = (jarak > 0 && literBeli > 0) ? jarak / literBeli : null;
      const grandTotal = biayaBbm + biayaTol + biayaOperasional + biayaServis;
      const jumlahTripAsli = trips.filter(u => u.jenisPenggunaan !== 'isi-bbm-saja').length;
      return { car, jumlahTrip: jumlahTripAsli, jarak, literBeli, biayaBbm, biayaTol, biayaOperasional, biayaServis, efisiensi, grandTotal };
    }).filter(r => r.jarak > 0 || r.biayaBbm > 0 || r.biayaTol > 0 || r.biayaOperasional > 0 || r.biayaServis > 0 || r.jumlahTrip > 0);

    const totalJarak = perMobil.reduce((s, r) => s + r.jarak, 0);
    const totalLiterBeli = perMobil.reduce((s, r) => s + r.literBeli, 0);
    const totalBiayaBbm = perMobil.reduce((s, r) => s + r.biayaBbm, 0);
    const totalBiayaTol = perMobil.reduce((s, r) => s + r.biayaTol, 0);
    const totalBiayaServis = perMobil.reduce((s, r) => s + r.biayaServis, 0);
    const totalBiayaOperasional = perMobil.reduce((s, r) => s + r.biayaOperasional, 0);
    const grandTotal = totalBiayaBbm + totalBiayaTol + totalBiayaServis + totalBiayaOperasional;
    perMobil.sort((a, b) => b.grandTotal - a.grandTotal);
    return { yearMonth, totalJarak, totalLiterBeli, totalBiayaBbm, totalBiayaTol, totalBiayaServis, totalBiayaOperasional, grandTotal, perMobil };
  }

  // Susun layout PDF Laporan Bulanan -- tata letak, warna (NAVY/BLUE/GRAY,
  // maks 3 warna), dan urutan baris SENGAJA disamakan PERSIS dgn
  // exportMonthlyReportPdf() di index.html, supaya versi Telegram & versi
  // "Export PDF" manual di aplikasi terlihat sama.
  function buildMonthlyReportPdfBytes(report, namaBulan) {
    const NAVY = [22, 28, 39], BLUE = [30, 79, 187], GRAY = [107, 114, 128];
    const pages = [];
    let texts = [], lines = [], y = 0;

    texts.push({ x: 14, y: 18, size: 16, bold: true, color: NAVY, text: 'Laporan Bulanan FleetOps' });
    texts.push({ x: 14, y: 25, size: 11, bold: false, color: GRAY, text: namaBulan });
    lines.push({ x1: 14, y1: 29, x2: 196, y2: 29, color: GRAY, width: 0.5 });

    y = 38;
    const ringkasan = [
      ['Total Jarak', report.totalJarak.toLocaleString('id-ID') + ' KM'],
      ['Total BBM', report.totalLiterBeli.toLocaleString('id-ID') + ' L'],
      ['Biaya BBM', fmtMoney(report.totalBiayaBbm)],
      ['Biaya Tol', fmtMoney(report.totalBiayaTol)],
      ['Biaya Servis', fmtMoney(report.totalBiayaServis)],
      ['Biaya Operasional Lain', fmtMoney(report.totalBiayaOperasional)],
    ];
    ringkasan.forEach(([k, v]) => {
      texts.push({ x: 14, y, size: 10, bold: false, color: GRAY, text: k });
      texts.push({ x: 90, y, size: 10, bold: false, color: NAVY, text: v });
      y += 6;
    });
    y += 2;
    lines.push({ x1: 14, y1: y, x2: 196, y2: y, color: BLUE, width: 0.7 });
    y += 8;
    texts.push({ x: 14, y, size: 12, bold: true, color: BLUE, text: 'Grand Total: ' + fmtMoney(report.grandTotal) });

    y += 14;
    texts.push({ x: 14, y, size: 12, bold: true, color: NAVY, text: 'Rincian per Mobil' });
    y += 8;

    const colX = [14, 65, 80, 105, 125, 148, 171];
    const headers = ['Mobil', 'Trip', 'Jarak', 'Efisiensi', 'Biaya BBM', 'Biaya Lain', 'Total'];
    headers.forEach((h, i) => texts.push({ x: colX[i], y, size: 8.5, bold: true, color: GRAY, text: h }));
    y += 2;
    lines.push({ x1: 14, y1: y, x2: 196, y2: y, color: GRAY, width: 0.2 });
    y += 5;

    function newPage() {
      pages.push({ texts, lines });
      texts = []; lines = [];
      y = 20;
    }

    if (report.perMobil.length === 0) {
      texts.push({ x: 14, y, size: 9, bold: false, color: GRAY, text: '(Tidak ada aktivitas mobil bulan ini)' });
      y += 6;
    }
    report.perMobil.forEach(x => {
      if (y > 280) newPage();
      const biayaLain = x.biayaTol + x.biayaServis + x.biayaOperasional;
      const cells = [
        carLabel(x.car.id).slice(0, 26),
        String(x.jumlahTrip),
        x.jarak.toLocaleString('id-ID') + ' KM',
        x.efisiensi != null ? x.efisiensi.toFixed(1) : '-',
        fmtMoney(x.biayaBbm).replace(/^Rp\s*/, ''),
        fmtMoney(biayaLain).replace(/^Rp\s*/, ''),
        fmtMoney(x.grandTotal).replace(/^Rp\s*/, ''),
      ];
      cells.forEach((c, i) => texts.push({ x: colX[i], y, size: 8.5, bold: false, color: NAVY, text: c }));
      y += 6;
    });

    texts.push({ x: 14, y: 290, size: 8, bold: false, color: GRAY, text: `Dibuat otomatis oleh FleetOps - ${new Date().toLocaleString('id-ID')}` });
    pages.push({ texts, lines });

    return buildSimplePdfBytes(pages);
  }

  // Kirim file BINER apa pun (PDF, dll) sbg dokumen Telegram -- sama pola
  // dgn sendTgDocument (CSV) di atas, cuma menerima bytes+mimeType langsung
  // (bukan teks) supaya bisa dipakai ulang utk format lain nanti juga.
  async function sendTgDocumentBytes(chatId, filename, bytes, mimeType, caption) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', caption || '');
      form.append('parse_mode', 'HTML');
      form.append('document', new Blob([bytes], { type: mimeType }), filename);
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok || !resBody.ok) { log(`❌ Gagal kirim file ke ${chatId}:`, JSON.stringify(resBody)); return false; }
      return true;
    } catch (e) { log(`❌ Gagal kirim file ke ${chatId}:`, e.message); return false; }
  }
  // v3.140.0 -- Laporan Bulanan Otomatis. Tanggal 1-7 tiap bulan (jendela
  // toleransi 7 hari -- BUKAN cuma tanggal 1 -- supaya kalau cron sempat
  // gagal/Worker down persis tanggal 1, laporan tetap terkirim begitu cron
  // jalan lagi dalam seminggu itu, bukan lewat total sebulan), dedup lewat
  // monthlyReportSentFor (per-bulan yang DILAPORKAN, bukan bulan kirim)
  // supaya cron yang jalan tiap beberapa menit tidak kirim berkali-kali.
  // Isi: total armada (biaya+KM+trip) bulan LALU, + rincian per Mobil &
  // per Sopir. Dikirim ke SEMUA admin (Secret TELEGRAM_CHAT_ID + admin dari
  // menu Pengaturan), TIDAK ke sopir manapun -- ini murni urusan pengelola.
  async function runMonthlyReportIfDue(forceOpts) {
    const force = forceOpts && forceOpts.force;
    const jakartaNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const tanggalHariIni = jakartaNow.getDate();
    if (!force && tanggalHariIni > 7) return; // di luar jendela toleransi -- tunggu bulan depan

    const bulanLaluDate = (forceOpts && forceOpts.targetMonth)
      ? new Date(forceOpts.targetMonth + '-01T00:00:00')
      : new Date(jakartaNow.getFullYear(), jakartaNow.getMonth() - 1, 1);
    const targetYearMonth = bulanLaluDate.toISOString().slice(0, 7); // "YYYY-MM"
    if (!force && monthlyReportSentFor === targetYearMonth) return; // sudah pernah dikirim utk bulan ini

    const reportRecipients = new Map();
    // v3.179.0 -- Administrator (ADMIN_CHAT_IDS) SENGAJA TIDAK digerbangi
    // rolePrefs sama sekali -- mereka selalu dapat SEMUA kategori (sesuai
    // desain awal menu Notifikasi Telegram per Peran).
    ADMIN_CHAT_IDS.forEach((cid, idx) => reportRecipients.set(cid, `Admin${ADMIN_CHAT_IDS.length > 1 ? ' ' + (idx + 1) : ''} (Secret)`));
    if (rolePrefs.admin.laporanBulanan !== false) {
      (state.notifAdmins || []).forEach(a => {
        const cid = (a.chatId || '').toString().trim();
        if (cid) reportRecipients.set(cid, `Admin: ${a.nama || cid}`);
      });
    }
    // BARU -- Admin Finance (state.financeAdmins) sekarang JUGA ikut dapat
    // Laporan Bulanan (ringkasan armada + rincian CSV), TANPA syarat
    // tambahan (beda dari nota/pengingat 5 jam yg mensyaratkan JUGA jadi
    // Sopir/Admin) -- laporan bulanan memang relevan langsung utk Finance.
    // v3.179.0 -- sekarang digerbangi rolePrefs.finance.laporanBulanan
    // (default true, sesuai perilaku di atas).
    if (rolePrefs.finance.laporanBulanan !== false) {
      (state.financeAdmins || []).forEach(fa => {
        const cid = (fa.chatId || '').toString().trim();
        if (cid) reportRecipients.set(cid, `Finance: ${fa.nama || cid}`);
      });
    }
    // v3.184.0 -- Administrator (state.superAdmins) OPT-IN (rolePrefs.superadmin.
    // laporanBulanan === true, default OFF -- sebelumnya TIDAK PERNAH dapat
    // Laporan Bulanan sama sekali lewat jalur ini).
    if (rolePrefs.superadmin && rolePrefs.superadmin.laporanBulanan === true) {
      (state.superAdmins || []).forEach(sa => {
        const cid = (sa.chatId || '').toString().trim();
        if (cid) reportRecipients.set(cid, `Administrator: ${cid}`);
      });
    }
    if (reportRecipients.size === 0) {
      log(`ℹ️ Laporan Bulanan (${targetYearMonth}) dilewati -- belum ada admin dgn Chat ID terisi.`);
      return; // TIDAK ditandai terkirim -- coba lagi di cron berikutnya, siapa tahu admin baru saja diisi
    }

    const perCar = state.cars.map(c => {
      const trips = state.usage.filter(u => u.carId === c.id && (u.tglKeluar || '').startsWith(targetYearMonth));
      const totalKm = trips.reduce((sum, u) => (u.odoKeluar != null && u.odoKembali != null && u.odoKembali >= u.odoKeluar) ? sum + (u.odoKembali - u.odoKeluar) : sum, 0);
      return { car: c, jumlahTrip: trips.length, totalKm, totalBiaya: computeMonthlyCostForCar(c.id, targetYearMonth) };
    }).filter(r => r.jumlahTrip > 0 || r.totalBiaya > 0);

    const perDriver = state.drivers.map(d => {
      const trips = state.usage.filter(u => u.driverId === d.id && (u.tglKeluar || '').startsWith(targetYearMonth));
      const totalKm = trips.reduce((sum, u) => (u.odoKeluar != null && u.odoKembali != null && u.odoKembali >= u.odoKeluar) ? sum + (u.odoKembali - u.odoKeluar) : sum, 0);
      return { driver: d, jumlahTrip: trips.length, totalKm };
    }).filter(r => r.jumlahTrip > 0);

    const totalBiayaArmada = perCar.reduce((s, r) => s + r.totalBiaya, 0);
    const totalKmArmada = perCar.reduce((s, r) => s + r.totalKm, 0);
    const totalTripArmada = perCar.reduce((s, r) => s + r.jumlahTrip, 0);
    const namaBulan = bulanLaluDate.toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

    if (totalTripArmada === 0 && totalBiayaArmada === 0) {
      log(`ℹ️ Laporan Bulanan (${namaBulan}): tidak ada aktivitas sama sekali -- tetap dikirim (ringkasan kosong), supaya admin tahu cron-nya jalan normal.`);
    }

    perCar.sort((a, b) => b.totalBiaya - a.totalBiaya);
    perDriver.sort((a, b) => b.jumlahTrip - a.jumlahTrip);

    const lines = [
      `📊 <b>Laporan Bulanan FleetOps — ${escapeHtmlTg(namaBulan)}</b>`, '',
      '<b>Ringkasan Armada</b>',
      `💰 Total Biaya: ${fmtMoney(totalBiayaArmada)}`,
      `🛣️ Total Jarak: ${totalKmArmada.toLocaleString('id-ID')} KM`,
      `🚗 Total Perjalanan: ${totalTripArmada} trip`, '',
    ];
    if (perCar.length > 0) {
      lines.push('<b>🚗 Per Mobil</b>');
      perCar.forEach(r => lines.push(`• ${escapeHtmlTg(carLabel(r.car.id))} — ${r.jumlahTrip} trip, ${r.totalKm.toLocaleString('id-ID')} KM, ${fmtMoney(r.totalBiaya)}`));
      lines.push('');
    }
    if (perDriver.length > 0) {
      lines.push('<b>🪪 Per Sopir</b>');
      perDriver.forEach(r => lines.push(`• ${escapeHtmlTg(r.driver.nama)} — ${r.jumlahTrip} trip, ${r.totalKm.toLocaleString('id-ID')} KM`));
      lines.push('');
    }
    lines.push('📎 Rincian lengkap terlampir: file CSV (Excel) & PDF.');
    lines.push(`<i>Dikirim otomatis ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })} WIB</i>`);
    const messageText = lines.join('\n');

    const csvRows = [['Jenis', 'Nama', 'Jumlah Trip', 'Total KM', 'Total Biaya (Rp)']];
    perCar.forEach(r => csvRows.push(['Mobil', carLabel(r.car.id), r.jumlahTrip, r.totalKm, r.totalBiaya]));
    perDriver.forEach(r => csvRows.push(['Sopir', r.driver.nama, r.jumlahTrip, r.totalKm, '']));
    csvRows.push(['TOTAL ARMADA', '', totalTripArmada, totalKmArmada, totalBiayaArmada]);
    const csvText = csvRows.map(row => row.map(csvCell).join(',')).join('\r\n');
    const csvFilename = `laporan-bulanan-fleetops-${targetYearMonth}.csv`;

    // BARU -- PDF dibangun SEKALI di sini (dipakai ulang utk semua penerima),
    // bukan per-penerima di dalam loop, supaya tidak menghitung ulang laporan
    // yang sama berkali-kali. Kalau gagal dibangun, laporan teks + CSV tetap
    // lanjut terkirim seperti biasa (PDF bukan syarat, cuma tambahan).
    let pdfBytes = null;
    const pdfFilename = `laporan-bulanan-fleetops-${targetYearMonth}.pdf`;
    try {
      pdfBytes = buildMonthlyReportPdfBytes(computeMonthlyReportFull(targetYearMonth), namaBulan);
    } catch (e) {
      log(`❌ Gagal membangun PDF Laporan Bulanan (${namaBulan}):`, e.message);
    }

    let terkirimKeSatuPunAdmin = false;
    for (const [chatId, label] of reportRecipients) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: messageText, parse_mode: 'HTML', disable_web_page_preview: true })
        });
        const resBody = await res.json().catch(() => ({}));
        if (!res.ok || !resBody.ok) {
          log(`❌ Laporan Bulanan gagal kirim ke ${label} (${chatId}):`, JSON.stringify(resBody));
          pushNotifLog({ ...parseLabelPeran(label), chatId, kategori: 'Laporan Bulanan', status: 'gagal' });
          continue;
        }
        terkirimKeSatuPunAdmin = true;
        pushNotifLog({ ...parseLabelPeran(label), chatId, kategori: 'Laporan Bulanan', status: 'berhasil' });
        await sendTgDocument(chatId, csvFilename, csvText, `Rincian Laporan Bulanan — ${namaBulan}`);
        if (pdfBytes) {
          await sendTgDocumentBytes(chatId, pdfFilename, pdfBytes, 'application/pdf', `Laporan Bulanan (PDF) — ${namaBulan}`);
        }
      } catch (e) {
        log(`❌ Laporan Bulanan gagal kirim ke ${label} (${chatId}):`, e.message);
      }
    }

    if (terkirimKeSatuPunAdmin) {
      if (!force) monthlyReportSentFor = targetYearMonth; // mode tes SENGAJA tidak menandai terkirim -- supaya kiriman otomatis bulan sungguhan nanti tidak ikut ke-skip
      log(`📊 Laporan Bulanan (${namaBulan}) terkirim ke ${reportRecipients.size} admin${force ? ' [MODE TES]' : ''}.`);
    } else {
      log(`❌ Laporan Bulanan (${namaBulan}) gagal terkirim ke SEMUA admin -- akan dicoba lagi di cron berikutnya (masih dlm jendela tgl 1-7).`);
    }
  }
  await runMonthlyReportIfDue(opts.forceMonthlyReport ? { force: true, targetMonth: opts.monthlyReportTargetMonth || null } : null);

  function pertanyaanBbm(car) {
    if (car.tipeIndikatorBbm === 'bar') {
      const maxBar = car.maxBarBbm || 8;
      return `⛽ Level BBM sekarang (0-${maxBar} Bar)? Contoh: 5`;
    }
    return `⛽ Level BBM sekarang (0-100%)? Contoh: 65`;
  }
  // v3.154.0 (poin G) -- PORTING PERSIS dari processTelegramUpdate(), lihat
  // komentar lengkap di sana.
  function simpleCarAvgRatio(state, car) {
    if (!car || car.kapasitasTangkiLiter == null) return null;
    let totalKm = 0, totalLiter = 0;
    state.usage.filter(u => u.carId === car.id && u.odoKeluar != null && u.odoKembali != null && u.odoKembali > u.odoKeluar).forEach(u => {
      const keluar = u.bensinKeluar != null ? Number(u.bensinKeluar) : (u.sisaBensin != null ? Number(u.sisaBensin) : null);
      const kembali = u.bensinKembali != null ? Number(u.bensinKembali) : null;
      if (keluar == null || kembali == null) return;
      const literBeli = u.literBensin ? Number(u.literBensin) : 0;
      const liter = ((keluar - kembali) / 100) * Number(car.kapasitasTangkiLiter) + literBeli;
      if (liter <= 0) return;
      totalKm += (u.odoKembali - u.odoKeluar);
      totalLiter += liter;
    });
    return (totalKm > 0 && totalLiter > 0) ? totalKm / totalLiter : null;
  }
  // v3.138.0 -- Sama persis dengan logika saldoAwal di getBiayaTolTerpakai()
  // (sengaja tidak dipanggil langsung karena getBiayaTolTerpakai baca dari
  // `state.usage`, snapshot LAMA sebelum trip ini ditutup -- di sini perlu
  // baca dari `usageArr`, array PALING BARU dari dalam pushMainDataUpdate,
  // supaya konsisten kalau ada trip lain yang baru saja tersimpan juga).
  // Dipakai KHUSUS saat sopir jawab "tidak lewat tol" di step 'etoll'.
  //
  // PENTING (v3.138.1, perbaikan bug): saldo akhir yang disimpan BUKAN
  // saldoAwal mentah, tapi saldoAwal + netTopup (Isi E-Toll yang mungkin
  // sudah dicatat sopir DI TENGAH trip ini lewat Biaya Operasional) --
  // supaya kartu yang di-top-up tapi ternyata tidak dipakai buat tol tetap
  // kehitung biayaTol = 0 ("Tidak Lewat Tol"), BUKAN salah kehitung sebesar
  // nominal top-up-nya (seolah top-up itu "habis buat tol", padahal
  // sopir sudah tegas bilang tidak lewat tol sama sekali).
  function findSaldoAkhirEtollJikaTidakLewatTol(usageArr, convo) {
    const tripIni = usageArr.find(u => u.id === convo.tripId);
    let saldoAwal = (tripIni && tripIni.saldoEtollAwal != null) ? Number(tripIni.saldoEtollAwal) : null;
    if (saldoAwal == null) {
      if (!convo.etollCardId) return null;
      const timeKeyU = usageEtollTimeKey(tripIni || {});
      const kandidat = usageArr
        .filter(x => x.id !== convo.tripId && x.etollCardId === convo.etollCardId && x.status === 'selesai' && x.saldoEtoll != null && usageEtollTimeKey(x) <= timeKeyU)
        .sort((a, b) => usageEtollTimeKey(b).localeCompare(usageEtollTimeKey(a)));
      if (kandidat.length === 0) return null;
      saldoAwal = Number(kandidat[0].saldoEtoll);
    }
    const netTopup = tripIni ? usageEtollNetTopupTotal(tripIni) : 0;
    return saldoAwal + netTopup;
  }
  // v3.138.0 -- Penutupan trip (odometer+BBM, + opsional saldo E-Toll) di-
  // satukan jadi 1 fungsi, dipakai baik untuk trip yang TIDAK pakai kartu
  // E-Toll (langsung tutup setelah BBM) maupun yang PAKAI (tutup setelah
  // step 'etoll' juga terjawab) -- supaya pesan sukses/gagal & notifikasi
  // admin tidak ditulis ulang 2x dengan risiko beda kata-kata.
  // applyExtra(trip, usageArr) opsional: dipanggil di DALAM transaksi tulis,
  // buat set field tambahan (mis. trip.saldoEtoll) sebelum disimpan.
  async function finalizeTutupTrip(chatId, convo, applyExtra) {
    const jamSekarang = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
    const tanggalSekarang = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' });
    // v3.??? -- lihat catatan sama persis di finalizeTutupTrip() versi
    // processTelegramUpdate() -- dihitung sebelum transaksi tulis karena
    // mutatorFn wajib sinkron.
    const tripAwalUntukSpeed = state.usage.find(u => u.id === convo.tripId);
    const carUntukSpeed = state.cars.find(c => c.id === convo.carId);
    const speedResult = (carUntukSpeed && carUntukSpeed.imeiGps && tripAwalUntukSpeed && tripAwalUntukSpeed.tglKeluar)
      ? await computeTripAvgSpeedKmh(env, carUntukSpeed.imeiGps, tripAwalUntukSpeed.tglKeluar, tripAwalUntukSpeed.jamKeluar, tanggalSekarang, jamSekarang)
      : { avgSpeedKmh: null, error: carUntukSpeed && !carUntukSpeed.imeiGps ? 'Mobil ini belum diisi IMEI GPS.id di Data Mobil.' : null };
    let closedTrip = null;
    const hasil = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
      const usageArr = freshRaw.data.usage || [];
      const trip = usageArr.find(u => u.id === convo.tripId);
      if (!trip || trip.status !== 'digunakan') return false;
      trip.odoKembali = convo.odometerValue;
      trip.bensinKembali = convo.bensinKembaliPercent;
      trip.status = 'selesai';
      trip.tglKembali = tanggalSekarang;
      trip.jamKembali = jamSekarang;
      trip.updatedAt = Date.now();
      trip.petugas = trip.petugas || `${convo.driverNama} (via Telegram)`;
      if (speedResult.avgSpeedKmh != null) { trip.avgSpeedKmh = speedResult.avgSpeedKmh; trip.avgSpeedError = null; }
      else if (speedResult.error) trip.avgSpeedError = speedResult.error;
      if (applyExtra) applyExtra(trip, usageArr);
      closedTrip = trip; // simpan REFERENSI (bukan salinan) supaya masih terbaca di luar closure ini
      return true;
    });

    if (hasil.ok) {
      const jarak = convo.odoKeluar != null ? (convo.odometerValue - convo.odoKeluar) : null;
      const etollLine = convo.tidakLewatTol
        ? '\nSaldo E-Toll: Tidak lewat tol (saldo/top-up dianggap masih utuh, tidak terpakai).'
        : (convo.saldoEtollValue != null ? `\nSaldo E-Toll: ${fmtMoney(convo.saldoEtollValue)}` : '');
      await sendTg(chatId, `✅ <b>Trip ditutup!</b>\n\n${escapeHtmlTg(carLabel(convo.carId))} — ${escapeHtmlTg(convo.tujuan)}\n${jarak != null ? 'Jarak: ' + jarak.toLocaleString('id-ID') + ' KM\n' : ''}Odometer Tiba: ${convo.odometerValue.toLocaleString('id-ID')} KM${etollLine}\n\nTerima kasih! 🙏`);
      const teksTutupAdminRingkasFB = `✅ <b>${escapeHtmlTg(convo.driverNama)}</b> menutup trip lewat Telegram -- ${escapeHtmlTg(carLabel(convo.carId))} (${escapeHtmlTg(convo.tujuan)}), Odometer ${convo.odometerValue.toLocaleString('id-ID')} KM.`;
      // v3.137.0 -- admin dari state.notifAdmins, sesuai preferensi
      // masing-masing ('resi' dapat resi lengkap, 'ringkas' dapat 1
      // baris ringkasan). Dicatat ke newAdminReceiptsSent (bukan ke
      // field trip -- datanya sudah kepalang di-push di atas) supaya
      // loop cadangan di bawah nanti tidak kirim dobel.
      const notifAdminsUntukIni = (state.notifAdmins || []).filter(a => a.chatId && a.tripNotif && a.tripNotif !== 'off');
      // Anti-spam: ADMIN_CHAT_IDS (Secret) & state.notifAdmins bisa memuat
      // Chat ID yang SAMA -- sendTgUnique memastikan satu Chat ID cuma
      // dikirimi SATU notifikasi tutup-trip (ADMIN_CHAT_IDS lebih dulu di
      // array ini -> kalau bentrok, versi ringkas yang menang).
      await sendTgUnique([
        ...ADMIN_CHAT_IDS.map(adminId => ({ chatId: adminId, text: teksTutupAdminRingkasFB })),
        ...notifAdminsUntukIni.map(a => ({
          chatId: a.chatId,
          text: (a.tripNotif === 'resi' || a.tripNotif === 'gambar')
            ? buildTripReceiptText({ ...closedTrip, carId: convo.carId, tujuan: convo.tujuan, driverId: convo.driverId, driver: convo.driverNama })
            : teksTutupAdminRingkasFB,
        })),
      ]);
      notifAdminsUntukIni.forEach(a => { newAdminReceiptsSent = [...newAdminReceiptsSent, `${convo.tripId}:${a.id}`].slice(-1000); });
      log(`✅ Trip ${convo.tripId} ditutup lewat chat oleh ${convo.driverNama}.`);
    } else if (hasil.reason === 'not-found') {
      await sendTg(chatId, '⚠️ Trip ini sepertinya sudah ditutup/diubah lewat aplikasi duluan -- tidak jadi diproses dari sini, supaya data tidak bentrok. Cek aplikasi untuk pastikan datanya sudah benar.');
    } else {
      await sendTg(chatId, '❌ Gagal menyimpan ke server -- coba lagi beberapa saat lagi, atau lengkapi manual lewat aplikasi.');
      log('❌ pushMainDataUpdate gagal:', JSON.stringify(hasil));
    }
  }
  async function checkIncomingReplies() {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${newLastUpdateId + 1}&timeout=0`);
      const body = await res.json().catch(() => ({}));
      if (!body.ok || !Array.isArray(body.result) || body.result.length === 0) return;

      for (const update of body.result) {
        if (update.update_id > newLastUpdateId) newLastUpdateId = update.update_id;
        // v3.145.0 -- mirror dari processTelegramUpdate(): tap tombol
        // Ya/Tidak datang sbg update.callback_query, bukan update.message.
        const cq = update.callback_query;
        const msg = update.message || (cq && cq.message);
        if (!msg) continue;
        const textRaw = cq ? String(cq.data || '').trim() : (msg.text || '').trim();
        if (!textRaw) continue;
        const text = textRaw.toLowerCase();
        const chatId = String(msg.chat.id);
        if (cq) {
          fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id })
          }).catch(() => {});
          fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageReplyMarkup`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } })
          }).catch(() => {});
        }
        const convo = newPendingConversations[chatId];

        if (convo && batalAliases().includes(text)) {
          delete newPendingConversations[chatId];
          await sendTg(chatId, '❌ Dibatalkan. Ketik "akhiri trip" lagi kapan pun kalau mau lapor ulang.');
          continue;
        }

        if (!convo) {
          if (!tibaAliases().includes(text)) continue;
          const driver = state.drivers.find(d => (d.telegramChatId || '').toString().trim() === chatId);
          if (!driver) continue;
          const tripAktif = state.usage.find(u => u.driverId === driver.id && u.status === 'digunakan');
          if (!tripAktif) {
            await sendTg(chatId, '⚠️ Tidak ditemukan trip yang sedang berjalan atas nama Anda -- kalau ini keliru, cek langsung di aplikasi.');
            continue;
          }
          const carUntukTrip = state.cars.find(c => c.id === tripAktif.carId);
          newPendingConversations[chatId] = {
            tripId: tripAktif.id, carId: tripAktif.carId, odoKeluar: tripAktif.odoKeluar,
            driverNama: driver.nama, tujuan: tripAktif.tujuan || '-',
            etollCardId: tripAktif.etollCardId || null, // v3.138.0 -- kalau terisi, tambah 1 langkah nanya saldo E-Toll setelah BBM
            step: 'odometer', startedAt: Date.now(),
          };

          // v3.144.0 -- PORTING PERSIS dari processTelegramUpdate() -- lihat
          // komentar di sana untuk detail.
          // v3.150.0 -- digate GPS_ODO_AUTOFILL_ENABLED, sama seperti versi
          // aslinya di processTelegramUpdate().
          const gpsOdoKm = (GPS_ODO_AUTOFILL_ENABLED && carUntukTrip && carUntukTrip.imeiGps)
            ? await getGpsIdMileageForImei(env, carUntukTrip.imeiGps)
            : null;

          if (gpsOdoKm != null) {
            newPendingConversations[chatId].step = 'confirm_odo_gps';
            newPendingConversations[chatId].gpsOdoSuggestion = gpsOdoKm;
            await sendTg(chatId, `📍 Oke, ${escapeHtmlTg(driver.nama)}! Trip ${escapeHtmlTg(carLabel(tripAktif.carId))} (${escapeHtmlTg(tripAktif.tujuan || '-')}) akan ditutup.\n\n🛰️ Sistem GPS mendeteksi odometer sekarang: <b>${gpsOdoKm.toLocaleString('id-ID')} KM</b>. Apakah benar?\n\nKetik <b>ya</b> kalau benar, atau <b>tidak</b> kalau mau isi manual.\n\n<i>Ketik "batal" kapan saja untuk membatalkan.</i>`, KB_YA_TIDAK);
          } else {
            await sendTg(chatId, `📍 Oke, ${escapeHtmlTg(driver.nama)}! Trip ${escapeHtmlTg(carLabel(tripAktif.carId))} (${escapeHtmlTg(tripAktif.tujuan || '-')}) akan ditutup.\n\n🔢 Odometer sekarang (KM)? Contoh: 45230\n\n<i>Ketik "batal" kapan saja untuk membatalkan.</i>`);
          }
          log(`💬 ${driver.nama} mulai percakapan tutup trip (${tripAktif.id}).`);
          continue;
        }

        const car = state.cars.find(c => c.id === convo.carId);
        if (!car) {
          delete newPendingConversations[chatId];
          await sendTg(chatId, '⚠️ Data mobil untuk trip ini sudah tidak ditemukan -- percakapan dibatalkan otomatis. Cek langsung di aplikasi.');
          continue;
        }

        // v3.144.0 -- PORTING PERSIS dari processTelegramUpdate().
        if (convo.step === 'confirm_odo_gps') {
          const jawaban = text.trim();
          const isYa = yaAliases().includes(jawaban);
          const isTidak = tidakAliases().includes(jawaban);

          if (isYa) {
            const angka = convo.gpsOdoSuggestion;
            if (convo.odoKeluar != null && angka < convo.odoKeluar) {
              convo.step = 'odometer';
              await sendTg(chatId, `⚠️ Odometer dari GPS.id (${angka.toLocaleString('id-ID')} KM) malah lebih kecil dari odometer saat berangkat (${Number(convo.odoKeluar).toLocaleString('id-ID')} KM) -- kemungkinan data GPS belum ter-update. Silakan ketik manual odometer sekarang (KM). Contoh: 45230`);
              continue;
            }
            convo.odometerValue = angka;
            convo.step = 'bbm';
            await sendTg(chatId, pertanyaanBbm(car));
            continue;
          }
          if (isTidak) {
            convo.step = 'odometer';
            await sendTg(chatId, '🔢 Oke, silakan ketik odometer sekarang (KM). Contoh: 45230');
            continue;
          }
          await sendTg(chatId, `Belum jelas 🙏 Ketik <b>ya</b> kalau odometer ${Number(convo.gpsOdoSuggestion).toLocaleString('id-ID')} KM benar, atau <b>tidak</b> kalau mau isi manual.`, KB_YA_TIDAK);
          continue;
        }

        if (convo.step === 'odometer') {
          const digitSaja = textRaw.replace(/[^\d]/g, '');
          const angka = Number(digitSaja);
          if (digitSaja === '' || !isFinite(angka)) {
            await sendTg(chatId, '⚠️ Belum berupa angka yang valid. Coba ketik ulang, contoh: 45230 (boleh pakai titik: 45.230)');
            continue;
          }
          if (convo.odoKeluar != null && angka < convo.odoKeluar) {
            await sendTg(chatId, `⚠️ Odometer (${angka.toLocaleString('id-ID')} KM) tidak boleh lebih kecil dari odometer saat berangkat (${Number(convo.odoKeluar).toLocaleString('id-ID')} KM). Coba cek lagi &amp; ketik ulang.`);
            continue;
          }
          convo.odometerValue = angka;
          convo.step = 'bbm';
          await sendTg(chatId, pertanyaanBbm(car));
          continue;
        }

        if (convo.step === 'bbm') {
          const angka = Number(textRaw.replace(',', '.'));
          if (!isFinite(angka) || textRaw.trim() === '') {
            await sendTg(chatId, '⚠️ Belum berupa angka yang valid. ' + pertanyaanBbm(car));
            continue;
          }
          const maxBar = car.maxBarBbm || 8;
          const batasAtas = car.tipeIndikatorBbm === 'bar' ? maxBar : 100;
          if (angka < 0 || angka > batasAtas) {
            await sendTg(chatId, `⚠️ Harus di antara 0-${batasAtas}. ` + pertanyaanBbm(car));
            continue;
          }
          convo.bensinKembaliPercent = car.tipeIndikatorBbm === 'bar' ? convertBarToPercent(angka, maxBar) : angka;

          // v3.154.0 (poin G) -- PORTING PERSIS dari processTelegramUpdate().
          const tripRecordBbm = state.usage.find(u => u.id === convo.tripId);
          const keluarPercentBbm = tripRecordBbm ? (tripRecordBbm.bensinKeluar != null ? Number(tripRecordBbm.bensinKeluar) : (tripRecordBbm.sisaBensin != null ? Number(tripRecordBbm.sisaBensin) : null)) : null;
          const jarakTripBbm = (convo.odometerValue != null && convo.odoKeluar != null) ? (convo.odometerValue - convo.odoKeluar) : null;
          if (keluarPercentBbm != null && jarakTripBbm != null && jarakTripBbm > 0 && car.kapasitasTangkiLiter != null) {
            const literTerpakaiTripBbm = ((keluarPercentBbm - convo.bensinKembaliPercent) / 100) * Number(car.kapasitasTangkiLiter);
            if (literTerpakaiTripBbm > 0) {
              const ratioTripBbm = jarakTripBbm / literTerpakaiTripBbm;
              const avgRatioBbm = simpleCarAvgRatio(state, car);
              const BATAS_BAWAH_RATIO = 0.5, BATAS_ATAS_RATIO = 2.0;
              if (avgRatioBbm != null && (ratioTripBbm < avgRatioBbm * BATAS_BAWAH_RATIO || ratioTripBbm > avgRatioBbm * BATAS_ATAS_RATIO)) {
                convo.step = 'confirm_bbm_anomaly';
                convo.bensinKembaliAngkaMentah = angka;
                await sendTg(chatId, `⚠️ Sebentar -- dari jarak ${jarakTripBbm.toLocaleString('id-ID')} KM & level BBM yang baru diketik, hasilnya sekitar ${ratioTripBbm.toFixed(1)} KM/L. Biasanya mobil ini sekitar ${avgRatioBbm.toFixed(1)} KM/L -- ini beda cukup jauh, kemungkinan salah baca/ketik levelnya.\n\nKetik <b>ya</b> kalau angkanya memang benar begitu, atau <b>tidak</b> untuk ketik ulang.`, KB_YA_TIDAK);
                continue;
              }
            }
          }

          // v3.138.0 -- kalau trip ini tercatat pakai kartu E-Toll, tanya dulu
          // saldo akhirnya (1 langkah tambahan) sebelum trip ditutup. Kalau
          // tidak pakai kartu sama sekali, langsung tutup seperti sebelumnya.
          if (convo.etollCardId) {
            convo.step = 'etoll';
            await sendTg(chatId, '💳 Saldo kartu E-Toll (Rp) sekarang berapa?\n\nKalau nggak sempat cek, ketik 0. Kalau nggak lewat tol sama sekali, ketik "tidak".');
            continue;
          }
          await finalizeTutupTrip(chatId, convo, null);
          delete newPendingConversations[chatId];
          continue;
        }

        // v3.154.0 (poin G) -- PORTING PERSIS dari processTelegramUpdate().
        if (convo.step === 'confirm_bbm_anomaly') {
          const jawaban = text.trim();
          const isYa = yaAliases().includes(jawaban);
          const isTidak = tidakAliases().includes(jawaban);
          if (isYa) {
            if (convo.etollCardId) {
              convo.step = 'etoll';
              await sendTg(chatId, '💳 Saldo kartu E-Toll (Rp) sekarang berapa?\n\nKalau nggak sempat cek, ketik 0. Kalau nggak lewat tol sama sekali, ketik "tidak".');
              continue;
            }
            await finalizeTutupTrip(chatId, convo, null);
            delete newPendingConversations[chatId];
            continue;
          }
          if (isTidak) {
            convo.step = 'bbm';
            await sendTg(chatId, '🔁 Oke, ' + pertanyaanBbm(car));
            continue;
          }
          await sendTg(chatId, 'Belum jelas 🙏 Ketik <b>ya</b> kalau levelnya memang benar begitu, atau <b>tidak</b> untuk ketik ulang.', KB_YA_TIDAK);
          continue;
        }

        if (convo.step === 'etoll') {
          // "tidak"/"nggak"/"gak"/"no"/dst (atau cuma "-") -- BUKAN
          // dikosongkan, tapi diartikan saldo/top-up masih UTUH (tidak ada
          // yang terpakai buat tol), supaya otomatis kehitung "Tidak Lewat
          // Tol (Kemungkinan)" = Rp 0 -- BUKAN "belum ada info" (kosong),
          // dan BUKAN salah kehitung sebesar nominal top-up kalau kebetulan
          // sopir sudah sempat isi "Isi E-Toll" di tengah trip ini. Lihat
          // findSaldoAkhirEtollJikaTidakLewatTol().
          if (/^(tidak|nggak|enggak|gak|ga|tdk|no)\b/i.test(textRaw) || textRaw === '-') {
            convo.tidakLewatTol = true;
            convo.saldoEtollValue = null;
            await finalizeTutupTrip(chatId, convo, (trip, usageArr) => {
              const saldoAkhir = findSaldoAkhirEtollJikaTidakLewatTol(usageArr, convo);
              if (saldoAkhir != null) trip.saldoEtoll = saldoAkhir;
              // kalau tidak ketemu saldo awalnya (mis. kartu ini belum pernah
              // dipakai sebelumnya) -- dilewati diam-diam, trip.saldoEtoll
              // tetap kosong, sama seperti kalau field ini tidak dijawab.
            });
            delete newPendingConversations[chatId];
            continue;
          }
          const digitSaja = textRaw.replace(/[^\d]/g, '');
          const angka = Number(digitSaja);
          if (digitSaja === '' || !isFinite(angka)) {
            await sendTg(chatId, '⚠️ Belum berupa angka yang valid. Saldo kartu E-Toll (Rp) sekarang berapa? Contoh: 50000. Atau ketik "tidak" kalau tidak lewat tol.');
            continue;
          }
          if (angka === 0) {
            // v3.138.2 -- Kalau kartu ini SUDAH ada top-up ("Isi E-Toll") yang
            // dicatat di trip ini, "0" TIDAK langsung dianggap "tidak sempat
            // cek" -- itu terlalu berisiko diam-diam kehilangan jejak (uang
            // beneran sudah masuk kartu, tapi trip-nya tidak pernah ditandai
            // butuh dicek). Tanya konfirmasi 1 kali dulu; kalau TIDAK ada
            // top-up sama sekali, langsung skip seperti biasa (aman, tidak
            // ada apa pun yang perlu dikonfirmasi).
            const tripSnapshot = state.usage.find(u => u.id === convo.tripId);
            const netTopupTrip = tripSnapshot ? usageEtollNetTopupTotal(tripSnapshot) : 0;
            if (netTopupTrip > 0) {
              convo.netTopupPendingConfirm = netTopupTrip;
              convo.step = 'etoll_confirm_zero';
              await sendTg(chatId, `⚠️ Kamu sempat isi top-up E-Toll ${fmtMoney(netTopupTrip)} di trip ini. Yakin TIDAK lewat tol sama sekali?\n\nKetik "ya" kalau yakin, atau ketik ulang saldo E-Toll sekarang (Rp) kalau ternyata ada yang kepakai.`);
              continue;
            }
            // Ketik "0" diartikan "tidak sempat cek", BUKAN saldo beneran
            // Rp 0 -- sengaja TIDAK disimpan, dibiarkan kosong (sama seperti
            // field ini belum pernah dijawab/diisi lewat aplikasi).
            convo.saldoEtollValue = null;
            await finalizeTutupTrip(chatId, convo, null);
          } else {
            convo.saldoEtollValue = angka;
            await finalizeTutupTrip(chatId, convo, (trip) => { trip.saldoEtoll = angka; });
          }
          delete newPendingConversations[chatId];
          continue;
        }

        // v3.138.2 -- Susulan dari step 'etoll' KHUSUS saat sopir jawab "0"
        // padahal ada top-up E-Toll tercatat di trip ini (lihat blok di
        // atas) -- supaya kombinasi paling berisiko (uang beneran sudah
        // masuk kartu, tapi datanya nyaris lewat tanpa dicek) tidak lolos
        // diam-diam.
        if (convo.step === 'etoll_confirm_zero') {
          if (/^(ya|yakin|iya|yes|bener|betul|benar)\b/i.test(textRaw)) {
            // Dikonfirmasi: memang tidak lewat tol -- top-up dianggap masih
            // utuh di kartu, sama seperti jawaban "tidak" di step 'etoll'.
            convo.tidakLewatTol = true;
            convo.saldoEtollValue = null;
            await finalizeTutupTrip(chatId, convo, (trip, usageArr) => {
              const saldoAkhir = findSaldoAkhirEtollJikaTidakLewatTol(usageArr, convo);
              if (saldoAkhir != null) trip.saldoEtoll = saldoAkhir;
            });
            delete newPendingConversations[chatId];
            continue;
          }
          const digitSaja2 = textRaw.replace(/[^\d]/g, '');
          const angka2 = Number(digitSaja2);
          if (digitSaja2 === '' || !isFinite(angka2)) {
            await sendTg(chatId, `⚠️ Belum jelas. Ketik "ya" kalau yakin tidak lewat tol, atau ketik saldo E-Toll sekarang (Rp) yang sebenarnya. Contoh: 50000.`);
            continue;
          }
          // Sopir kirim angka riil (termasuk kalau kebetulan ketik "0" lagi
          // -- di titik ini dianggap sebagai saldo Rp 0 yang SUDAH
          // dikonfirmasi lewat pertanyaan susulan, bukan "tidak sempat cek"
          // lagi, supaya tidak muter-muter tanya terus).
          convo.saldoEtollValue = angka2;
          await finalizeTutupTrip(chatId, convo, (trip) => { trip.saldoEtoll = angka2; });
          delete newPendingConversations[chatId];
          continue;
        }
      }
    } catch (e) {
      log('❌ Gagal cek balasan chat (getUpdates):', e.message);
    }
  }
  // v2.1 -- checkIncomingReplies() TIDAK LAGI dipanggil di sini: begitu
  // webhook /telegram-webhook aktif (lihat processTelegramUpdate()),
  // Telegram MENOLAK getUpdates() dipakai bersamaan webhook (error 409).
  // Fungsinya sengaja tetap dibiarkan ada di atas sebagai kerangka/
  // cadangan (tidak pernah dipanggil) -- lihat catatan lengkap di
  // processTelegramUpdate().

  // ---- Auto-kirim Tanda Terima Perjalanan (cadangan, kalau jalur instan gagal/belum sinkron) ----
  const receiptsSentSet = new Set(newReceiptsSent);
  // v3.179.0 -- gerbang izin peran utk Resi Perjalanan (Sopir) -- SAMA
  // dgn gerbang di index.html (jalur instan), supaya konsisten: kalau
  // Administrator matikan "Resi Perjalanan" utk peran Sopir, jalur CADANGAN
  // (cron) ini juga TIDAK BOLEH tetap mengirim.
  const tripsNeedingReceipt = rolePrefs.sopir.resi !== false ? state.usage.filter(u =>
    u.status === 'selesai' && !u.telegramResiSent && !receiptsSentSet.has(u.id) &&
    (() => { const d = state.drivers.find(x => x.id === u.driverId); return d && (d.telegramChatId || '').toString().trim(); })()
  ) : [];
  if (tripsNeedingReceipt.length > 0) {
    log(`🧾 ${tripsNeedingReceipt.length} resi perjalanan baru untuk dikirim...`);
    for (const u of tripsNeedingReceipt) {
      const driver = state.drivers.find(x => x.id === u.driverId);
      const chatId = (driver.telegramChatId || '').toString().trim();
      try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: buildTripReceiptText(u), parse_mode: 'HTML' })
        });
        const resBody = await res.json().catch(() => ({}));
        if (!res.ok || !resBody.ok) {
          log(`❌ Gagal kirim resi trip ${u.id} ke ${driver.nama} (${chatId}):`, JSON.stringify(resBody));
          pushNotifLog({ nama: driver.nama, peran: 'sopir', chatId, kategori: 'Resi Perjalanan', status: 'gagal' });
          continue;
        }
        newReceiptsSent = [...newReceiptsSent, u.id].slice(-500);
        pushNotifLog({ nama: driver.nama, peran: 'sopir', chatId, kategori: 'Resi Perjalanan', status: 'berhasil' });
        log(`✅ Resi trip ${u.id} terkirim ke ${driver.nama}.`);
      } catch (e) {
        log(`❌ Gagal kirim resi trip ${u.id} ke ${driver.nama} (${chatId}):`, e.message);
      }
    }
  }

  // ---- Auto-kirim notifikasi ADMIN saat trip selesai (cadangan sama seperti
  //      resi sopir di atas -- jalur utamanya instan dari index.html) ----
  // v3.179.0 -- gerbang izin peran (rolePrefs.admin.resi) SEBAGAI GERBANG
  // TAMBAHAN di atas pengaturan per-admin (tripNotif) yang sudah ada --
  // harus KEDUANYA mengizinkan (default admin:true, tidak mengubah
  // perilaku lama sampai sengaja dimatikan Administrator).
  const adminReceiptsSentSet = new Set(newAdminReceiptsSent);
  const adminsForTripNotif = rolePrefs.admin.resi !== false ? (state.notifAdmins || []).filter(a => a.chatId && a.tripNotif && a.tripNotif !== 'off') : [];
  if (adminsForTripNotif.length > 0) {
    const tripsSelesai = state.usage.filter(u => u.status === 'selesai');
    let sentCountAdmin = 0;
    for (const u of tripsSelesai) {
      const sentIds = Array.isArray(u.telegramAdminNotifSentIds) ? u.telegramAdminNotifSentIds : [];
      // Anti-spam: kalau Chat ID admin ini SAMA dengan Chat ID sopir pemilik
      // trip ini (1 orang terdaftar dobel sbg sopir & admin), dia sudah
      // dapat resi/notif-nya sendiri lewat jalur Sopir di atas -- jangan
      // dikirimi salinan kedua di sini (pola sama dgn guard Administrator).
      const driverUntukAdminNotif = state.drivers.find(x => x.id === u.driverId);
      const driverChatIdUntukAdminNotif = driverUntukAdminNotif ? (driverUntukAdminNotif.telegramChatId || '').toString().trim() : '';
      for (const a of adminsForTripNotif) {
        const key = `${u.id}:${a.id}`;
        if (sentIds.includes(a.id) || adminReceiptsSentSet.has(key)) continue; // sudah pernah ke admin ini
        if (driverChatIdUntukAdminNotif && (a.chatId || '').toString().trim() === driverChatIdUntukAdminNotif) continue;
        const chatId = a.chatId;
        // 'gambar' diperlakukan SAMA seperti 'resi' di jalur cron ini (teks
        // lengkap) -- Worker tidak bisa render gambar (butuh browser/canvas,
        // lihat catatan di index.html/generateTripReceiptBlob). Jalur instan
        // di index.html TETAP kirim gambar sungguhan; ini murni cadangan.
        const text = (a.tripNotif === 'resi' || a.tripNotif === 'gambar')
          ? buildTripReceiptText(u)
          : `✅ <b>Trip Selesai</b>\n\n${escapeHtmlTg(carLabel(u.carId))} — ${escapeHtmlTg(u.tujuan || '-')}\nSopir: ${escapeHtmlTg(driverLabel(u.driverId, u.driver))}\nTiba: ${u.tglKembali ? escapeHtmlTg(u.tglKembali) : '-'}${u.jamKembali ? ', ' + u.jamKembali : ''}`;
        try {
          const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
          });
          const resBody = await res.json().catch(() => ({}));
          if (!res.ok || !resBody.ok) {
            log(`❌ Gagal kirim notif admin (trip ${u.id}) ke ${a.nama || chatId}:`, JSON.stringify(resBody));
            pushNotifLog({ nama: a.nama || chatId, peran: 'admin', chatId, kategori: (a.tripNotif === 'resi' || a.tripNotif === 'gambar') ? 'Resi Perjalanan' : 'Trip Selesai', status: 'gagal' });
            continue;
          }
          newAdminReceiptsSent = [...newAdminReceiptsSent, key].slice(-1000);
          adminReceiptsSentSet.add(key);
          sentCountAdmin++;
          pushNotifLog({ nama: a.nama || chatId, peran: 'admin', chatId, kategori: (a.tripNotif === 'resi' || a.tripNotif === 'gambar') ? 'Resi Perjalanan' : 'Trip Selesai', status: 'berhasil' });
        } catch (e) {
          log(`❌ Gagal kirim notif admin (trip ${u.id}) ke ${a.nama || chatId}:`, e.message);
        }
      }
    }
    if (sentCountAdmin > 0) log(`👤 ${sentCountAdmin} notifikasi trip-selesai terkirim ke admin.`);
  }

  // ============================================================================
  // v3.184.0 -- Resi Perjalanan utk Administrator. OPT-IN (rolePrefs.superadmin.
  // resi === true, dibaca dgn "=== true" bukan "!== false" krn defaultnya OFF,
  // beda dari kategori lain yang default ON) -- Administrator sebelumnya TIDAK
  // PERNAH dapat resi trip sama sekali. Kalau sopir pemilik trip itu SENDIRI
  // kebetulan terdaftar sbg Administrator (Chat ID sama), salinan resi ini TIDAK
  // dikirim ke dia -- dia sudah dapat resi-nya sendiri lewat jalur Sopir di
  // atas, tidak perlu laporan balik ke pembuatnya sendiri.
  // ============================================================================
  const superAdminReceiptsSentSet = new Set(newSuperAdminReceiptsSent);
  const superAdminsUntukResi = (rolePrefs.superadmin && rolePrefs.superadmin.resi === true) ? (state.superAdmins || []).filter(sa => sa.chatId) : [];
  if (superAdminsUntukResi.length > 0) {
    const tripsSelesaiUntukSA = state.usage.filter(u => u.status === 'selesai');
    let sentCountSuperAdmin = 0;
    for (const u of tripsSelesaiUntukSA) {
      const driverSA = state.drivers.find(x => x.id === u.driverId);
      const driverChatIdSA = driverSA ? (driverSA.telegramChatId || '').toString().trim() : '';
      for (const sa of superAdminsUntukResi) {
        const saChatId = (sa.chatId || '').toString().trim();
        if (!saChatId) continue;
        if (driverChatIdSA && saChatId === driverChatIdSA) continue; // dia sendiri pembuat laporan -- jangan kirim balik
        const key = `${u.id}:${sa.id}`;
        if (superAdminReceiptsSentSet.has(key)) continue;
        try {
          const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: saChatId, text: buildTripReceiptText(u), parse_mode: 'HTML' })
          });
          const resBody = await res.json().catch(() => ({}));
          if (!res.ok || !resBody.ok) {
            log(`❌ Gagal kirim resi trip ${u.id} ke Administrator (${saChatId}):`, JSON.stringify(resBody));
            pushNotifLog({ nama: sa.nama || saChatId, peran: 'superadmin', chatId: saChatId, kategori: 'Resi Perjalanan', status: 'gagal' });
            continue;
          }
          newSuperAdminReceiptsSent = [...newSuperAdminReceiptsSent, key].slice(-1000);
          superAdminReceiptsSentSet.add(key);
          sentCountSuperAdmin++;
          pushNotifLog({ nama: sa.nama || saChatId, peran: 'superadmin', chatId: saChatId, kategori: 'Resi Perjalanan', status: 'berhasil' });
        } catch (e) {
          log(`❌ Gagal kirim resi trip ${u.id} ke Administrator (${saChatId}):`, e.message);
        }
      }
    }
    if (sentCountSuperAdmin > 0) log(`👑 ${sentCountSuperAdmin} notifikasi resi trip-selesai terkirim ke Administrator.`);
  }

  // ============================================================================
  // BARU: Konfirmasi Booking H-1 Jam -- 1 jam sebelum jadwal booking hari ini,
  // tanya LANGSUNG ke sopir yang tercantum di booking (atau admin yang
  // membuatnya kalau belum ada sopir dipilih) apakah jadi berangkat, lengkap
  // dengan tombol "✅ Ya, Berangkat" / "❌ Batal". SENGAJA TERPISAH TOTAL dari
  // alur computeAlerts()/toSend/notifAdmins/recipients di atas (yang
  // broadcast ke SEMUA admin+sopir) -- pesan ini PRIBADI, hanya untuk 1 chat,
  // TIDAK disiarkan ke siapa pun yang lain (sesuai permintaan). Tap tombolnya
  // ditangani di processTelegramUpdate() (cari "bkh1:jadi:"/"bkh1:batal:").
  // Dicek TIAP KALI cron jalan (bukan ikut interval "Cek notifikasi berkala")
  // supaya jendela H-1 jam tidak kelewat -- dedup sendiri (bookingH1JamAskedSet,
  // dipersiskan lewat persistState() di bawah) memastikan SEKALI tanya per
  // booking, tidak berulang tiap cron jalan.
  // ============================================================================
  const hariIniStrH1Jam = today();
  const bookingsUntukKonfirmasiH1 = (state.bookings || []).filter(b => {
    if (b.status !== 'dipesan') return false;
    if (b.tglMulai !== hariIniStrH1Jam || !b.jamMulai) return false;
    if (bookingH1JamAskedSet.has(b.id)) return false;
    const [jamB, menitB] = String(b.jamMulai).split(':').map(Number);
    if (isNaN(jamB)) return false;
    const berangkatAtB = new Date(`${hariIniStrH1Jam}T${String(jamB).padStart(2, '0')}:${String(menitB || 0).padStart(2, '0')}:00+07:00`);
    const menitLagiB = (berangkatAtB.getTime() - Date.now()) / 60000;
    // Jendela H-1 jam: 45-65 menit sebelum jadwal (longgar 20 menit supaya
    // tidak kelewat kalau cron sempat telat/interval-nya bukan 5 menit).
    return menitLagiB <= 65 && menitLagiB >= 45;
  });
  if (bookingsUntukKonfirmasiH1.length > 0) {
    log(`📅 ${bookingsUntukKonfirmasiH1.length} booking hari ini memasuki jendela H-1 jam -- mengirim konfirmasi.`);
  }
  for (const b of bookingsUntukKonfirmasiH1) {
    const driverBookingH1 = b.driverId ? state.drivers.find(d => d.id === b.driverId) : null;
    const driverCidH1 = driverBookingH1 && (driverBookingH1.telegramChatId || '').toString().trim();
    const adminPembuatH1 = !driverCidH1 && b.petugas
      ? (state.notifAdmins || []).find(a => (a.nama || '').trim() === String(b.petugas).trim() && a.chatId)
      : null;
    const targetCidH1 = driverCidH1 || (adminPembuatH1 && String(adminPembuatH1.chatId).trim());
    // Ditandai "sudah ditanya" WALAU tidak ada penerima Telegram -- supaya
    // tidak dicoba ulang tiap cron jalan (5 menit) sepanjang jendela masih
    // terbuka; kalau tidak ada penerima, alert H-1 hari/hari-ini biasa (lihat
    // computeAlerts()) tetap jalan seperti biasa sbg cadangan.
    bookingH1JamAskedSet.add(b.id);
    if (!targetCidH1) {
      log(`⚠️ Booking ${b.id} (${carLabel(b.carId)}) masuk jendela H-1 jam tapi tidak ada sopir/pembuat yang terdaftar Telegram -- dilewati.`);
      continue;
    }
    const teksKonfirmasiH1 = [
      '📅 <b>Konfirmasi Booking — 1 Jam Lagi</b>', '',
      `🚗 ${escapeHtmlTg(carLabel(b.carId))}`,
      `📍 ${escapeHtmlTg(b.tujuan || '-')}`,
      `🕐 ${escapeHtmlTg(b.jamMulai)} WIB`, '',
      'Apakah jadi berangkat sesuai jadwal ini?',
    ].join('\n');
    await sendTg(targetCidH1, teksKonfirmasiH1, [[
      { text: '✅ Ya, Berangkat', callback_data: `bkh1:jadi:${b.id}` },
      { text: '❌ Batal', callback_data: `bkh1:batal:${b.id}` },
    ], [
      { text: '📱 Input dari Aplikasi Saja', callback_data: `bkh1:app:${b.id}` },
    ]]);
  }

  // ============================================================================
  // BARU: Notifikasi Finance -- kategori mana yang dikirim ke Admin Finance
  // sekarang diatur lewat menu khusus Administrator "Notifikasi Telegram per
  // Peran" (rolePrefs.finance, PIN 009900 di web) -- SEBELUMNYA hardcode
  // cuma svc-/doc-mobil, sekarang bisa kategori apapun kalau Administrator
  // menyalakannya. TERPISAH TOTAL dari alur computeAlerts()/toSend/
  // notifAdmins biasa -- dikirim LANGSUNG ke SEMUA Admin Finance
  // (state.financeAdmins), TIDAK ke Admin Penerima Notifikasi Telegram
  // biasa maupun ke Sopir manapun. Dokumen milik Sopir (SIM, dll --
  // d.subjek==='sopir') TETAP SENGAJA TIDAK diikutkan meski kategori 'doc'
  // dinyalakan utk Finance -- ini aturan bisnis tetap (Finance cuma urus
  // dokumen Mobil), bukan sesuatu yg perlu diatur lewat toggle. Dedup
  // terpisah (financeAssetNotifSentNew, kunci per id alert, value level
  // terakhir yg dikirim) -- kirim ulang HANYA kalau levelnya naik (mis.
  // warn -> danger) atau memang belum pernah dikirim, bukan tiap kali cron
  // jalan.
  // ============================================================================
  // v3.181.0 -- gerbang "harus JUGA terdaftar sbg Sopir/Admin" DIHAPUS atas
  // permintaan eksplisit -- Admin Finance sekarang independen sepenuhnya.
  const financeAdminsAktifUntukAset = (state.financeAdmins || []).filter(a => a.chatId);
  if (financeAdminsAktifUntukAset.length > 0) {
    const alertAsetUntukFinance = alerts.filter(a => {
      const kat = categoryOfAlertId(a.id);
      if (!kat || rolePrefs.finance[kat] === false) return false;
      if (kat === 'doc') {
        const docId = a.id.slice('doc-'.length);
        const doc = state.documents.find(x => x.id === docId);
        return !!(doc && doc.subjek !== 'sopir'); // Dokumen Mobil saja -- dokumen Sopir dikecualikan
      }
      return true;
    });
    const alertBaruUntukFinance = alertAsetUntukFinance.filter(a => financeAssetNotifSentNew[a.id] !== a.level);
    if (alertBaruUntukFinance.length > 0) {
      const textFinanceAset = buildAlertMessageText(alertBaruUntukFinance, '💰 <b>FleetOps — Info Finance</b>');
      const kategoriGabunganFinance = [...new Set(alertBaruUntukFinance.map(a => categoryOfAlertId(a.id) || '-'))].join(', ');
      for (const fa of financeAdminsAktifUntukAset) {
        const okKirim = await sendTg(fa.chatId, textFinanceAset);
        pushNotifLog({ nama: fa.nama || fa.chatId, peran: 'finance', chatId: fa.chatId, kategori: kategoriGabunganFinance, status: okKirim ? 'berhasil' : 'gagal' });
      }
      alertBaruUntukFinance.forEach(a => { financeAssetNotifSentNew[a.id] = a.level; });
      log(`💰 ${alertBaruUntukFinance.length} notifikasi terkirim ke ${financeAdminsAktifUntukAset.length} Admin Finance.`);
    }
    // Bersihkan entry dedup yang alert-nya sudah tidak aktif lagi (mis. sudah
    // diservis/diperpanjang) -- supaya kalau nanti alert yang SAMA IDnya
    // muncul lagi (jarang, tapi mungkin), tetap dianggap baru.
    const idAktifSaatIni = new Set(alertAsetUntukFinance.map(a => a.id));
    Object.keys(financeAssetNotifSentNew).forEach(id => {
      if (!idAktifSaatIni.has(id)) delete financeAssetNotifSentNew[id];
    });
  }

  // ============================================================================
  // v3.184.0 -- Notifikasi Administrator. SEKARANG digerbangi rolePrefs.superadmin
  // sama seperti Sopir/Finance/Admin (menu "Notifikasi Telegram per Peran"),
  // SEBELUMNYA Administrator (state.superAdmins, didaftarkan via PIN Kelola Admin di
  // Telegram) sengaja dikecualikan & selalu dapat SEMUA kategori tanpa filter.
  // Default 9 kategori ini TETAP semua true (lihat NOTIF_ROLE_PREFS_DEFAULT.
  // superadmin di atas) supaya perilaku lama tidak berubah sampai Administrator
  // sendiri yang mematikan sesuatu lewat menu itu. Alert yang kategorinya
  // tidak dikenali categoryOfAlertId() (kat===null) tetap diteruskan apa
  // adanya (tidak ada gerbang utk kategori yang tidak dikenal).
  // ============================================================================
  const superAdminsAktifUntukAset = (state.superAdmins || []).filter(a => a.chatId);
  if (superAdminsAktifUntukAset.length > 0) {
    const alertUntukSuperAdmin = alerts.filter(a => {
      const kat = categoryOfAlertId(a.id);
      return !kat || (rolePrefs.superadmin && rolePrefs.superadmin[kat] !== false);
    });
    const alertBaruUntukSuperAdmin = alertUntukSuperAdmin.filter(a => superAdminAssetNotifSentNew[a.id] !== a.level);
    if (alertBaruUntukSuperAdmin.length > 0) {
      const textSuperAdminAset = buildAlertMessageText(alertBaruUntukSuperAdmin, '👑 <b>FleetOps — Info Administrator</b>');
      const kategoriGabunganSA = [...new Set(alertBaruUntukSuperAdmin.map(a => categoryOfAlertId(a.id) || '-'))].join(', ');
      // v3.282.0 -- tombol rekomendasi "🔕 Matikan notifikasi ini" cuma
      // ditempel kalau pesan ini isinya 1 kategori (lihat komentar lengkap di
      // buildNotifRekomendasiKeyboard()) -- Administrator lolos
      // isAdminOrSuperAdmin() jadi tombolnya benar2 berfungsi kalau ditekan.
      const kbSuperAdminAset = buildNotifRekomendasiKeyboard(alertBaruUntukSuperAdmin, 'superadmin');
      for (const sa of superAdminsAktifUntukAset) {
        const okKirim = await sendTg(sa.chatId, textSuperAdminAset, kbSuperAdminAset);
        pushNotifLog({ nama: sa.nama || sa.chatId, peran: 'superadmin', chatId: sa.chatId, kategori: kategoriGabunganSA, status: okKirim ? 'berhasil' : 'gagal' });
      }
      alertBaruUntukSuperAdmin.forEach(a => { superAdminAssetNotifSentNew[a.id] = a.level; });
      log(`👑 ${alertBaruUntukSuperAdmin.length} notifikasi terkirim ke ${superAdminsAktifUntukAset.length} Administrator.`);
    }
    const idSvcAktifSaatIni = new Set(alertUntukSuperAdmin.map(a => a.id));
    Object.keys(superAdminAssetNotifSentNew).forEach(id => {
      if (!idSvcAktifSaatIni.has(id)) delete superAdminAssetNotifSentNew[id];
    });
  }

  if (toSend.length === 0) {
    await persistState(null);
    if (!dueForAlertCheck) {
      // v3.262.0 -- BARU: pesan log disesuaikan per mode (checkIntervalMs
      // TIDAK SELALU ada lagi -- cuma dideklarasikan di cabang mode
      // 'interval' di atas, lihat komentar lengkap di situ).
      if ((ns.reminderMode || 'fixed') === 'interval') {
        const checkIntervalMs = Math.max(5, Number(ns.checkIntervalMinutes) || 60) * 60000;
        const menitLagi = Math.ceil((checkIntervalMs - (Date.now() - lastAlertCheckAt)) / 60000);
        log(`⏳ Belum waktunya cek notifikasi berkala lagi (interval: tiap ${ns.checkIntervalMinutes} menit, ~${Math.max(menitLagi, 0)} menit lagi).`);
      } else {
        const jamTetapLog = Math.min(23, Math.max(0, Number(ns.reminderFixedHourWib) ?? 8));
        log(`⏳ Belum waktunya cek notifikasi berkala lagi (jam tetap: ${String(jamTetapLog).padStart(2, '0')}:00 WIB tiap hari).`);
      }
    } else {
      log(`✅ Tidak ada notifikasi baru untuk dikirim (${alerts.length} masalah aktif, semua sudah pernah dinotifkan${suppressedByQuietHours.length > 0 ? ', sisanya ditunda jam sunyi' : ''}).`);
    }
    return { ok: true, sent: 0, alertsActive: alerts.length, log: logLines };
  }

  const recipients = new Map();
  ADMIN_CHAT_IDS.forEach((cid, idx) => recipients.set(cid, { label: `Admin${ADMIN_CHAT_IDS.length > 1 ? ' ' + (idx + 1) : ''} (Secret)`, driver: null }));
  // v3.137.0 -- admin yang diatur lewat aplikasi (menu Pengaturan > Admin
  // Penerima Notifikasi Telegram) ikut jadi penerima notifikasi berkala,
  // di luar (union, bukan pengganti) admin dari Secret TELEGRAM_CHAT_ID di
  // atas -- kalau chatId sama, yang dari aplikasi menang (label lebih jelas).
  (state.notifAdmins || []).forEach(a => {
    const cid = (a.chatId || '').toString().trim();
    if (cid) recipients.set(cid, { label: `Admin: ${a.nama || cid}`, driver: null });
  });
  state.drivers.forEach(d => {
    const cid = (d.telegramChatId || '').toString().trim();
    if (cid) recipients.set(cid, { label: d.nama || 'Sopir', driver: d });
  });

  if (recipients.size === 0) {
    await persistState(null);
    log(`⚠️ Ada ${toSend.length} notifikasi baru, tapi belum ada satu pun sopir yang mengisi "Telegram Chat ID" (dan TELEGRAM_CHAT_ID juga kosong). Tidak ada yang dikirim.`);
    return { ok: true, sent: 0, noRecipients: true, log: logLines };
  }

  // ============================================================================
  // 📐 SOP PENULISAN NOTIFIKASI TELEGRAM (WAJIB DIIKUTI utk kategori alert baru)
  // Ditetapkan Agu 2026 setelah insiden notifikasi "Mesin Dinyalakan" yang
  // isinya kosong/ambigu (level 'info' tak dikenali perakit pesan). Aturan:
  //   1. JUDUL: frasa singkat, jelas, Bahasa Indonesia baku -- hindari
  //      singkatan/istilah teknis yg tidak umum (boleh istilah domain yg
  //      sudah dikenal pengguna app ini, mis. "E-Toll", "GPS.id").
  //   2. KETERANGAN: kalimat lengkap (subjek+predikat), WAJIB sebutkan
  //      identitas mobil/subjek terkait (pakai carLabel()/subjectLabel(),
  //      jangan cuma ID internal) supaya penerima langsung tahu ini soal
  //      kendaraan/hal apa tanpa perlu buka aplikasi.
  //   3. Nada profesional & netral -- hindari singkatan kasual ("Abaikan
  //      kalau...", "Info saja..."); pakai kalimat formal ("Dapat diabaikan
  //      apabila...", "Bersifat informatif...").
  //   4. level WAJIB salah satu dari 'danger' | 'warn' | 'info' -- ketiganya
  //      SUDAH ditangani buildAlertMessageText (grup 🔴/🟡/ℹ️), jangan pakai
  //      nilai lain di luar itu.
  //   5. judul & keterangan tidak boleh string kosong/undefined -- kalau
  //      datanya bisa kosong, isi fallback teks yang tetap informatif
  //      (lihat fallback otomatis di buildAlertMessageText di bawah).
  //   6. LINK PETA OPSIONAL (BARU): kalau sebuah alert item punya field
  //      `mapsLink` (url non-kosong), buildAlertMessageText otomatis
  //      menambahkan 1 baris tautan HTML setelah keterangan (label dari
  //      `mapsLinkLabel`, fallback "📍 Lihat lokasi di peta" kalau kosong).
  //      SELALU pakai link OpenStreetMap (osmMapsLink(), BUKAN Google Maps)
  //      supaya konsisten dgn peta mini Leaflet + OpenStreetMap yang sudah
  //      dipakai di popup "🛰️ Lacak" app ini -- JANGAN taruh tag HTML
  //      apa pun di dalam `keterangan` sendiri (field itu SELALU di-escape
  //      lewat escapeHtmlTg, jadi tag HTML di situ tidak akan jadi tautan,
  //      cuma tampil sbg teks mentah "<a href=...>").
  // ============================================================================
  function buildAlertMessageText(items, headerLine) {
    const danger = items.filter(a => a.level === 'danger');
    const warn = items.filter(a => a.level === 'warn');
    // BUGFIX (Agu 2026): sebelumnya item dgn level SELAIN 'danger'/'warn'
    // (mis. 'info' -- dipakai alert "Mesin Dinyalakan") tidak masuk grup mana
    // pun, jadi diam-diam HILANG dari badan pesan -- pesan tetap terkirim
    // (krn panjang array items di pemanggil sudah >0) tapi keliatan KOSONG
    // (cuma header + baris timestamp, tanpa isi sama sekali), bikin bingung
    // penerima. Sekarang level lain di luar danger/warn ditampung di grup
    // "Info" ini supaya selalu ada isinya kalau memang ada item -- 3 grup ini
    // (danger/warn/info) MENCAKUP SEMUA kemungkinan level, jadi kelas bug
    // "pesan kosong karena level tak dikenal" ini tidak akan terulang lagi.
    const info = items.filter(a => a.level !== 'danger' && a.level !== 'warn');
    const lines = [headerLine || '🚨 <b>FleetOps — Perlu Perhatian</b>', ''];
    function addGroup(list, heading) {
      if (list.length === 0) return;
      lines.push(heading);
      list.forEach(a => {
        // Pengaman tambahan (SOP poin 5): kalau suatu saat ada item dgn
        // judul/keterangan kosong (bug data, bukan bug rendering), jangan
        // tampilkan baris kosong yg membingungkan -- tampilkan fallback yg
        // tetap jujur bahwa datanya tidak lengkap.
        const judulAman = (a.judul && String(a.judul).trim()) || '(judul tidak tersedia)';
        const keteranganAman = (a.keterangan && String(a.keterangan).trim()) || '(rincian tidak tersedia -- cek aplikasi FleetOps)';
        lines.push(`${a.ic || 'ℹ️'} <b>${escapeHtmlTg(judulAman)}</b>`);
        lines.push(`   ${escapeHtmlTg(keteranganAman)}`);
        // SOP poin 6 -- link peta opsional (OpenStreetMap, BUKAN Google
        // Maps). Url-nya sendiri TIDAK di-escape (harus tetap tag <a> hidup
        // supaya bisa diklik), tapi ini AMAN krn mapsLink cuma pernah
        // dibangun lewat osmMapsLink() dari angka lat/lon GPS.id -- tidak
        // pernah dari input bebas pengguna.
        if (a.mapsLink && String(a.mapsLink).trim()) {
          const labelLink = (a.mapsLinkLabel && String(a.mapsLinkLabel).trim()) || '📍 Lihat lokasi di peta';
          lines.push(`   <a href="${a.mapsLink}">${escapeHtmlTg(labelLink)}</a>`);
        }
      });
      lines.push('');
    }
    addGroup(danger, '🔴 <b>Mendesak</b>');
    addGroup(warn, '🟡 <b>Perlu Diperhatikan</b>');
    addGroup(info, 'ℹ️ <b>Info</b>');
    lines.push(`<i>Dikirim otomatis ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })} WIB</i>`);
    return lines.join('\n').trim();
  }

  let sukses = 0, gagal = 0, dilewati = 0;
  for (const [chatId, { label, driver }] of recipients) {
    // BARU -- gerbang menu khusus "Notifikasi Telegram per Peran": Sopir
    // pakai alertsForDriver (sudah termasuk rolePrefs.sopir + langganan
    // per-driver individual yang sudah ada), Admin (ADMIN_CHAT_IDS +
    // notifAdmins) disaring per kategori pakai rolePrefs.admin.
    const alertsForThis = driver
      ? alertsForDriver(toSend, driver, rolePrefs.sopir)
      : toSend.filter(a => { const kat = categoryOfAlertId(a.id); return !kat || rolePrefs.admin[kat] !== false; });
    if (alertsForThis.length === 0) { dilewati++; continue; }
    const text = buildAlertMessageText(alertsForThis);
    const kategoriGabunganUtama = [...new Set(alertsForThis.map(a => categoryOfAlertId(a.id) || '-'))].join(', ');
    const peranUtama = driver ? 'sopir' : (String(label).startsWith('Admin') ? 'admin' : 'admin');
    // v3.282.0 -- tombol rekomendasi "🔕 Matikan notifikasi ini" HANYA utk
    // penerima Admin (bukan Sopir) -- Sopir tidak lolos isAdminOrSuperAdmin()
    // jadi tombolnya tidak akan pernah bisa dipakai kalaupun ditempel (lihat
    // komentar lengkap di buildNotifRekomendasiKeyboard() & handler
    // `notifperan:suggest:`).
    const kbAlertUtama = driver ? null : buildNotifRekomendasiKeyboard(alertsForThis, 'admin');
    try {
      const bodyKirimUtama = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
      if (kbAlertUtama) bodyKirimUtama.reply_markup = { inline_keyboard: kbAlertUtama };
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyKirimUtama)
      });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok || !resBody.ok) {
        log(`❌ Gagal kirim ke ${label} (${chatId}):`, JSON.stringify(resBody));
        pushNotifLog({ nama: label, peran: peranUtama, chatId, kategori: kategoriGabunganUtama, status: 'gagal' });
        gagal++; continue;
      }
      sukses++;
      pushNotifLog({ nama: label, peran: peranUtama, chatId, kategori: kategoriGabunganUtama, status: 'berhasil' });
    } catch (e) {
      log(`❌ Gagal kirim ke ${label} (${chatId}):`, e.message);
      pushNotifLog({ nama: label, peran: peranUtama, chatId, kategori: kategoriGabunganUtama, status: 'gagal' });
      gagal++;
    }
  }

  log(`✅ Terkirim ke ${sukses}/${recipients.size} penerima (${toSend.length} notifikasi baru dari total ${alerts.length} masalah aktif)${dilewati > 0 ? `, ${dilewati} dilewati` : ''}.`);

  await persistState({
    waktu: Date.now(),
    items: toSend.map(a => ({ judul: a.judul, level: a.level })),
    penerimaSukses: sukses,
    penerimaGagal: gagal,
  });

  return { ok: sukses > 0 || recipients.size === 0, sukses, gagal, totalBaru: toSend.length, alertsActive: alerts.length, log: logLines };
}

/* ============================================================================
   Integrasi GPS.id (v3.0 API)
   Butuh 2 Secret baru di Cloudflare -> Worker ini -> Settings -> Variables
   and Secrets (simpan sebagai "Secret"/encrypted, sama seperti GITHUB_TOKEN):
     - GPSID_USERNAME
     - GPSID_PASSWORD
   ============================================================================ */

// Ambil token GPS.id, dengan cache in-memory (hemat 1 login / ~23 jam).
// Variabel scope-module ini bertahan selama Worker "isolate" masih hidup
// (dipakai ulang lintas request), tapi hilang kalau isolate di-restart (cold
// start) -- normal & tidak masalah, begitu cache kosong ia login ulang.
let gpsIdTokenCache = { token: null, expiresAt: 0 };

// v3.150.0 -- Cache respons /vehicle GPS.id (bukan cuma token) + "cooldown"
// bersama kalau GPS.id membalas 429 (rate limit). SEBELUMNYA tiap pemanggil
// (halaman Lacak Kendaraan tiap 30 detik, alur "tiba" di Telegram, cron
// alert kecepatan) masing-masing nembak GPS.id sendiri-sendiri -- kalau
// kebetulan bertumpuk dalam detik yang sama, gampang kena 429. Sekarang
// SEMUA lewat fetchGpsIdVehicleData() di bawah, jadi cuma ada maksimal 1
// request nyata ke GPS.id per GPS_VEHICLE_CACHE_TTL_MS, dan begitu kena 429
// sekali, semua pemanggil ikut "istirahat" sampai cooldown selesai (pakai
// cache lama yang masih ada kalau tersedia, supaya tetap tampil sesuatu
// walau agak basi, daripada makin sering nge-retry dan makin diperpanjang
// oleh GPS.id).
let gpsVehicleCache = { data: null, list: null, fetchedAt: 0 };
let gpsCooldownUntil = 0;
const GPS_VEHICLE_CACHE_TTL_MS = 15000; // 15 detik
const GPS_429_COOLDOWN_MS = 60000; // 60 detik "istirahat" setelah kena 429

async function getGpsIdToken(env) {
  const now = Date.now();
  if (gpsIdTokenCache.token && now < gpsIdTokenCache.expiresAt) {
    return gpsIdTokenCache.token; // masih valid, tidak perlu login lagi
  }

  const username = env.GPSID_USERNAME;
  const password = env.GPSID_PASSWORD;
  if (!username || !password) {
    throw new Error("GPSID_USERNAME / GPSID_PASSWORD belum diatur di Cloudflare Variables.");
  }

  const res = await fetch("https://portal.gps.id/backend/seen/public/login", {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ username, password })
  });

  if (res.status === 429) {
    gpsCooldownUntil = now + GPS_429_COOLDOWN_MS;
    throw new Error("Login GPS.id dibatasi (rate limit) sementara, coba lagi sebentar.");
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.status !== true || !data.message?.data?.token) {
    const pesan = data?.message || `HTTP ${res.status}`;
    throw new Error(`Login GPS.id gagal: ${typeof pesan === "string" ? pesan : JSON.stringify(pesan)}`);
  }

  // Token asli berlaku 24 jam -- cache 23 jam saja (buffer 1 jam) supaya
  // tidak ada risiko dipakai saat sudah kadaluwarsa akibat selisih jam server.
  gpsIdTokenCache = {
    token: data.message.data.token,
    expiresAt: now + 23 * 60 * 60 * 1000
  };
  return gpsIdTokenCache.token;
}

function parseGpsVehicleList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.message?.data)) return data.message.data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.message)) return data.message;
  return null;
}

// Satu-satunya tempat yang benar-benar boleh manggil GET /vehicle ke GPS.id.
// SEMUA fungsi lain (handleGpsIdVehicles, getGpsIdMileageForImei,
// getGpsIdSpeedMap) WAJIB lewat sini, supaya cache & cooldown di atas
// benar-benar dipakai bersama. Return: { data, list, status, error?, stale? }
// ============================================================================
// BARU -- Arsitektur Push Data API GPS.id (v3.193.0). SEBELUMNYA Worker ini
// SELALU "nanya" (polling) ke GPS.id tiap siklus cron -- rawan kena
// rate-limit (429, lihat GPS_429_COOLDOWN_MS) & posisi/kecepatan cuma
// seaktual jadwal cron (biasa tiap beberapa menit). SEKARANG GPS.id yang
// "kirim" (push) posisi tiap unit setiap ~30 detik ke endpoint
// /gpsid/push-data di bawah -- disimpan di Cloudflare KV (BUKAN GitHub,
// GitHub Contents API tidak cocok utk tulis sesering ini).
//
// PENTING -- KENAPA POLLING TIDAK DIHAPUS TOTAL: format JSON Push Data
// GPS.id (lihat handlePushGpsData()) CUMA berisi posisi/kecepatan/odometer
// -- TIDAK ada field expired_gsm/door/battery/owner/dll yang beberapa
// fitur (mis. Reminder Masa Aktif SIM GPS Tracker) butuhkan. Jadi
// arsitekturnya HYBRID: polling /vehicle TETAP jalan (di cadence yang SAMA
// spt sebelumnya, cukup utk data yg jarang berubah), TAPI field
// posisi/kecepatan/odometer/arah-nya ditimpa dgn data push yang lebih
// segar kalau ada & lebih baru -- applyGpsPushOverlay() di bawah.
//
// SETUP MANUAL YANG DIPERLUKAN (tidak bisa diotomatisasi dari sini):
// 1. Buat Cloudflare KV Namespace (dashboard Cloudflare -> Workers & Pages
//    -> KV -> Create), lalu bind ke Worker ini dgn nama variable
//    "GPS_PUSH_KV" (Worker -> Settings -> Bindings -> Add -> KV Namespace).
// 2. Kirim email ke it.ss@gps.id (subjek: Register Endpoint Push Data),
//    sertakan username akun GPS.id & unit yang mau diintegrasikan, DAN
//    alamat endpoint: https://<url-worker-anda>/gpsid/push-data?secret=<NOTIFY_SECRET>
//    (pakai NOTIFY_SECRET yang SAMA dgn yang sudah ada di Variables --
//    tidak perlu bikin secret baru).
// Kalau KV belum di-bind atau belum didaftarkan ke GPS.id, aplikasi TETAP
// jalan normal seperti sebelumnya (full polling) -- fitur ini SEPENUHNYA
// opsional & aman dilewati.
// ============================================================================
const GPS_PUSH_FRESHNESS_MS = 5 * 60 * 1000; // data push lebih tua dari ini dianggap basi, diabaikan (device offline/berhenti push)

// Timpa field posisi/kecepatan/odometer/arah di `list` (hasil polling)
// dengan data PUSH yang lebih segar per imei, kalau ada & tersedia (KV
// binding GPS_PUSH_KV ada) & masih dalam batas kesegaran di atas. Field
// LAIN (owner/expired_gsm/door/battery/dll, yg tidak ada di format push)
// TETAP dari hasil polling apa adanya -- overlay ini TIDAK PERNAH
// menghapus field, cuma menimpa yg lebih baru kalau ada.
async function applyGpsPushOverlay(env, list) {
  if (!list || !env.GPS_PUSH_KV) return list;
  try {
    const keys = await env.GPS_PUSH_KV.list({ prefix: "gps-push:" });
    if (!keys.keys || keys.keys.length === 0) return list;
    const pushMap = {};
    await Promise.all(keys.keys.map(async k => {
      const raw = await env.GPS_PUSH_KV.get(k.name);
      if (!raw) return;
      try {
        const rec = JSON.parse(raw);
        if (rec && rec.imei && (Date.now() - (rec.updatedAt || 0)) < GPS_PUSH_FRESHNESS_MS) pushMap[String(rec.imei)] = rec;
      } catch (e) { /* record korup -- abaikan diam-diam, jangan sampai gagalkan seluruh overlay */ }
    }));
    if (Object.keys(pushMap).length === 0) return list;
    return list.map(v => {
      const imei = String(v.imei ?? v.IMEI ?? "");
      const push = pushMap[imei];
      if (!push) return v;
      return {
        ...v,
        latitude: push.lat, longitude: push.lon, lat: push.lat, lon: push.lon,
        speed: push.speed, angle: push.angle, acc: push.acc,
        mileage: push.mileage != null ? push.mileage : v.mileage,
        last_update: push.lastUpdate || v.last_update,
        _gpsPushSource: true, // penanda internal -- dipakai badge "⚡ Real-time" di index.html
      };
    });
  } catch (e) {
    console.log("applyGpsPushOverlay: gagal baca KV, pakai data polling apa adanya:", e.message);
    return list; // GAGAL DIAM-DIAM -- overlay ini pemanis, bukan sumber data wajib
  }
}

// ----------------------------------------------------------------------------
// BARU -- cache & cooldown /vehicle DIBAGI lintas isolate lewat KV (pakai
// GPS_PUSH_KV yang sama dgn fitur Push Data, kalau sudah di-bind). SEBELUMNYA
// gpsVehicleCache/gpsCooldownUntil di atas cuma variabel in-memory per
// isolate Cloudflare Worker -- kalau ada beberapa isolate aktif bersamaan
// (wajar terjadi saat beberapa popup/tab/halaman minta data GPS.id nyaris
// bersamaan), TIAP isolate menganggap dirinya "yang pertama nanya" dan sama-
// sama menembak GPS.id sendiri-sendiri, jadi lebih gampang kena rate-limit
// (429) daripada seharusnya -- padahal cache 15 detiknya SUDAH ada, cuma
// tidak kebagi ke isolate lain.
//
// Sekarang: cache in-memory tetap jadi jalur TERCEPAT (dicek duluan, tanpa
// KV sama sekali) -- KV cuma disentuh saat cache in-memory kosong/basi
// (biasanya cold start isolate baru). Kalau isolate lain SUDAH menaruh data
// segar / status cooldown di KV, isolate ini ikut memakainya, TIDAK ikut
// menembak GPS.id lagi. Gagal baca/tulis KV (mis. belum di-bind) DIABAIKAN
// DIAM-DIAM -- fallback ke perilaku in-memory lama apa adanya, tidak
// mengubah cara kerja kalau KV belum di-setup.
// ----------------------------------------------------------------------------
const GPS_VEHICLE_KV_CACHE_KEY = "gps-vehicle-cache";
const GPS_VEHICLE_KV_COOLDOWN_KEY = "gps-vehicle-cooldown-until";

// ----------------------------------------------------------------------------
// BARU -- Verifikasi PIN sisi server (lihat komentar di routing /verify-pin
// di atas). Rate-limit sederhana per-IP pakai GPS_PUSH_KV yang sudah ada
// (tidak perlu KV namespace baru): tiap gagal dicatat, kalau sudah 8x gagal
// dalam 15 menit terakhir, IP itu dikunci sementara (tidak dicek PIN-nya
// sama sekali, langsung ditolak) -- supaya brute-force online pun jadi tidak
// praktis. Berhasil sekali -> counter direset.
// ----------------------------------------------------------------------------
const PIN_RATE_LIMIT_MAX_FAILS = 8;
const PIN_RATE_LIMIT_WINDOW_SECONDS = 900; // 15 menit

async function handleVerifyPin(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  if (!env.GPS_PUSH_KV) {
    // Tanpa KV, rate-limit tidak bisa dijaga lintas-request -- daripada
    // diam-diam TANPA proteksi sama sekali, endpoint ini sengaja ditolak
    // total sampai KV di-bind, supaya kesalahan setup langsung ketahuan
    // (bukan celah keamanan yang lolos tanpa disadari).
    return new Response(JSON.stringify({ error: "GPS_PUSH_KV belum di-bind di Worker -- verifikasi PIN butuh ini untuk rate-limit." }), { status: 500, headers: jsonHeaders });
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Body tidak valid." }), { status: 400, headers: jsonHeaders });
  }
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  const context = body.context === "modesopir" ? "modesopir" : "insight";
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const lockKey = `pinlock:${ip}`;

  const lockState = (await readGpsKvJson(env, lockKey)) || { fails: 0 };
  if (lockState.fails >= PIN_RATE_LIMIT_MAX_FAILS) {
    return new Response(JSON.stringify({ error: "Terlalu banyak percobaan salah. Coba lagi dalam beberapa menit." }), { status: 429, headers: jsonHeaders });
  }

  // BARU -- nama secret diganti dari FLEETOPS_MODESOPIR_PIN jadi
  // FLEETOPS_OPERATOR_PIN (SAMA dgn judul modal "🔒 Buka Operator" di
  // index.html, supaya tidak rancu -- sebelumnya nama secret "modesopir"
  // tidak nyambung sama sekali dgn istilah "Operator" yang dilihat pengguna).
  // BARU JUGA -- SEBELUMNYA endpoint ini menolak TOTAL kalau salah satu dari
  // KEDUA secret belum diisi (walau yang mau dites cuma satu level). Sekarang
  // masing-masing level dicek independen -- operatorPin kosong TETAP boleh,
  // context "modesopir" cukup jalan kalau operatorPin ATAU insightPin ada;
  // baru ditolak kalau KEDUA-DUANYA kosong (level manapun jadi tidak mungkin
  // cocok, error DUA-DUANYA supaya jelas mana yg perlu diisi).
  const insightPin = env.FLEETOPS_INSIGHT_PIN || "";
  const operatorPin = env.FLEETOPS_OPERATOR_PIN || "";
  if (!insightPin && !operatorPin) {
    return new Response(JSON.stringify({ error: "FLEETOPS_OPERATOR_PIN / FLEETOPS_INSIGHT_PIN belum diatur di Cloudflare Secrets." }), { status: 500, headers: jsonHeaders });
  }

  let level = null;
  if (context === "insight") {
    if (pin && insightPin && pin === insightPin) level = "super";
  } else {
    if (pin && operatorPin && pin === operatorPin) level = "normal";
    else if (pin && insightPin && pin === insightPin) level = "super";
  }

  if (!level) {
    await writeGpsKvJson(env, lockKey, { fails: (lockState.fails || 0) + 1 }, PIN_RATE_LIMIT_WINDOW_SECONDS);
    return new Response(JSON.stringify({ error: "PIN salah." }), { status: 401, headers: jsonHeaders });
  }

  // Berhasil -> reset counter supaya percobaan gagal sebelumnya (mis. salah
  // ketik) tidak ikut menumpuk ke arah lockout.
  if (lockState.fails > 0) {
    await writeGpsKvJson(env, lockKey, { fails: 0 }, PIN_RATE_LIMIT_WINDOW_SECONDS);
  }
  return new Response(JSON.stringify({ ok: true, level }), { status: 200, headers: jsonHeaders });
}

async function readGpsKvJson(env, key) {
  if (!env.GPS_PUSH_KV) return null;
  try {
    const raw = await env.GPS_PUSH_KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null; // KV belum di-bind / gagal baca -- diabaikan diam-diam
  }
}
async function writeGpsKvJson(env, key, value, ttlSeconds) {
  if (!env.GPS_PUSH_KV) return;
  try {
    await env.GPS_PUSH_KV.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) });
  } catch (e) {
    // gagal tulis KV -- diabaikan diam-diam, cache in-memory lokal tetap jalan
  }
}

async function fetchGpsIdVehicleDataPolled(env) {
  const now = Date.now();

  if (gpsVehicleCache.data && (now - gpsVehicleCache.fetchedAt) < GPS_VEHICLE_CACHE_TTL_MS) {
    return { data: gpsVehicleCache.data, list: gpsVehicleCache.list, status: 200 };
  }

  // Cache in-memory lokal kosong/basi -- cek dulu apakah isolate LAIN sudah
  // menaruh data segar di KV, sebelum memutuskan perlu menembak GPS.id.
  if (env.GPS_PUSH_KV) {
    const kvCached = await readGpsKvJson(env, GPS_VEHICLE_KV_CACHE_KEY);
    if (kvCached && kvCached.fetchedAt && (now - kvCached.fetchedAt) < GPS_VEHICLE_CACHE_TTL_MS) {
      gpsVehicleCache = { data: kvCached.data, list: kvCached.list, fetchedAt: kvCached.fetchedAt };
      return { data: kvCached.data, list: kvCached.list, status: 200 };
    }
  }

  // Cooldown: pakai yang lebih AKHIR antara in-memory lokal & KV (isolate
  // lain mungkin baru saja kena 429 duluan, KV-nya lebih baru dari lokal).
  let effectiveCooldownUntil = gpsCooldownUntil;
  if (env.GPS_PUSH_KV) {
    const kvCooldown = await readGpsKvJson(env, GPS_VEHICLE_KV_COOLDOWN_KEY);
    if (kvCooldown && typeof kvCooldown.until === "number" && kvCooldown.until > effectiveCooldownUntil) {
      effectiveCooldownUntil = kvCooldown.until;
      gpsCooldownUntil = kvCooldown.until; // sinkronkan ke lokal jg, supaya request berikutnya di isolate ini tidak perlu baca KV lagi
    }
  }
  if (now < effectiveCooldownUntil) {
    if (gpsVehicleCache.data) {
      return { data: gpsVehicleCache.data, list: gpsVehicleCache.list, status: 200, stale: true };
    }
    // Belum ada cache lokal sama sekali -- coba pinjam data KV walau sudah
    // agak basi, lebih baik daripada tidak ada apa-apa selama masih cooldown.
    const kvCachedFallback = env.GPS_PUSH_KV ? await readGpsKvJson(env, GPS_VEHICLE_KV_CACHE_KEY) : null;
    if (kvCachedFallback && kvCachedFallback.data) {
      return { data: kvCachedFallback.data, list: kvCachedFallback.list, status: 200, stale: true };
    }
    return { data: null, list: null, status: 429, error: `GPS.id membatasi permintaan (rate limit). Coba lagi sekitar ${Math.ceil((effectiveCooldownUntil - now) / 1000)} detik lagi.` };
  }

  const token = await getGpsIdToken(env); // bisa throw (login gagal/429)

  const gpsRes = await fetch("https://portal.gps.id/backend/seen/public/vehicle", {
    method: "GET",
    headers: { "accept": "application/json", "Authorization": token } // token polos, TANPA prefix "Bearer "
  });

  if (gpsRes.status === 429) {
    gpsCooldownUntil = now + GPS_429_COOLDOWN_MS;
    await writeGpsKvJson(env, GPS_VEHICLE_KV_COOLDOWN_KEY, { until: gpsCooldownUntil }, Math.ceil(GPS_429_COOLDOWN_MS / 1000) + 10);
    if (gpsVehicleCache.data) {
      return { data: gpsVehicleCache.data, list: gpsVehicleCache.list, status: 200, stale: true };
    }
    return { data: null, list: null, status: 429, error: "GPS.id membatasi permintaan (rate limit). Coba lagi sebentar." };
  }

  const data = await gpsRes.json().catch(() => null);
  if (gpsRes.status === 200 && data) {
    const list = parseGpsVehicleList(data);
    gpsVehicleCache = { data, list, fetchedAt: now };
    // Simpan ke KV supaya isolate LAIN yang cold-start sesaat lagi ikut
    // memakai data ini juga, bukan sama-sama menembak GPS.id sendiri-sendiri.
    // TTL sedikit lebih longgar dari TTL cache normal, sekadar jaga-jaga.
    await writeGpsKvJson(env, GPS_VEHICLE_KV_CACHE_KEY, { data, list, fetchedAt: now }, Math.ceil(GPS_VEHICLE_CACHE_TTL_MS / 1000) + 15);
    return { data, list, status: 200 };
  }

  return { data, list: null, status: gpsRes.status };
}

// BARU -- wrapper publik: SEMUA pemanggil lama (getGpsIdSpeedMap,
// getGpsIdMileageForImei, handleGpsIdVehicles, computeAlerts utk simGps,
// dst) TETAP panggil fetchGpsIdVehicleData() SAMA seperti sebelumnya --
// TIDAK ADA satu pun titik panggil lain yang perlu diubah. Hanya di sini
// hasil polling ditimpa data push (kalau ada) sebelum diteruskan.
async function fetchGpsIdVehicleData(env) {
  const result = await fetchGpsIdVehicleDataPolled(env);
  if (result.list) result.list = await applyGpsPushOverlay(env, result.list);
  return result;
}


// v3.144.0 -- Ambil odometer (KM) untuk SATU imei dari GPS.id, dipanggil
// LANGSUNG dari kode Worker sendiri (server-to-server) -- dipakai di alur
// webhook Telegram "tiba" untuk tanya-konfirmasi odometer sebelum minta
// diketik manual. Mengembalikan null (diam-diam) kalau imei kosong, token
// gagal, atau imei tidak ketemu -- SENGAJA tidak melempar error, supaya
// kalau GPS.id sedang bermasalah, alur "tiba" tetap jalan normal (jatuh ke
// tanya manual), tidak memblokir penutupan trip.
// ============================================================================
// BARU -- 3 fungsi helper GPS.id tambahan (endpoint yang sebelumnya belum
// pernah dipakai sama sekali di aplikasi ini): Bagikan Lokasi Sementara,
// Validasi Silang Efisiensi BBM (report/mileage), & Laporan Parkir.
// STATUS: helper-nya sudah siap, TAPI SENGAJA BELUM ada endpoint/route
// HTTP maupun tombol UI yang memanggilnya -- pembahasan fitur GPS.id
// (termasuk mana yang mau dibangun & guardrail keamanannya) masih
// menunggu diskusi terpisah. Jangan panggil fungsi-fungsi ini dari route
// baru sebelum diskusi itu selesai.
// Pola SAMA PERSIS dgn fetchGpsIdVehicleData() di atas -- getGpsIdToken()
// utk auth, GAGAL DIAM-DIAM (return null/error terstruktur, bukan throw
// tak tertangani) supaya fitur GPS.id lain tidak ikut rusak kalau salah
// satu dari 3 ini bermasalah.
// ============================================================================

// POST /share_location/create_share -- hasilkan link pelacakan SEMENTARA
// (kadaluarsa otomatis setelah `expirationMinutes`) utk 1 mobil, dipakai
// tombol "🔗 Bagikan Lokasi ke Pelanggan" di Catat Perjalanan (index.html).
// TIDAK memberi akses aplikasi FleetOps sama sekali -- cuma link peta GPS.id
// bawaan, jadi aman dibagikan ke pelanggan/pihak luar.
async function createGpsIdShareLink(env, imei, expirationMinutes) {
  const token = await getGpsIdToken(env);
  const res = await fetch("https://portal.gps.id/backend/seen/public/share_location/create_share", {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/json", "Authorization": token },
    body: JSON.stringify({ imei: String(imei), expiration: Math.max(5, Math.min(1440, Number(expirationMinutes) || 120)) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && (data.message || data.error)) || `GPS.id menolak permintaan share link (HTTP ${res.status}).`);
  }
  // Dokumentasi GPS.id tidak menjabarkan bentuk pasti responsnya -- coba
  // beberapa kemungkinan field URL yang lazim, fallback ke seluruh body
  // mentah supaya index.html tetap bisa tampilkan sesuatu yang berguna
  // walau nama field-nya ternyata beda dari dugaan.
  const url = data.url || data.link || data?.data?.url || data?.message?.url || null;
  return { raw: data, url, expirationMinutes: Math.max(5, Math.min(1440, Number(expirationMinutes) || 120)) };
}

// GET /report/mileage -- dipakai utk VALIDASI SILANG Efisiensi BBM: GPS.id
// menghitung sendiri estimasi Km/L berdasar jarak GPS + parameter
// `used_fuel` (patokan konsumsi) yang kita kirim, dibandingkan dgn
// Efisiensi BBM yang FleetOps hitung dari catatan odometer+liter manual.
// Kalau selisihnya jauh, kemungkinan ada salah catat (liter/odometer) di
// salah satu sisi -- semangat SAMA dgn "Validasi Silang Liter BBM" yang
// sudah ada, cuma sumber pembandingnya sekarang GPS.id, bukan antar-trip.
async function fetchGpsIdMileageReport(env, imei, startIso, endIso, usedFuelKmL) {
  const token = await getGpsIdToken(env);
  const params = new URLSearchParams({ device: String(imei), start: startIso, end: endIso });
  if (usedFuelKmL != null) params.set("used_fuel", String(usedFuelKmL));
  const res = await fetch(`https://portal.gps.id/backend/seen/public/report/mileage?${params.toString()}`, {
    method: "GET",
    headers: { "accept": "application/json", "Authorization": token },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== true) {
    throw new Error((data && (typeof data.message === "string" ? data.message : JSON.stringify(data.message))) || `HTTP ${res.status}`);
  }
  const rows = (data.message && Array.isArray(data.message.data)) ? data.message.data : [];
  return rows[0] || null; // 1 imei -> ambil baris pertama (kalau ada)
}

// GET /report/parking_report -- daftar titik parkir/diam (durasi antara
// min_time..max_time detik) 1 mobil dalam rentang waktu, dipakai panel
// "🅿️ Laporan Parkir" (index.html) -- insight "di mana mobil ini paling
// sering nganggur", bukan alat pengawasan real-time.
async function fetchGpsIdParkingReport(env, imei, startIso, endIso, minTimeSec, maxTimeSec) {
  const token = await getGpsIdToken(env);
  const params = new URLSearchParams({
    page: "1", per_page: "50", device: String(imei), start: startIso, end: endIso,
    min_time: String(Math.max(0, Number(minTimeSec) || 600)),
    max_time: String(Math.max(0, Number(maxTimeSec) || 86400)),
  });
  const res = await fetch(`https://portal.gps.id/backend/seen/public/report/parking_report?${params.toString()}`, {
    method: "GET",
    headers: { "accept": "application/json", "Authorization": token },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== true) {
    throw new Error((data && (typeof data.message === "string" ? data.message : JSON.stringify(data.message))) || `HTTP ${res.status}`);
  }
  return (data.message && Array.isArray(data.message.data)) ? data.message.data : [];
}

// GET /ref_alert/alert_code_list -- daftar kode alert bawaan GPS.id
// (SOS/rem mendadak/power cut/dst, TERGANTUNG tipe device masing2 unit).
// Dipakai UI pemilihan "watchlist" di index.html (Administrator pilih kode
// mana yang mau diteruskan ke Telegram) -- SENGAJA diambil LANGSUNG dari
// API tiap dibuka (bukan hardcode di kode), karena dokumentasi GPS.id
// tidak menjabarkan daftar kode yang pasti/lengkap.
async function fetchGpsIdAlertCodes(env) {
  const token = await getGpsIdToken(env);
  const res = await fetch("https://portal.gps.id/backend/seen/public/ref_alert/alert_code_list", {
    method: "GET",
    headers: { "accept": "application/json", "Authorization": token },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== true) {
    throw new Error((data && (typeof data.message === "string" ? data.message : JSON.stringify(data.message))) || `HTTP ${res.status}`);
  }
  // Bentuk pasti "message.data" TIDAK dijabarkan di dokumentasi GPS.id
  // (cuma "type: object, properties: {}") -- coba beberapa bentuk lazim,
  // fallback ke objek mentah apa adanya supaya index.html tetap bisa
  // tampilkan sesuatu yang berguna walau bentuknya ternyata beda dugaan.
  const raw = data.message && data.message.data;
  return raw || {};
}

// GET /alert/alert_data -- daftar EVENT alert yang benar2 terjadi utk 1
// imei + 1 kode alert dalam rentang waktu. CATATAN JUJUR: dokumentasi
// GPS.id TIDAK memberi contoh bentuk respons endpoint ini (cuma "200":
// {"description": ""} kosong) -- parsing di bawah defensif/menduga bentuk
// yang lazim (sama seperti endpoint report/history lain). Kalau ternyata
// meleset, gpsAlertRawSample di hasil tes (menu Notifikasi Telegram per
// Peran) akan menunjukkan bentuk aslinya utk disesuaikan.
async function fetchGpsIdAlertData(env, imei, alertNo, startIso, endIso) {
  const token = await getGpsIdToken(env);
  const params = new URLSearchParams({
    page: "1", per_page: "20", device: String(imei), alert_no: String(alertNo), start: startIso, end: endIso,
  });
  const res = await fetch(`https://portal.gps.id/backend/seen/public/alert/alert_data?${params.toString()}`, {
    method: "GET",
    headers: { "accept": "application/json", "Authorization": token },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data && (typeof data.message === "string" ? data.message : JSON.stringify(data.message))) || `HTTP ${res.status}`);
  }
  const list = parseGpsHistoryList(data); // pola parsing sama yg dipakai report/history & vehicle
  return { list: list || [], raw: data };
}

// BARU -- jalankan pengecekan Alert Bawaan GPS.id utk SEMUA mobil ber-IMEI
// x SEMUA kode di watchlist, dorong hasilnya ke `alerts` (array yang SAMA
// dipakai computeAlerts()). Dipanggil TERPISAH (bukan di dalam
// computeAlerts()) karena butuh fetch async berulang ke GPS.id.
// PEMBATASAN SENGAJA: maksimal GPS_ALERT_MAX_CALLS_PER_CYCLE panggilan API
// per siklus cron, supaya watchlist yang kepanjangan x armada besar tidak
// membanjiri GPS.id & memicu rate-limit -- kalau kepotong, sisanya coba
// lagi siklus berikutnya (bukan hilang, cuma tertunda).
const GPS_ALERT_MAX_CALLS_PER_CYCLE = 20;
async function pushGpsAlertsIntoAlerts(env, state, alerts, sinceMs, log) {
  const watchlist = Array.isArray(state.gpsAlertWatchlist) ? state.gpsAlertWatchlist : [];
  if (watchlist.length === 0) return { checkedUntil: Date.now(), skipped: 0 };
  const carsWithGps = state.cars.filter(c => c.imeiGps);
  if (carsWithGps.length === 0) return { checkedUntil: Date.now(), skipped: 0 };

  const nowMs = Date.now();
  const startIso = new Date(sinceMs).toISOString().slice(0, 19).replace('T', ' ');
  const endIso = new Date(nowMs).toISOString().slice(0, 19).replace('T', ' ');

  let calls = 0, skipped = 0;
  for (const car of carsWithGps) {
    for (const w of watchlist) {
      if (calls >= GPS_ALERT_MAX_CALLS_PER_CYCLE) { skipped++; continue; }
      calls++;
      try {
        const { list } = await fetchGpsIdAlertData(env, car.imeiGps, w.code, startIso, endIso);
        list.forEach(item => {
          // Bentuk item defensif -- coba beberapa nama field yg lazim dipakai
          // endpoint GPS.id lain (time/waktu, address/alamat).
          const waktuRaw = item.time || item.waktu || item.datetime || null;
          const waktuMs = waktuRaw ? new Date(String(waktuRaw).replace(' ', 'T') + '+07:00').getTime() : nowMs;
          const alamat = item.address || item.alamat || '';
          alerts.push({
            id: `gpsalert-${car.id}-${w.code}-${waktuMs || nowMs}`,
            ic: '🚨', level: 'danger',
            judul: `Alert GPS.id: ${w.label || ('Kode ' + w.code)}`,
            keterangan: `${carLabel(car.id)}${alamat ? ' — ' + alamat : ''}${waktuRaw ? ' · ' + waktuRaw : ''}`,
            targetDriverIds: [],
          });
        });
      } catch (e) {
        log(`⚠️ Gagal ambil Alert GPS.id (mobil ${car.id}, kode ${w.code}):`, e.message);
      }
    }
  }
  if (skipped > 0) log(`ℹ️ Alert GPS.id: ${skipped} kombinasi mobil×kode dilewati siklus ini (batas ${GPS_ALERT_MAX_CALLS_PER_CYCLE} panggilan/siklus), akan dicoba lagi siklus berikutnya.`);
  return { checkedUntil: nowMs, skipped };
}

// v3.??? -- BARU: helper geo dipakai fitur "Peringatan Rute Menyimpang".
// PORTING PERSIS dari extractLatLng() di index.html (regex sama persis) --
// dibutuhkan salinan server-side krn worker.js tidak punya akses ke
// state/DOM milik client.
function extractLatLngWorker(url) {
  if (!url) return null;
  // v3.265.0 -- prioritaskan pola !3d<lat>!4d<lon> (titik pin asli) sebelum
  // pola umum @lat,lng -- lihat catatan panjang di extractLatLng() index.html.
  const pin = String(url).match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (pin) return { lat: Number(pin[1]), lon: Number(pin[2]) };
  const match = String(url).match(/(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/);
  if (!match) return null;
  return { lat: Number(match[1]), lon: Number(match[2]) };
}
// Jarak garis lurus (meter) antara 2 titik lat/lon -- rumus Haversine
// standar. SENGAJA garis lurus (bukan ikut bentuk jalan) -- lihat catatan
// keterbatasan di computeRouteDeviationFlags() di bawah.
// v3.259.0 -- BARU: unduh bytes foto Telegram (getFile lalu download) --
// SEBELUM ini worker.js TIDAK PERNAH mengunduh isi file dari Telegram sama
// sekali, semua fitur foto lain (nota, barcode MyPertamina) cuma relay
// file_id (lihat catatan panjang di kirimNotaKeFinance()) -- OCR butuh
// bytes gambar asli, bukan cuma referensi, jadi ini yang pertama.
async function downloadTelegramPhotoBytes(env, fileId) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return null;
  try {
    const fileInfoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const fileInfo = await fileInfoRes.json();
    const filePath = fileInfo && fileInfo.result && fileInfo.result.file_path;
    if (!filePath) return null;
    const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
    if (!fileRes.ok) return null;
    return await fileRes.arrayBuffer();
  } catch (e) {
    return null;
  }
}

// v3.259.0 -- BARU: penjaga kuota harian KHUSUS OCR foto struk, pola SAMA
// PERSIS dgn nlpAiBudgetTersedia() (Tingkat 3 NLP ringan, sudah ada sejak
// v3.252.0) -- SENGAJA counter TERPISAH (bukan gabung ke nlpai:budget:...)
// karena model vision (Llama 3.2 11B Vision) jauh lebih besar & makan lebih
// banyak neuron per panggilan dibanding model teks kecil yg dipakai NLP
// fallback (Llama 3.1 8B) -- kalau digabung 1 counter, OCR yg jarang tapi
// mahal bisa diam-diam menghabiskan jatah NLP ringan yg sering tapi murah,
// atau sebaliknya. Default 100x/hari (longgar utk foto struk harian 1
// armada), bisa diubah tanpa deploy ulang lewat Environment Variable
// (BUKAN Secret) `OCR_AI_DAILY_LIMIT` di dashboard Worker.
const OCR_AI_DAILY_LIMIT_DEFAULT = 100;
async function ocrAiBudgetTersedia(env) {
  if (!env.GPS_PUSH_KV) return false; // fail-closed: tanpa KV, OCR dimatikan total demi keamanan biaya (sama pola dgn nlpAiBudgetTersedia)
  const limit = Math.max(1, Number(env.OCR_AI_DAILY_LIMIT) || OCR_AI_DAILY_LIMIT_DEFAULT);
  const tanggalUtc = new Date().toISOString().slice(0, 10); // UTC, sejalan dgn jam reset neuron Cloudflare (00:00 UTC)
  const key = `ocrai:budget:${tanggalUtc}`;
  const budgetState = (await readGpsKvJson(env, key)) || { count: 0 };
  if ((budgetState.count || 0) >= limit) return false;
  await writeGpsKvJson(env, key, { count: (budgetState.count || 0) + 1 }, 172800);
  return true;
}

// v3.259.0 -- BARU: baca nominal (Rp) dari foto struk BBM lewat Cloudflare
// Workers AI (model vision @cf/meta/llama-3.2-11b-vision-instruct) --
// PAKAI BINDING `env.AI` YANG SAMA dengan fitur NLP ringan Tingkat 3 yang
// SUDAH ADA (nlpWorkersAiFallback(), v3.252.0) -- KALAU NLP ringan sudah
// aktif sebelumnya, fitur ini OTOMATIS ikut aktif juga TANPA setup
// tambahan apa pun (binding Workers AI sama, cuma model yang dipanggil
// beda). Kalau binding `env.AI` belum PERNAH diaktifkan sama sekali di
// project ini, baru perlu 1x setup: dasbor Cloudflare -> Worker ini ->
// Settings -> Bindings -> Add -> "Workers AI" -> nama binding persis "AI".
// GRATIS dalam batas wajar (10.000 neuron/hari, direset 00:00 UTC, dibagi
// rata dgn fitur NLP ringan kalau sama-sama dipakai -- lihat
// ocrAiBudgetTersedia() di atas utk penjaga kuota internalnya sendiri).
//
// SENGAJA TIDAK PERNAH langsung mengisi data finansial dari hasil OCR tanpa
// konfirmasi -- lihat step 'sbbm_nominal_ocr_confirm' di
// handleNonTripConvo(), yang SELALU menampilkan angka hasil baca & minta
// sopir konfirmasi/koreksi dulu sebelum benar-benar tersimpan. OCR foto itu
// pada dasarnya tebakan (tulisan buram/silau/struk lecek bisa salah baca),
// jadi harus selalu ada langkah manusia yang memverifikasi.
async function ocrReceiptNominal(env, fileId) {
  if (!env.AI) return null; // binding Workers AI belum diaktifkan -- fail-open
  if (!(await ocrAiBudgetTersedia(env))) return null; // batas harian tercapai (atau KV belum di-bind) -> fail-open, sopir diminta ketik manual
  const bytes = await downloadTelegramPhotoBytes(env, fileId);
  if (!bytes) return null;
  try {
    const response = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      image: Array.from(new Uint8Array(bytes)),
      prompt: 'This is a photo of an Indonesian fuel/gas station receipt (struk SPBU/Pertamina/dll). Find the TOTAL amount paid in Rupiah (the grand total, usually labeled "TOTAL", "JUMLAH", or "TOTAL BAYAR"). Reply with ONLY the number in digits, no currency symbol, no dots, no commas, no other words. If you cannot find a clear total amount, reply with exactly: TIDAK_TERBACA',
      max_tokens: 64,
    });
    // Pola ekstraksi respons SAMA PERSIS dgn nlpWorkersAiFallback() di atas
    // -- format balikan env.AI.run() bisa lewat res.response ATAU
    // res.result.response tergantung model/versi runtime, jadi dicoba
    // keduanya supaya tidak rapuh kalau salah satu formatnya berubah.
    const teks = String((response && (response.response || (response.result && response.result.response))) || '').trim();
    if (!teks || /TIDAK_TERBACA/i.test(teks)) return null;
    const angka = Number(teks.replace(/[^\d]/g, ''));
    // Jaga-jaga: di luar rentang wajar utk 1x isi BBM (mis. salah baca nomor
    // struk/plat/tanggal sbg nominal) -- lebih baik dianggap gagal baca &
    // minta manual, drpd menyodorkan angka yang jelas tidak masuk akal.
    if (!isFinite(angka) || angka <= 0 || angka > 10000000) return null;
    return angka;
  } catch (e) {
    return null; // fail-open -- kegagalan AI apa pun TIDAK BOLEH memblokir alur isi BBM biasa
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// v3.254.0 -- BARU: jarak JALAN SUNGGUHAN (bukan garis lurus) lewat
// OpenRouteService Matrix API -- dipakai KHUSUS memperhalus angka jarak
// yang dilaporkan ke admin di notifikasi Rute Menyimpang, PAS SAAT trip
// itu SUDAH memenuhi syarat utk diberi tahu (streak haversine sudah
// tercapai) -- BUKAN dipanggil tiap siklus cron utk SEMUA trip aktif.
// Alasan kenapa TIDAK dipanggil tiap siklus: cron jalan tiap 5 menit
// (288x/hari) -- kalau 1 saja trip multi-tujuan aktif dipanggilkan ORS
// Matrix tiap siklus, kuota internal FleetOps (100x/hari, SAMA counter dgn
// /optimize-route -- lihat handleOptimizeRoute()) akan habis dalam
// hitungan JAM, bukan hari. Dengan cuma dipanggil di momen "mau kirim
// notifikasi" (yang sendirinya sudah jarang & dibatasi
// routeDeviationCooldownMinutes), kuotanya jauh lebih hemat & tetap akurat
// di titik yang paling penting (angka yang benar-benar dibaca admin).
// Fail-open TOTAL: kalau ORS_API_KEY belum diisi, kuota internal sudah
// habis, atau panggilannya gagal/timeout -- balikin null, pemanggil WAJIB
// fallback ke angka haversine yang sudah ada (lihat computeRouteDeviationFlags()
// di bawah) -- notifikasi TETAP terkirim, cuma labelnya balik jadi "garis
// lurus (estimasi)", bukan pernah gagal terkirim gara-gara ORS bermasalah.
async function orsRoadDistanceMeters(env, lat1, lon1, lat2, lon2) {
  const orsKey = env.ORS_API_KEY;
  if (!orsKey) return null;
  if (env.GPS_PUSH_KV) {
    // Counter kuota SAMA PERSIS dgn /optimize-route ("orsquota:<tanggal>")
    // -- SENGAJA digabung jadi 1 anggaran harian, bukan jatah terpisah,
    // supaya total pemakaian ORS FleetOps (Optimalkan Urutan + penghalus
    // jarak Rute Menyimpang) tetap terjamin jauh di bawah kuota gratis ORS
    // (2.000+/hari) walau kedua fitur dipakai bersamaan.
    const ORS_DAILY_LIMIT = 100;
    const quotaKey = `orsquota:${new Date().toISOString().slice(0, 10)}`;
    try {
      const quotaState = (await readGpsKvJson(env, quotaKey)) || { count: 0 };
      if (quotaState.count >= ORS_DAILY_LIMIT) return null; // kuota internal habis -- fail-open ke haversine
      await writeGpsKvJson(env, quotaKey, { count: quotaState.count + 1 }, 90000);
    } catch (e) { /* fail-open -- gagal baca/tulis kuota tidak boleh menghalangi */ }
  }
  try {
    const res = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': orsKey },
      body: JSON.stringify({ locations: [[lon1, lat1], [lon2, lat2]], sources: [0], destinations: [1], metrics: ['distance'] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data && data.distances && data.distances[0] && data.distances[0][0];
    return typeof d === 'number' ? d : null;
  } catch (e) {
    return null;
  }
}

// ============================================================================
// v3.260.0 -- BARU: "Pola Kunjungan Berulang" -- analisis MINGGUAN (1x/pekan,
// dipicu lewat maybeRunWeeklyPatternAnalysis() di scheduled()) yang
// mendeteksi tempat yang SERING disinggahi mobil tapi TIDAK PERNAH dicatat
// manual (mis. ke masjid, beli makan dekat kantor) dari data GPS.id --
// dipakai memperkuat toleransi gap odometer di buildFuelChain() (index.html)
// supaya perhitungan Rasio/BBM Digunakan makin akurat MAKIN LAMA dipakai
// (belajar dari bukti nyata), bukan cuma angka toleransi tetap yang sama
// utk semua mobil. Lihat SOP bagian 10 utk penjelasan arsitektur lengkap &
// keterbatasan yang disadari sejak awal (bentuk pasti field API GPS.id
// belum terverifikasi lewat data nyata).
// ============================================================================

// Radius (meter) utk menganggap 2 titik berhenti sbg "tempat yang sama" --
// dipakai baik saat mengelompokkan titik DALAM 1 minggu (clusterStopPoints)
// maupun saat menggabungkan hasil minggu ini ke pola minggu-minggu
// sebelumnya (mergeWeeklyPatterns). GPS.id akurasi posisinya ~10-50m,
// 150m dipilih supaya cukup longgar menampung noise itu tapi tetap cukup
// ketat utk tidak menggabung 2 tempat yang sungguhan beda.
const POLA_CLUSTER_RADIUS_METER = 150;
// Minimal kemunculan DALAM 1 MINGGU supaya dianggap "pola berulang" --
// sesuai kesepakatan dgn Administrator (5x/minggu), BUKAN nilai yang bisa
// diubah dari UI (ini ambang deteksi awal, beda dari Toleransi Gap Odometer
// yang memang dibuat bisa diatur admin).
const POLA_MIN_KEMUNCULAN_PER_MINGGU = 5;
// Radius (meter) utk menganggap titik berhenti SUDAH cocok dgn tujuan yang
// SUDAH dicatat manual (Data Tujuan, index.html) -- supaya tidak dobel
// dgn trip yang memang sudah tercatat normal lewat Catat Perjalanan/Booking.
// Lebih longgar dari radius cluster krn titik berhenti GPS vs titik yang
// dicatat manual (dari link Maps) bisa punya offset lebih besar (mis. link
// Maps mengarah ke gerbang gudang, GPS berhenti di area parkir dalam).
const POLA_RADIUS_TUJUAN_TERCATAT_METER = 250;
// Rata-rata bergerak (EWMA) saat menggabungkan pola minggu ini ke riwayat
// pola sebelumnya -- alpha 0.4 berarti tiap minggu baru menyumbang 40% ke
// estimasi, sisanya warisan dari minggu-minggu sebelumnya. Dipilih supaya
// pola cukup CEPAT konvergen (tidak perlu nunggu terlalu banyak minggu utk
// mulai berguna) tapi tidak terlalu goyah kalau 1 minggu kebetulan beda
// (mis. sopir cuti, macet parah, dst).
const POLA_EWMA_ALPHA = 0.4;
// Pola yang SUDAH TIDAK MUNCUL lagi selama ini (minggu) dibuang otomatis --
// kebiasaan sopir/rute mobil bisa berubah, supaya daftar pola tidak
// menumpuk selamanya dgn data yang sudah tidak relevan.
const POLA_KADALUARSA_MINGGU = 8;
// v3.261.0 -- BARU: minggu terkumpul minimal supaya pola dianggap "matang"
// (badge "✅ Terverifikasi" di index.html, DAN pemicu bot Telegram bertanya
// "jadikan Data Tujuan?") -- HARUS SAMA dgn ambang `matang` yang dipakai di
// panel "📍 Pola Kunjungan Berulang" (index.html, cari `mingguTerkumpul||0) >= 3`)
// -- kalau salah satu diubah, ubah juga yang satunya supaya badge & momen
// bot bertanya tetap konsisten (tidak aneh kalau UI sudah bilang
// "Terverifikasi" tapi bot belum pernah nanya, atau sebaliknya).
const POLA_MATANG_MINGGU = 3;

// v3.260.0 -- BARU: kelompokkan titik-titik berhenti (dari 1x panggilan
// fetchGpsIdParkingReport, sebelum digabung ke pola minggu-minggu lalu)
// jadi "tempat" yang sama kalau berdekatan. Parsing field-nya DEFENSIF --
// dokumentasi GPS.id tidak menjabarkan bentuk pasti respons
// /report/parking_report (sama seperti endpoint report lain di file ini,
// lihat catatan jujur di fetchGpsIdAlertData()) -- dicoba beberapa nama
// field yang lazim, titik yang lat/lon-nya tidak bisa diparse (atau
// (0,0), tanda GPS belum fix) dibuang.
function clusterStopPoints(stopsRaw) {
  const points = stopsRaw.map(s => {
    const lat = Number(s.lat ?? s.latitude ?? (s.location && s.location.lat));
    const lon = Number(s.lng ?? s.lon ?? s.longitude ?? (s.location && s.location.lng));
    const durasiDetikRaw = s.duration ?? s.duration_sec ?? s.stop_duration ?? s.time_diff;
    const durasiDetik = Number(durasiDetikRaw);
    // v3.261.0 -- BARU: ikut simpan waktu mulai berhenti (kalau field-nya
    // kebaca) -- dipakai korelasi ke catatan Isi BBM Luar Trip (lihat
    // tandaiKemungkinanSpbu()). SAMA pola "parsing defensif" dgn field lain
    // di sini -- kalau ternyata tidak ada satu pun nama field yang cocok,
    // waktuMulai jadi null & korelasi BBM itu OTOMATIS dilewati utk titik
    // ini (fail-open, tidak menggagalkan clustering/pola-nya sendiri).
    const waktuMulaiRaw = s.start_time ?? s.start ?? s.time ?? s.min_time ?? null;
    const waktuMulaiMs = waktuMulaiRaw ? Date.parse(waktuMulaiRaw) : NaN;
    return { lat, lon, durasiMenit: isFinite(durasiDetik) ? durasiDetik / 60 : null, waktuMulaiMs: isFinite(waktuMulaiMs) ? waktuMulaiMs : null };
  }).filter(p => isFinite(p.lat) && isFinite(p.lon) && !(p.lat === 0 && p.lon === 0));

  const clusters = [];
  points.forEach(p => {
    let target = clusters.find(cl => haversineMeters(cl.lat, cl.lon, p.lat, p.lon) <= POLA_CLUSTER_RADIUS_METER);
    if (!target) { target = { lat: p.lat, lon: p.lon, points: [] }; clusters.push(target); }
    target.points.push(p);
    target.lat = target.points.reduce((a, x) => a + x.lat, 0) / target.points.length;
    target.lon = target.points.reduce((a, x) => a + x.lon, 0) / target.points.length;
  });
  return clusters.map(cl => {
    const durasiVals = cl.points.map(p => p.durasiMenit).filter(v => v != null);
    return {
      lat: cl.lat, lon: cl.lon,
      occurrences: cl.points.length,
      durasiRataRataMenit: durasiVals.length ? durasiVals.reduce((a, b) => a + b, 0) / durasiVals.length : null,
      waktuMulaiMsList: cl.points.map(p => p.waktuMulaiMs).filter(v => v != null),
    };
  });
}

// Ekstraksi lat/lon dari Link Maps (versi worker.js) -- pola regex SAMA
// PERSIS dgn extractLatLng() di index.html (harus disamakan kalau salah
// satunya diubah, keduanya menguraikan format link yang sama).
function extractLatLngFromMapsLinkServerSide(url) {
  if (!url) return null;
  // v3.265.0 -- prioritaskan pola !3d<lat>!4d<lon> (titik pin asli) sebelum
  // pola umum @lat,lng -- lihat catatan panjang di extractLatLng() index.html.
  const pin = String(url).match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (pin) return { lat: Number(pin[1]), lon: Number(pin[2]) };
  const m = String(url).match(/(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  return { lat: Number(m[1]), lon: Number(m[2]) };
}

// v3.260.0 -- BARU: gabungkan hasil analisis minggu INI ke pola yang SUDAH
// tersimpan dari minggu-minggu sebelumnya -- titik yang berdekatan (radius
// SAMA dgn clusterStopPoints) dgn pola lama dianggap KELANJUTAN pola itu
// (rata-rata bergerak diperbarui, BUKAN entri baru); titik yang sungguhan
// baru ditambahkan sbg entri baru dgn mingguTerkumpul=1 (baru dianggap
// "Terverifikasi" di laporan setelah >=3 minggu, lihat index.html).
function mergeWeeklyPatterns(existing, minggunian) {
  const hasil = existing.map(p => ({ ...p })); // salin, jangan mutasi array asli
  minggunian.forEach(baru => {
    let target = hasil.find(p => haversineMeters(p.lat, p.lon, baru.lat, baru.lon) <= POLA_CLUSTER_RADIUS_METER);
    if (!target) {
      hasil.push({
        id: 'POLA-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        lat: baru.lat, lon: baru.lon,
        kemunculanPerMinggu: baru.kemunculanMingguIni,
        jarakRataRataKm: baru.jarakRataRataKm,
        durasiRataRataMenit: baru.durasiRataRataMenit,
        kemungkinanSpbu: !!baru.kemungkinanSpbu,
        mingguTerkumpul: 1,
        firstSeenAt: Date.now(), lastSeenAt: Date.now(),
      });
      return;
    }
    target.kemunculanPerMinggu = POLA_EWMA_ALPHA * baru.kemunculanMingguIni + (1 - POLA_EWMA_ALPHA) * (target.kemunculanPerMinggu || baru.kemunculanMingguIni);
    if (baru.jarakRataRataKm != null) {
      target.jarakRataRataKm = (target.jarakRataRataKm == null) ? baru.jarakRataRataKm : (POLA_EWMA_ALPHA * baru.jarakRataRataKm + (1 - POLA_EWMA_ALPHA) * target.jarakRataRataKm);
    }
    if (baru.durasiRataRataMenit != null) {
      target.durasiRataRataMenit = (target.durasiRataRataMenit == null) ? baru.durasiRataRataMenit : (POLA_EWMA_ALPHA * baru.durasiRataRataMenit + (1 - POLA_EWMA_ALPHA) * target.durasiRataRataMenit);
    }
    // v3.261.0 -- BARU (#5): "kemungkinan SPBU" itu STICKY (sekali kena
    // korelasi waktu dgn catatan Isi BBM Luar Trip, tetap ditandai
    // seterusnya) -- bukti positif 1x sudah cukup meyakinkan, TIDAK
    // berkurang keyakinannya cuma krn minggu lain kebetulan tidak ada
    // korelasi (mis. mobil isi BBM di tempat lain minggu itu).
    target.kemungkinanSpbu = !!target.kemungkinanSpbu || !!baru.kemungkinanSpbu;
    target.mingguTerkumpul = (target.mingguTerkumpul || 0) + 1;
    target.lastSeenAt = Date.now();
    // Titik lat/lon centroid ikut digeser dikit ke rata-rata terbaru juga --
    // makin lama makin presisi, bukan cuma dipatok di minggu pertama.
    target.lat = (target.lat + baru.lat) / 2;
    target.lon = (target.lon + baru.lon) / 2;
  });
  const kadaluarsaMs = POLA_KADALUARSA_MINGGU * 7 * 86400000;
  return hasil.filter(p => (Date.now() - (p.lastSeenAt || 0)) < kadaluarsaMs);
}

// v3.261.0 -- BARU (#5): tandai kemungkinan pola ini sbg SPBU langganan --
// kalau ADA kejadian berhenti (dari titik-titik minggu ini) yang waktunya
// berdekatan (+-90 menit) dgn catatan "Isi BBM Luar Trip" mobil yang sama.
// SENGAJA cuma sinyal TAMBAHAN di laporan (bukan menentukan lolos/tidaknya
// kandidat pola) -- korelasi waktu bukan bukti mutlak (bisa kebetulan
// bersamaan sopir mampir tempat lain juga), makanya cuma badge info di UI,
// TIDAK mengubah cara pola dihitung/disaring.
const POLA_SPBU_TOLERANSI_MENIT = 90;
function kemungkinanSpbuDariWaktu(waktuMulaiMsList, isiBbmRecords) {
  if (!waktuMulaiMsList || !waktuMulaiMsList.length || !isiBbmRecords || !isiBbmRecords.length) return false;
  const isiBbmMs = isiBbmRecords
    .map(u => Date.parse(`${u.tglKeluar}T${(u.jamKeluar || '00:00')}:00+07:00`))
    .filter(ms => isFinite(ms));
  if (!isiBbmMs.length) return false;
  const toleransiMs = POLA_SPBU_TOLERANSI_MENIT * 60000;
  return waktuMulaiMsList.some(stopMs => isiBbmMs.some(bbmMs => Math.abs(stopMs - bbmMs) <= toleransiMs));
}

// v3.260.0 -- BARU: inti analisis mingguan -- per mobil ber-GPS.id, tarik
// titik berhenti 7 hari terakhir, kelompokkan, saring yg sudah cocok Data
// Tujuan tercatat, filter yg muncul >=5x/minggu, estimasi jarak
// pulang-pergi lewat ORS (fail-open ke null kalau ORS gagal/kuota habis --
// pola TETAP disimpan tanpa angka jarak drpd batal semua), lalu gabung ke
// riwayat pola tersimpan. SENGAJA per-mobil dibungkus try/catch sendiri --
// 1 mobil gagal (mis. GPS.id timeout) tidak boleh menggagalkan analisis
// mobil lain dalam siklus mingguan yang sama.
async function runWeeklyPatternAnalysis(env) {
  const DATA_PATH = env.FLEETOPS_DATA_PATH || 'data/fleetops-data.json';
  let dataRead;
  try {
    dataRead = await ghReadJson(env, DATA_PATH);
  } catch (e) {
    console.log('weeklyPattern: gagal baca data utama:', e.message);
    return;
  }
  if (!dataRead.exists) return;
  const state = dataRead.json.data || {};
  const cars = (state.cars || []).filter(c => c.imeiGps);
  if (!cars.length) { console.log('weeklyPattern: tidak ada mobil ber-GPS.id, dilewati.'); return; }

  const destinasiTerdaftar = (state.destinations || [])
    .map(d => { const koor = extractLatLngFromMapsLinkServerSide(d.mapsLink); return koor ? { ...koor, nama: d.nama } : null; })
    .filter(Boolean);

  const endIso = new Date().toISOString();
  const startIso = new Date(Date.now() - 7 * 86400000).toISOString();

  const updatesByCarId = {};
  for (const car of cars) {
    try {
      const stopsRaw = await fetchGpsIdParkingReport(env, car.imeiGps, startIso, endIso, 600, 86400);
      if (!Array.isArray(stopsRaw) || !stopsRaw.length) continue;
      const clusters = clusterStopPoints(stopsRaw);
      const kandidat = clusters.filter(cl => {
        if (cl.occurrences < POLA_MIN_KEMUNCULAN_PER_MINGGU) return false;
        const cocokTujuanTercatat = destinasiTerdaftar.some(d => haversineMeters(cl.lat, cl.lon, d.lat, d.lon) <= POLA_RADIUS_TUJUAN_TERCATAT_METER);
        return !cocokTujuanTercatat;
      });
      if (!kandidat.length) continue;
      // v3.261.0 -- BARU (#5): catatan "Isi BBM Luar Trip" mobil ini minggu
      // ini -- dipakai korelasi waktu ke titik berhenti (lihat
      // kemungkinanSpbuDariWaktu() di bawah).
      const isiBbmMobilIni = (state.usage || []).filter(u => u.carId === car.id && u.jenisPenggunaan === 'isi-bbm-saja');
      // Titik paling sering disinggahi minggu ini dianggap "basis/pangkalan"
      // mobil itu (proxi lokasi berangkat, krn kita tidak punya akses
      // odometer per-titik-waktu) -- jarak pola LAIN dihitung PP dari titik
      // ini. Kalau kandidat KEBETULAN adalah basis itu sendiri (mis. mobil
      // memang paling sering "berhenti" di pool sendiri lalu jalan-jalan
      // pendek di sekitarnya), jarak dilewati (null) drpd menghasilkan 0
      // yang menyesatkan.
      const titikBasis = clusters.reduce((a, b) => (a.occurrences >= b.occurrences ? a : b));
      for (const cl of kandidat) {
        let jarakRataRataKm = null;
        if (haversineMeters(cl.lat, cl.lon, titikBasis.lat, titikBasis.lon) > POLA_CLUSTER_RADIUS_METER) {
          const meter = await orsRoadDistanceMeters(env, titikBasis.lat, titikBasis.lon, cl.lat, cl.lon);
          if (meter != null) jarakRataRataKm = (meter * 2) / 1000; // x2 = pulang-pergi
        }
        (updatesByCarId[car.id] = updatesByCarId[car.id] || []).push({
          lat: cl.lat, lon: cl.lon, kemunculanMingguIni: cl.occurrences,
          durasiRataRataMenit: cl.durasiRataRataMenit, jarakRataRataKm,
          kemungkinanSpbu: kemungkinanSpbuDariWaktu(cl.waktuMulaiMsList, isiBbmMobilIni),
        });
      }
    } catch (e) {
      console.log(`weeklyPattern: gagal analisis mobil ${car.id} (${car.plat || '-'}):`, e.message);
    }
  }
  if (!Object.keys(updatesByCarId).length) { console.log('weeklyPattern: tidak ada pola baru terdeteksi minggu ini.'); return; }

  // v3.261.0 -- BARU: kumpulkan pola yang BARU SAJA matang (mingguTerkumpul
  // baru menyentuh POLA_MATANG_MINGGU minggu ini, belum pernah ditanyakan)
  // -- direset di AWAL tiap kali mutator ini dipanggil (bisa dipanggil >1x
  // kalau pushMainDataUpdate retry krn konflik tulis) supaya cuma hasil
  // dari percobaan TERAKHIR yang dipakai, bukan menumpuk dari percobaan
  // gagal sebelumnya.
  let baruMatangList = [];
  const hasilSimpan = await pushMainDataUpdate(env, DATA_PATH, (freshRaw) => {
    baruMatangList = [];
    const carsArr = freshRaw.data.cars || [];
    freshRaw.data.recurringStopPatterns = freshRaw.data.recurringStopPatterns || {};
    for (const carId of Object.keys(updatesByCarId)) {
      if (!carsArr.some(c => c.id === carId)) continue; // mobil sudah dihapus di antara baca & tulis, skip
      const existing = Array.isArray(freshRaw.data.recurringStopPatterns[carId]) ? freshRaw.data.recurringStopPatterns[carId] : [];
      const mingguSebelumById = new Map(existing.map(p => [p.id, p.mingguTerkumpul || 0]));
      const merged = mergeWeeklyPatterns(existing, updatesByCarId[carId]);
      merged.forEach(p => {
        const mingguSebelum = mingguSebelumById.has(p.id) ? mingguSebelumById.get(p.id) : 0;
        if ((p.mingguTerkumpul || 0) >= POLA_MATANG_MINGGU && mingguSebelum < POLA_MATANG_MINGGU && !p.sudahDitanyakanTujuan) {
          baruMatangList.push({ carId, patternId: p.id });
        }
      });
      freshRaw.data.recurringStopPatterns[carId] = merged;
    }
    return true;
  });
  console.log('weeklyPattern: selesai, hasil simpan:', JSON.stringify(hasilSimpan), '- pola baru matang:', baruMatangList.length);

  if (hasilSimpan.ok && baruMatangList.length) {
    await kirimPertanyaanJadikanTujuan(env, baruMatangList);
  }
}

// v3.261.0 -- BARU: kirim pesan Telegram sederhana dari LUAR
// processTelegramUpdate() (dipakai runWeeklyPatternAnalysis(), dipicu cron
// mingguan, bukan dari webhook chat) -- fungsi sendTg() yang sudah ada itu
// terkurung nested di dalam processTelegramUpdate()/runNotifyCheck(),
// TIDAK bisa dipanggil dari sini. Versi minimal ini SENGAJA tanpa
// dedup/anti-spam kompleks (pola sendTgUnique() dkk) -- pemakaiannya di
// sini terbatas & jarang (1x/minggu, maks beberapa pesan per siklus).
async function sendTgSimple(env, chatId, text, keyboard) {
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log(`weeklyPattern: gagal kirim pesan ke ${chatId}:`, e.message);
  }
}

// v3.261.0 -- BARU: kirim pertanyaan "jadikan Data Tujuan?" ke admin utk
// tiap pola yang BARU SAJA matang minggu ini (lihat baruMatangList di
// runWeeklyPatternAnalysis()). Dijaga toggle Pengaturan -> "📍 Pola
// Kunjungan Berulang" -> "🤖 Tanya otomatis lewat bot Telegram"
// (state.notifSettings.polaKunjunganTanyaEnabled, default AKTIF, BISA
// DIMATIKAN kalau terasa spam -- permintaan eksplisit Administrator).
// Penerima: ADMIN_CHAT_IDS (Secret TELEGRAM_CHAT_ID) -- SAMA dgn baseline
// penerima alert admin-only lain di proyek ini (mis. Rute Menyimpang).
async function kirimPertanyaanJadikanTujuan(env, baruMatangList) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  const DATA_PATH = env.FLEETOPS_DATA_PATH || 'data/fleetops-data.json';
  let dataRead;
  try {
    dataRead = await ghReadJson(env, DATA_PATH);
  } catch (e) {
    console.log('kirimPertanyaanJadikanTujuan: gagal baca data:', e.message);
    return;
  }
  if (!dataRead.exists) return;
  const state = dataRead.json.data || {};
  if (state.notifSettings && state.notifSettings.polaKunjunganTanyaEnabled === false) {
    console.log('kirimPertanyaanJadikanTujuan: dimatikan lewat Pengaturan, dilewati.');
    return;
  }
  const ADMIN_CHAT_IDS = (env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ADMIN_CHAT_IDS.length) return;
  for (const { carId, patternId } of baruMatangList) {
    const car = (state.cars || []).find(c => c.id === carId);
    const patterns = (state.recurringStopPatterns && state.recurringStopPatterns[carId]) || [];
    const p = patterns.find(x => x.id === patternId);
    if (!car || !p) continue;
    const carTxt = `${car.merk || ''} ${car.modelMobil || ''} — ${car.plat || ''}`.trim();
    const baris = [
      `📍 <b>Pola kunjungan baru terverifikasi!</b>`,
      ``,
      `🚗 ${carTxt}`,
      `Muncul konsisten ~${(p.kemunculanPerMinggu || 0).toLocaleString('id-ID', { maximumFractionDigits: 1 })}x/minggu selama ${p.mingguTerkumpul} minggu berturut-turut${p.jarakRataRataKm != null ? `, ±${p.jarakRataRataKm.toFixed(1)} KM/kunjungan` : ''}.`,
    ];
    if (p.kemungkinanSpbu) baris.push(`⛽ Kemungkinan SPBU langganan (waktunya berdekatan dengan catatan Isi BBM Luar Trip).`);
    baris.push(``, `Mau dijadikan Data Tujuan resmi? Ke depannya trip ke sini bisa mulai dicatat manual seperti biasa.`);
    const teks = baris.join('\n');
    for (const adminId of ADMIN_CHAT_IDS) {
      await sendTgSimple(env, adminId, teks, [[
        { text: '✅ Ya, jadikan tujuan', callback_data: `polatjn:ya:${carId}:${patternId}` },
        { text: '❌ Tidak', callback_data: `polatjn:tdk:${carId}:${patternId}` },
      ]]);
    }
  }
}

// v3.260.0 -- BARU: kunci "sudah jalan minggu ini" (ISO week, format
// "YYYY-Www") -- cron tick tiap 5 menit, tapi analisis ini cuma boleh
// benar2 jalan 1x/minggu (sesuai kesepakatan dgn Administrator) supaya
// tidak boros panggilan GPS.id/ORS. Dijadwalkan Senin dini hari (jendela
// jam 02:00 WIB, ~12x tick cron) -- di luar jam sibuk, data minggu
// sebelumnya (Senin-Minggu) sudah lengkap.
function getIsoWeekKey(d) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}
async function maybeRunWeeklyPatternAnalysis(env) {
  try {
    if (!env.GPS_PUSH_KV) return; // tanpa KV tidak bisa menjaga "sudah jalan minggu ini" dgn aman, jangan jalan sama sekali drpd berulang tiap 5 menit
    const nowWib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    if (!(nowWib.getDay() === 1 && nowWib.getHours() === 2)) return; // Senin, jam 02:xx WIB
    const guardKey = `weeklypattern:ran:${getIsoWeekKey(nowWib)}`;
    const sudahJalan = await readGpsKvJson(env, guardKey);
    if (sudahJalan) return;
    await writeGpsKvJson(env, guardKey, { ranAt: Date.now() }, 8 * 86400); // TTL 8 hari, cukup lewat 1 minggu
    await runWeeklyPatternAnalysis(env);
  } catch (e) {
    console.log('scheduled: maybeRunWeeklyPatternAnalysis gagal (diabaikan, fail-open):', e && e.message);
  }
}

// v3.??? -- BARU: "Peringatan Rute Menyimpang". Untuk tiap trip AKTIF yang
// punya >1 tujuan (Tujuan Tambahan), bandingkan jarak lurus posisi GPS.id
// mobil SEKARANG ke titik tujuan BERIKUTNYA (yg belum ditandai "sampai")
// dengan jarak yang tercatat siklus cron SEBELUMNYA (histori kecil per-trip
// disimpan di GPS_PUSH_KV, pola SAMA dgn rate-limit PIN/kuota ORS). Kalau
// jaraknya KONSISTEN membesar (bukan mendekat/stagnan) beberapa siklus
// berturut-turut (routeDeviationMinCyclesStreak), baru dianggap sinyal
// cukup kuat -> trip itu di-flag utk diberi notifikasi ringan ke admin.
// SENGAJA fail-open total di semua titik (KV tidak di-bind / IMEI kosong /
// tujuan belum ada koordinat tersimpan -> trip itu dilewati diam-diam) --
// ini fitur informasi tambahan, BUKAN validasi yg boleh memblokir apa pun.
// KETERBATASAN yg perlu disadari: ini jarak GARIS LURUS (bukan mengikuti
// bentuk jalan sungguhan spt Optimalkan Urutan/ORS Directions) -- jadi ada
// margin toleransi wajar lewat threshold jarak+streak di atas, bukan
// deteksi presisi tinggi.
const ROUTE_DEVIATION_KV_PREFIX = 'routedev-track:';
async function computeRouteDeviationFlags(env, state, gpsVehicleList, ns) {
  const flagged = [];
  if (!env.GPS_PUSH_KV || !Array.isArray(gpsVehicleList)) return flagged;
  const minStreak = Math.max(1, Number(ns.routeDeviationMinCyclesStreak) || 3);
  const minIncreaseMeters = Math.max(1, Number(ns.routeDeviationMinIncreaseMeters) || 200);

  const findDestMapsLink = (nama) => {
    if (!nama) return null;
    const needle = nama.trim().toLowerCase();
    const d = (state.destinations || []).find(x => (x.nama || '').trim().toLowerCase() === needle);
    return d ? d.mapsLink : null;
  };

  for (const trip of state.usage) {
    if (trip.status !== 'digunakan') continue;
    const totalTujuan = 1 + (Array.isArray(trip.tujuanTambahan) ? trip.tujuanTambahan.length : 0);
    if (totalTujuan <= 1) continue; // cuma relevan utk trip multi-tujuan -- trip 1-tujuan tidak ada "urutan" utk disimpang
    const selesaiCount = Object.keys(trip.tujuanSelesaiAt || {}).length;
    const nextNumber = selesaiCount + 1;
    if (nextNumber > totalTujuan) continue; // semua tujuan sudah ditandai "sampai"
    const namaTujuanBerikutnya = nextNumber === 1 ? trip.tujuan : (Array.isArray(trip.tujuanTambahan) ? trip.tujuanTambahan[nextNumber - 2] : null);
    if (!namaTujuanBerikutnya) continue;

    const car = state.cars.find(c => c.id === trip.carId);
    if (!car || !car.imeiGps) continue; // cuma jalan utk mobil yg IMEI GPS.id-nya terhubung

    const v = gpsVehicleList.find(x => String(x.imei ?? x.IMEI ?? '') === String(car.imeiGps));
    const carLat = v ? Number(v.latitude ?? v.lat) : NaN;
    const carLon = v ? Number(v.longitude ?? v.lon) : NaN;
    if (isNaN(carLat) || isNaN(carLon)) continue;

    // Tujuan pertama boleh pakai mapsLink utama trip (kalau ada); tujuan
    // ke-2+ tidak tersimpan per-titik di trip, jadi dicari di Data Tujuan --
    // SAMA PERSIS caranya dgn tombol "Optimalkan Urutan" di index.html.
    const mapsLink = (nextNumber === 1 && trip.mapsLink) ? trip.mapsLink : findDestMapsLink(namaTujuanBerikutnya);
    const koor = extractLatLngWorker(mapsLink);
    if (!koor) continue; // belum ada koordinat tersimpan utk tujuan ini -> lewati diam-diam (bukan diblokir)

    const jarakSekarang = haversineMeters(carLat, carLon, koor.lat, koor.lon);
    const kvKey = ROUTE_DEVIATION_KV_PREFIX + trip.id;
    let prev = null;
    try { prev = await readGpsKvJson(env, kvKey); } catch (e) { prev = null; }

    let streak = 0;
    if (prev && prev.tujuanNomor === nextNumber && typeof prev.jarakMeter === 'number') {
      // Tujuan berikutnya masih SAMA dgn siklus cron sebelumnya -> valid
      // dibandingkan trennya. Kalau tujuan berikutnya berubah (baru saja
      // ditandai "sampai" ke titik lama), histori lama otomatis tidak
      // dipakai (streak mulai dari 0 lagi) supaya tidak salah bandingkan.
      if (jarakSekarang > prev.jarakMeter + minIncreaseMeters) {
        streak = (prev.streak || 0) + 1;
      } else {
        streak = 0; // mendekat/stagnan (mis. sedang istirahat) -> reset, harus menjauh BERTURUT-TURUT
      }
    }
    try {
      await writeGpsKvJson(env, kvKey, { tujuanNomor: nextNumber, jarakMeter: jarakSekarang, streak, updatedAt: Date.now() }, 21600); // TTL 6 jam -- otomatis "lupa" sendiri kalau trip lama tidak dicek lagi
    } catch (e) { /* fail-open -- gagal simpan histori tidak boleh menghentikan pengecekan trip lain */ }

    if (streak >= minStreak) {
      // v3.254.0 -- BARU: di titik INI (bukan tiap siklus cron) baru dicoba
      // penghalus jarak lewat ORS Matrix (lihat orsRoadDistanceMeters()) --
      // fail-open ke angka haversine (garis lurus) yang sudah dihitung di
      // atas kalau ORS tidak bisa dipakai apa pun sebabnya. jarakSumber
      // dibawa serta supaya pesan notifikasinya jujur soal jenis angka yang
      // ditampilkan (lihat pemakaian f.jarakSumber di computeAlerts()).
      let jarakDilaporkan = Math.round(jarakSekarang);
      let jarakSumber = 'garis-lurus';
      const jarakJalan = await orsRoadDistanceMeters(env, carLat, carLon, koor.lat, koor.lon);
      if (jarakJalan != null) { jarakDilaporkan = Math.round(jarakJalan); jarakSumber = 'jalan'; }
      flagged.push({ tripId: trip.id, carId: trip.carId, namaTujuanBerikutnya, jarakMeter: jarakDilaporkan, jarakSumber, streak });
    }
  }
  return flagged;
}

// v3.229.0 -- BARU: "Auto-deteksi Sampai" (idea #1) -- perluasan alami dari
// infrastruktur "Peringatan Rute Menyimpang" di atas (posisi GPS.id live +
// koordinat tujuan tersimpan SUDAH dihitung di situ, di sini cuma dipakai
// dgn kondisi KEBALIKANNYA: bukan "menjauh terus", tapi "sudah DEKAT & Nampak
// berhenti"). Kalau mobil trip multi-tujuan masuk radius kecil dari tujuan
// BERIKUTNYA (yg belum ditandai "sampai") DAN kecepatan GPS.id-nya rendah
// (nampak berhenti, bukan cuma lewat), bot Telegram PROAKTIF kirim
// konfirmasi ke SOPIR (bukan admin -- beda dari Rute Menyimpang) dgn tombol
// Ya/Tidak. Tombol "Ya" pakai callback_data SAMA PERSIS dgn perintah manual
// "sampai <nomor>" (lihat "sampai:" di processTelegramUpdate) -- supaya
// TIDAK PERLU logika penandaan baru sama sekali, cukup pakai yg sudah ada &
// sudah teruji. Ditanya CUMA SEKALI per titik tujuan (KV terpisah dari
// tracking Rute Menyimpang) -- kalau sopir jawab "Tidak"/diam, tidak
// diulang-ulang tiap siklus cron, supaya tidak berisik/spam.
const GEOFENCE_ARRIVAL_KV_PREFIX = 'geoarrival-asked:';
async function computeGeofenceArrivalCandidates(env, state, gpsVehicleList, ns) {
  const candidates = [];
  if (!env.GPS_PUSH_KV || !Array.isArray(gpsVehicleList)) return candidates;
  if (ns.geofenceArrivalEnabled === false) return candidates; // default AKTIF, bisa dimatikan lewat Pengaturan
  const radiusMeters = Math.max(50, Number(ns.geofenceArrivalRadiusMeters) || 300);
  const maxSpeedKmh = Math.max(1, Number(ns.geofenceArrivalMaxSpeedKmh) || 5); // GPS.id speed <= ini dianggap "berhenti"

  const findDestMapsLink = (nama) => {
    if (!nama) return null;
    const needle = nama.trim().toLowerCase();
    const d = (state.destinations || []).find(x => (x.nama || '').trim().toLowerCase() === needle);
    return d ? d.mapsLink : null;
  };

  for (const trip of state.usage) {
    if (trip.status !== 'digunakan') continue;
    const totalTujuan = 1 + (Array.isArray(trip.tujuanTambahan) ? trip.tujuanTambahan.length : 0);
    if (totalTujuan <= 1) continue; // sama spt Rute Menyimpang -- cuma relevan utk trip multi-tujuan
    const selesaiCount = Object.keys(trip.tujuanSelesaiAt || {}).length;
    const nextNumber = selesaiCount + 1;
    if (nextNumber > totalTujuan) continue; // semua tujuan sudah ditandai "sampai"
    const namaTujuanBerikutnya = nextNumber === 1 ? trip.tujuan : (Array.isArray(trip.tujuanTambahan) ? trip.tujuanTambahan[nextNumber - 2] : null);
    if (!namaTujuanBerikutnya) continue;

    const driver = state.drivers.find(d => d.id === trip.driverId);
    if (!driver || !driver.telegramChatId) continue; // tidak ada chat tujuan utk konfirmasi -> lewati diam-diam

    const car = state.cars.find(c => c.id === trip.carId);
    if (!car || !car.imeiGps) continue;
    const v = gpsVehicleList.find(x => String(x.imei ?? x.IMEI ?? '') === String(car.imeiGps));
    const carLat = v ? Number(v.latitude ?? v.lat) : NaN;
    const carLon = v ? Number(v.longitude ?? v.lon) : NaN;
    const speedKmh = v ? Number(v.speed) : NaN;
    if (isNaN(carLat) || isNaN(carLon)) continue;

    const mapsLink = (nextNumber === 1 && trip.mapsLink) ? trip.mapsLink : findDestMapsLink(namaTujuanBerikutnya);
    const koor = extractLatLngWorker(mapsLink);
    if (!koor) continue; // belum ada koordinat tersimpan -> lewati diam-diam

    const jarakMeter = haversineMeters(carLat, carLon, koor.lat, koor.lon);
    if (jarakMeter > radiusMeters) continue; // masih jauh
    if (!isNaN(speedKmh) && speedKmh > maxSpeedKmh) continue; // masih bergerak -- kemungkinan cuma lewat dekat tujuan, bukan berhenti di situ

    const kvKey = GEOFENCE_ARRIVAL_KV_PREFIX + trip.id + ':' + nextNumber;
    let sudahDitanya = null;
    try { sudahDitanya = await readGpsKvJson(env, kvKey); } catch (e) { sudahDitanya = null; }
    if (sudahDitanya) continue; // sudah pernah ditanya utk titik tujuan ini -- jangan ulang, biar sopir yg jawab/ketik manual

    try { await writeGpsKvJson(env, kvKey, { at: Date.now() }, 21600); } catch (e) { /* fail-open -- gagal simpan penanda tidak boleh menghentikan cron */ }
    candidates.push({ tripId: trip.id, chatId: driver.telegramChatId, namaTujuanBerikutnya, nomorTujuan: nextNumber, jarakMeter: Math.round(jarakMeter) });
  }
  return candidates;
}

async function getGpsIdMileageForImei(env, imei) {
  if (!imei) return null;
  try {
    const result = await fetchGpsIdVehicleData(env);
    if (!result.list) return null;
    const v = result.list.find(x => String(x.imei ?? x.IMEI ?? '') === String(imei));
    if (!v || v.mileage == null) return null;
    const m = Number(v.mileage);
    if (isNaN(m)) return null;
    return Math.round(m / 1000); // asumsi field "mileage" GPS.id dalam meter
  } catch (e) {
    console.log('getGpsIdMileageForImei: gagal ambil odometer GPS.id:', e.message);
    return null;
  }
}

// v3.147.0 -- Ambil kecepatan (km/j) SEMUA kendaraan sekaligus dari GPS.id,
// dipanggil LANGSUNG dari runNotifyCheck() (server-to-server) untuk fitur
// "Alert Kecepatan Berlebih". Mengembalikan map { imei: kecepatan } --
// mengembalikan {} (diam-diam) kalau IMEI kosong/token gagal/API bermasalah
// -- SENGAJA tidak melempar error, supaya kalau GPS.id sedang bermasalah,
// pengecekan notifikasi lain (dokumen, servis, BBM, dst) tetap jalan
// normal, cuma alert kecepatan yang dilewati.
async function getGpsIdSpeedMap(env) {
  try {
    const result = await fetchGpsIdVehicleData(env);
    if (!result.list) return {};
    const map = {};
    result.list.forEach(v => {
      const imei = v.imei ?? v.IMEI ?? null;
      const speed = v.speed ?? v.kecepatan ?? null;
      if (imei != null && speed != null && !isNaN(Number(speed))) {
        map[String(imei)] = Number(speed);
      }
    });
    return map;
  } catch (e) {
    console.log('getGpsIdSpeedMap: gagal ambil data kecepatan GPS.id:', e.message);
    return {};
  }
}

// ----------------------------------------------------------------------------
// v3.??? -- Reverse geocoding: koordinat GPS.id -> alamat lengkap yang bisa
// dibaca manusia. Dipakai fitur BARU "lokasi" di bot Telegram. Pakai
// OpenStreetMap Nominatim (GRATIS, tidak perlu API key -- tidak ada key
// Google Maps yang dikonfigurasi di aplikasi ini) sesuai kebijakan
// pemakaian wajarnya (maks ~1 permintaan/detik, wajib kirim User-Agent
// yang jelas). SENGAJA best-effort & TIDAK PERNAH melempar error ke
// pemanggil -- kalau Nominatim lambat/gagal/limit, fitur "lokasi" tetap
// jalan tanpa baris alamat (link Google Maps + koordinat mentah tetap ada).
// ----------------------------------------------------------------------------
async function reverseGeocodeLatLon(lat, lon) {
  try {
    const params = new URLSearchParams({
      format: 'jsonv2', lat: String(lat), lon: String(lon),
      zoom: '18', addressdetails: '0', 'accept-language': 'id',
    });
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
      headers: {
        'User-Agent': 'FleetOps-FleetTrackingBot/1.0 (internal fleet-management Telegram bot)',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return (data && data.display_name) ? data.display_name : null;
  } catch (e) {
    console.log('reverseGeocodeLatLon: gagal ambil alamat (diabaikan):', e && e.message);
    return null;
  }
}

// ----------------------------------------------------------------------------
// Insight GPS per Trip -- kombinasi gap odometer manual dgn data GPS.id.
// Dipakai badge "🛰️ Insight GPS" tappable di halaman Riwayat Trip
// (index.html: openGpsInsightModal()). Berbeda dari fetchGpsIdVehicleData()
// di atas (posisi TERKINI semua mobil, di-cache 15 detik) -- ini query
// HISTORIS 1 mobil pada rentang waktu 1 trip tertentu, jadi TIDAK
// masuk cache yang sama & SENGAJA cuma dipanggil ON-DEMAND (klik badge),
// bukan otomatis massal, supaya tidak membebani rate limit GPS.id.
// ----------------------------------------------------------------------------

function parseGpsHistoryList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.message?.data)) return data.message.data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.message)) return data.message;
  return null;
}

const GPS_HISTORY_PER_PAGE = 500;
const GPS_HISTORY_MAX_PAGES = 10; // guard rail -- maksimal 5.000 titik per request, cukup utk 1 trip

// Ambil SEMUA titik histori (posisi + acc + mileage per waktu) utk 1 imei
// dalam rentang [start, end], format "YYYY-MM-DD HH:MM:SS" sesuai dokumentasi
// GPS.id. Dipaginasi otomatis kalau totalnya melebihi 1 halaman.
async function fetchGpsIdHistoryPoints(env, imei, start, end) {
  const token = await getGpsIdToken(env); // bisa throw (login gagal/429) -- dibiarkan naik ke pemanggil

  let allPoints = [];
  let page = 1;
  let total = null;

  while (page <= GPS_HISTORY_MAX_PAGES) {
    const params = new URLSearchParams({
      page: String(page), per_page: String(GPS_HISTORY_PER_PAGE), device: imei, start, end
    });
    const res = await fetch(`https://portal.gps.id/backend/seen/public/report/history?${params.toString()}`, {
      method: "GET",
      headers: { "accept": "application/json", "Authorization": token }
    });

    if (res.status === 429) {
      const err = new Error("GPS.id membatasi permintaan (rate limit). Coba lagi sebentar.");
      err.gpsStatus = 429;
      throw err;
    }

    const data = await res.json().catch(() => null);
    if (res.status !== 200 || !data || data.status !== true) {
      const pesan = data?.message;
      const err = new Error(typeof pesan === "string" ? pesan : `Gagal mengambil histori GPS.id (HTTP ${res.status}).`);
      err.gpsStatus = res.status;
      throw err;
    }

    const list = parseGpsHistoryList(data) || [];
    allPoints = allPoints.concat(list);
    if (total == null) total = Number(data?.message?.total ?? list.length);
    if (list.length === 0 || allPoints.length >= total) break;
    page++;
  }

  return allPoints;
}

// Dari titik-titik histori (tidak dijamin urut), hitung 2 angka utama:
//  - engineOnMinutes: total durasi ber-akumulasi selama acc=ON, dijumlahkan
//    dari selisih waktu antar titik BERURUTAN yang titik AWALnya berstatus
//    ON. Presisi tergantung kerapatan titik yang dikirim GPS.id (device
//    biasanya lapor tiap sekian detik/menit saat bergerak) -- cukup akurat
//    utk kebutuhan "berapa lama mesin nyala per trip", bukan presisi detik.
//  - gpsDistanceKm: selisih mileage titik tertinggi & terendah dalam
//    rentang (mileage GPS.id kumulatif/tidak pernah turun secara wajar).
// Batas kecepatan fisik masuk akal (km/j) -- titik histori GPS.id di atas ini
// dianggap NOISE (lompatan sinyal/pantulan multipath, bukan kendaraan
// bergerak sungguhan), jadi dibuang SEBELUM dipakai hitung jarak/mileage.
// 180 dipilih sebagai batas atas yg longgar (jauh di atas kecepatan wajar
// jalan tol Indonesia) supaya tidak ikut membuang data valid mobil ngebut,
// cuma menyaring lompatan yg jelas tidak fisik.
const GPS_NOISE_MAX_SPEED_KMH = 180;

function computeGpsHistoryInsight(points) {
  const parsedAll = points
    .map(p => ({
      time: new Date(String(p.time || "").replace(" ", "T") + "+07:00").getTime(),
      acc: Number(p.acc) === 1 || p.acc === true || p.acc === "1",
      mileage: p.mileage != null ? Number(p.mileage) : null,
      speed: p.speed != null ? Number(p.speed) : null,
    }))
    .filter(p => !isNaN(p.time))
    .sort((a, b) => a.time - b.time);

  // v3.147.0 -- buang titik dengan speed tidak wajar SEBELUM dipakai hitung
  // mileage/jarak (poin F). Titik tanpa field speed (null/NaN) tetap
  // dipertahankan -- tidak ada bukti dia noise, jangan dibuang cuma karena
  // field-nya kosong. noiseFilteredCount disertakan supaya bisa ditelusuri
  // kalau suatu saat perlu tahu berapa titik yg dibuang.
  const parsed = parsedAll.filter(p => p.speed == null || isNaN(p.speed) || p.speed <= GPS_NOISE_MAX_SPEED_KMH);
  const noiseFilteredCount = parsedAll.length - parsed.length;

  if (parsed.length === 0) {
    return { pointCount: 0, engineOnMinutes: null, gpsDistanceKm: null, avgSpeedKmh: null, firstTime: null, lastTime: null, noiseFilteredCount };
  }

  let engineOnMs = 0;
  for (let i = 0; i < parsed.length - 1; i++) {
    if (parsed[i].acc) engineOnMs += (parsed[i + 1].time - parsed[i].time);
  }

  const mileages = parsed.map(p => p.mileage).filter(m => m != null && !isNaN(m));
  const gpsDistanceKm = mileages.length >= 2
    ? Math.round((Math.max(...mileages) - Math.min(...mileages)) / 1000 * 10) / 10
    : null;

  // v3.??? -- Rata-rata kecepatan: dihitung dari SEMUA titik yang punya
  // field speed (termasuk speed=0 saat berhenti/macet) -- SENGAJA bukan
  // cuma titik yang bergerak, supaya angkanya mencerminkan "pace" total
  // perjalanan sopir itu, bukan cuma kecepatan pas jalan saja. Titik noise
  // (>180 km/j) sudah dibuang sebelum sampai sini lewat filter di atas.
  const speeds = parsed.map(p => p.speed).filter(s => s != null && !isNaN(s));
  const avgSpeedKmh = speeds.length > 0
    ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10
    : null;

  return {
    pointCount: parsed.length,
    engineOnMinutes: Math.round(engineOnMs / 60000),
    gpsDistanceKm,
    avgSpeedKmh,
    firstTime: new Date(parsed[0].time).toISOString(),
    lastTime: new Date(parsed[parsed.length - 1].time).toISOString(),
    noiseFilteredCount,
  };
}

// Hitung rata-rata kecepatan (km/j) utk 1 trip: dipanggil SEKALI saat trip
// ditutup (lihat finalizeTutupTrip di processTelegramUpdate() & runNotifyCheck()),
// hasilnya disimpan permanen sbg trip.avgSpeedKmh -- bukan dihitung ulang tiap
// kali ada yg tanya, supaya hemat kuota API GPS.id (report/history TIDAK
// dicache, beda dari /vehicle). Best-effort: tutup trip TETAP jalan walau GPS.id
// error/rate-limit/IMEI salah -- TAPI (BARU) alasan gagalnya sekarang
// dikembalikan juga (bukan cuma di-log lalu dibuang), supaya pemanggil bisa
// menyimpannya sbg trip.avgSpeedError -- jejak diagnostik ini yang sebelumnya
// hilang total (cuma console.log server, tidak kelihatan dari mana pun),
// bikin poin 3 (Administrator) tidak pernah tahu KENAPA rata-rata kecepatan
// kosong utk sebuah trip.
async function computeTripAvgSpeedKmh(env, imei, tglMulai, jamMulai, tglSelesai, jamSelesai) {
  if (!imei || !tglMulai || !tglSelesai) return { avgSpeedKmh: null, error: null };
  try {
    const start = `${tglMulai} ${(jamMulai || '00:00')}:00`;
    const end = `${tglSelesai} ${(jamSelesai || '23:59')}:59`;
    const points = await fetchGpsIdHistoryPoints(env, imei, start, end);
    const insight = computeGpsHistoryInsight(points);
    if (insight.avgSpeedKmh == null) {
      return { avgSpeedKmh: null, error: points.length === 0 ? 'GPS.id tidak punya data histori posisi utk rentang waktu trip ini.' : 'Titik histori GPS.id ada tapi tidak ada satu pun yg punya field kecepatan.' };
    }
    return { avgSpeedKmh: insight.avgSpeedKmh, error: null };
  } catch (err) {
    console.log('computeTripAvgSpeedKmh: gagal (diabaikan, trip tetap ditutup):', err && err.message);
    return { avgSpeedKmh: null, error: err.message || 'Gagal menghubungi GPS.id.' };
  }
}

// Handler: GET /gpsid/trip-insight?imei=...&start=YYYY-MM-DD HH:MM:SS&end=YYYY-MM-DD HH:MM:SS
// BARU -- ubah titik histori mentah (bisa ribuan) jadi rangkaian titik
// {lat, lon, t (unix ms), speed} yang RINGKAS & terurut waktu, siap dipakai
// gambar polyline + animasi replay di index.html (Leaflet). Dibatasi
// GPS_ROUTE_MAX_POINTS titik -- kalau lebih, ambil tiap-N titik (bukan
// potong ujungnya) supaya bentuk rute tetap representatif dari awal sampai
// akhir trip, cuma resolusinya diturunkan. Titik dgn koordinat tidak valid
// dibuang, sama seperti computeGpsHistoryInsight() membuang speed noise.
const GPS_ROUTE_MAX_POINTS = 300;
function downsampleRoutePoints(points) {
  const parsed = points
    .map(p => ({
      lat: p.lat != null ? Number(p.lat) : null,
      lon: p.lon != null ? Number(p.lon) : null,
      t: (() => { const d = new Date(String(p.time || '').replace(' ', 'T') + '+07:00'); return isNaN(d) ? null : d.getTime(); })(),
      speed: p.speed != null ? Number(p.speed) : null,
    }))
    .filter(p => p.lat != null && p.lon != null && !isNaN(p.lat) && !isNaN(p.lon) && p.t != null
      && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)
    .sort((a, b) => a.t - b.t);

  if (parsed.length <= GPS_ROUTE_MAX_POINTS) return parsed;
  const step = parsed.length / GPS_ROUTE_MAX_POINTS;
  const out = [];
  for (let i = 0; i < GPS_ROUTE_MAX_POINTS; i++) out.push(parsed[Math.floor(i * step)]);
  out.push(parsed[parsed.length - 1]); // pastikan titik TERAKHIR selalu ikut, bukan cuma kelipatan step
  return out;
}

async function handleGpsIdTripInsight(request, env, corsHeaders) {
  const url = new URL(request.url);
  const imei = (url.searchParams.get("imei") || "").trim();
  const start = (url.searchParams.get("start") || "").trim();
  const end = (url.searchParams.get("end") || "").trim();
  // BARU -- ?route=1 -- ikut sertakan titik-titik rute (lat/lon/waktu/
  // kecepatan) utk fitur "🎥 Replay Rute" di modal Insight GPS
  // (openGpsInsightModal, index.html). Opsional (bukan default) supaya
  // pemanggil yang cuma butuh angka ringkasan (insight biasa) tidak ikut
  // menanggung payload lebih besar tanpa perlu.
  const includeRoute = url.searchParams.get("route") === "1";

  if (!imei || !start || !end) {
    return new Response(
      JSON.stringify({ error: "Parameter imei, start, dan end wajib diisi." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const points = await fetchGpsIdHistoryPoints(env, imei, start, end);
    const insight = computeGpsHistoryInsight(points);
    const body = { ok: true, ...insight };
    if (includeRoute) body.route = downsampleRoutePoints(points);
    return new Response(JSON.stringify(body), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (err) {
    console.log("handleGpsIdTripInsight: gagal:", err.message);
    return new Response(
      JSON.stringify({ error: err.message || "Gagal mengambil histori GPS.id." }),
      { status: err.gpsStatus || 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Handler: GET /gpsid/alert-codes -> proxy ke ref_alert/alert_code_list.
// Handler: POST /gpsid/push-data -- terima 1 update posisi dari Push Data
// API GPS.id (dipanggil GPS.id sendiri, ~tiap 30 detik per unit), simpan
// ke Cloudflare KV (GPS_PUSH_KV). Field JSON SESUAI dokumentasi GPS.id
// "Register Endpoint" (VehicleId/Lon/Lat/Speed/Direction/Engine/Odometer/
// DatetimeUTC/dst) -- lihat catatan lengkap di applyGpsPushOverlay().
// SELALU balas cepat (GPS.id kemungkinan expect ack cepat tiap 30 detik x
// banyak unit) -- validasi minimal, gagal diam² kalau KV belum di-bind
// (supaya pendaftaran endpoint tidak bikin GPS.id terus dapat error kalau
// Administrator belum sempat setup KV).
async function handleGpsIdPushData(request, env, corsHeaders) {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  const notifSecret = env.NOTIFY_SECRET;
  if (!notifSecret) {
    return new Response(JSON.stringify({ error: "NOTIFY_SECRET belum diatur di dasbor Cloudflare." }), { status: 500, headers: jsonHeaders });
  }
  const url = new URL(request.url);
  const gotSecret = url.searchParams.get("secret") || "";
  if (gotSecret !== notifSecret) {
    return new Response(JSON.stringify({ error: "Secret tidak cocok." }), { status: 403, headers: jsonHeaders });
  }
  if (!env.GPS_PUSH_KV) {
    // BUKAN error fatal -- endpoint tetap balas 200 supaya GPS.id tidak
    // menganggap endpoint ini rusak & berhenti mencoba, cuma datanya
    // dibuang (belum ada tempat simpan). Log supaya kelihatan di Cloudflare
    // kalau ini yang terjadi.
    console.log("handleGpsIdPushData: GPS_PUSH_KV belum di-bind, data push dibuang.");
    return new Response(JSON.stringify({ ok: true, stored: false, reason: "KV belum di-bind" }), { status: 200, headers: jsonHeaders });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Body harus JSON valid." }), { status: 400, headers: jsonHeaders });
  }

  const imei = String(body.VehicleId || body.vehicleId || body.imei || "").trim();
  if (!imei) {
    return new Response(JSON.stringify({ error: "Field VehicleId wajib diisi." }), { status: 400, headers: jsonHeaders });
  }
  const lat = Number(body.Lat ?? body.lat);
  const lon = Number(body.Lon ?? body.lon);
  if (isNaN(lat) || isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return new Response(JSON.stringify({ error: "Lat/Lon tidak valid." }), { status: 400, headers: jsonHeaders });
  }

  const record = {
    imei,
    plate: body.VehicleNumber || body.plate || null,
    lat, lon,
    speed: body.Speed != null ? Number(body.Speed) : null,
    angle: body.Direction != null ? Number(body.Direction) : null,
    acc: String(body.Engine || "").toUpperCase() === "ON",
    mileage: body.Odometer != null ? Number(body.Odometer) : null, // dokumentasi: meter (SAMA satuan dgn field "mileage" di /vehicle)
    lastUpdate: body.DatetimeUTC || null,
    updatedAt: Date.now(),
  };

  try {
    // expirationTtl 300 detik (5 menit) -- kalau device berhenti push (mati/
    // dicabut/di luar jangkauan), record ini otomatis lenyap dari KV
    // sendirinya, bukan nyantol nunjukin posisi basi selamanya. Sinkron dgn
    // GPS_PUSH_FRESHNESS_MS di applyGpsPushOverlay().
    await env.GPS_PUSH_KV.put(`gps-push:${imei}`, JSON.stringify(record), { expirationTtl: 300 });
  } catch (e) {
    console.log("handleGpsIdPushData: gagal tulis KV:", e.message);
    return new Response(JSON.stringify({ error: "Gagal menyimpan ke KV." }), { status: 502, headers: jsonHeaders });
  }

  return new Response(JSON.stringify({ ok: true, stored: true }), { status: 200, headers: jsonHeaders });
}

async function handleGpsIdAlertCodes(request, env, corsHeaders) {
  try {
    const codes = await fetchGpsIdAlertCodes(env);
    return new Response(JSON.stringify({ ok: true, codes }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Gagal mengambil daftar kode alert GPS.id." }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// Handler: GET /gpsid/vehicles -> proxy ke Get Vehicle GPS.id (posisi &
// status semua kendaraan terkini di akun GPS.id Anda), lewat cache/cooldown
// bersama di fetchGpsIdVehicleData().
async function handleGpsIdVehicles(request, env, corsHeaders) {
  try {
    const result = await fetchGpsIdVehicleData(env);
    if (result.status !== 200) {
      return new Response(
        JSON.stringify({ error: result.error || `HTTP ${result.status}` }),
        { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify(result.data), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", ...(result.stale ? { "X-Gps-Cache": "stale" } : {}) }
    });
  } catch (err) {
    if (gpsVehicleCache.data) {
      return new Response(JSON.stringify(gpsVehicleCache.data), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json", "X-Gps-Cache": "stale-error" }
      });
    }
    return new Response(
      JSON.stringify({ error: err.message || "Gagal mengambil data GPS.id." }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}
