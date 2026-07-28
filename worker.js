export default {
  async fetch(request, env) {
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

    const url = new URL(request.url);
    const cleanPath = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;

    /* ============================================================
       RUTE BARU (v1.9): kirim Resi Perjalanan LANGSUNG ke Telegram,
       tanpa lewat GitHub sama sekali. Dipanggil dari index.html PERSIS
       saat trip ditandai "Selesai" -- jauh lebih cepat & tidak
       bergantung pada sinkron data ke GitHub selesai duluan, dan tidak
       perlu menunggu cron GitHub Actions (~5 menit, bisa meleset).
       Endpoint ini SENGAJA dipisah dari reverse-proxy GitHub di bawah
       (path/metode beda) supaya penjaga pintu GitHub tidak perlu
       diubah sama sekali.
       ============================================================ */
    if (request.method === "POST" && cleanPath === "/notify-trip-selesai") {
      return handleNotifyTripSelesai(request, env, corsHeaders);
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
          "User-Agent": "Cloudflare-Worker-FleetOps-Proxy-v1.9",
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
};

/* ----------------------------------------------------------------
   Handler /notify-trip-selesai
   Body yang diharapkan (JSON): { chatId: "123456789", text: "<b>...</b>" }
   Header wajib: X-Notify-Secret -- harus SAMA PERSIS dengan Secret
   NOTIF_SECRET yang diatur di dasbor Cloudflare Worker (Settings ->
   Variables). Ini BUKAN pengganti keamanan sungguhan (nilainya ikut
   ada di kode index.html yang bisa dibaca siapa saja yang buka
   DevTools) -- tapi tetap dipasang sebagai penjaga pintu MINIMAL,
   supaya URL worker ini tidak bisa langsung dipakai orang random utk
   spam pesan lewat bot Anda ke chat ID sembarangan hanya dengan
   menebak-nebak endpoint-nya.
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

  // Validasi ringan -- chat ID Telegram itu angka (boleh minus di depan utk grup).
  if (!/^-?\d{3,}$/.test(chatId)) {
    return new Response(JSON.stringify({ error: "chatId tidak valid." }), { status: 400, headers: jsonHeaders });
  }
  if (!text) {
    return new Response(JSON.stringify({ error: "text kosong." }), { status: 400, headers: jsonHeaders });
  }
  // Batas Telegram utk 1 pesan teks ~4096 karakter -- potong kalau kelewat,
  // supaya request tidak ditolak Telegram gara-gara ini.
  const safeText = text.length > 4000 ? text.slice(0, 3990) + "\n\n<i>(dipotong)</i>" : text;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken.trim()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: safeText, parse_mode: "HTML" })
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
