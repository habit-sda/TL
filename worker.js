export default {
  async fetch(request, env) {
    // 1. Mengatur header CORS agar browser HP tidak memblokir request (Error CORS)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GitHub-Api-Version"
    };

    // Tangani preflight request dari browser
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
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
    const url = new URL(request.url);
    const cleanPath = url.pathname.startsWith('/') ? url.pathname : `/${url.pathname}`;

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
          "User-Agent": "Cloudflare-Worker-FleetOps-Proxy-v1.8",
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
