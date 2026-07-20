# Panduan Menghubungkan FleetOps ke Internet + Sinkron Otomatis ke GitHub

**Prinsip panduan ini: tidak ada satupun file yang perlu Anda EDIT.**
Semua file di paket ini dipakai **apa adanya** — tinggal upload atau copy-paste.
Konfigurasi (URL Worker, username GitHub, nama repo) semuanya diisi lewat
**form di dalam aplikasi** atau **form di dashboard Cloudflare**, bukan di kode.

Ada 3 bagian besar, dikerjakan berurutan:
- **BAGIAN A** — bikin situsnya online (10 menit)
- **BAGIAN B** — bikin "jembatan" penyimpan data ke GitHub (10 menit)
- **BAGIAN C** — hubungkan keduanya dari dalam aplikasi (1 menit)

---

## 📦 Isi paket ini

```
fleet-pwa/
├── index.html, manifest.json, sw.js, icons/   ← UPLOAD apa adanya ke repo APLIKASI
├── .github/workflows/deploy.yml                ← ikut ter-upload otomatis (auto-deploy)
└── cloudflare-worker/
    └── worker.js                                ← COPY-PASTE isinya ke Cloudflare Worker
```

---

# BAGIAN A — Situs online (GitHub + Cloudflare Pages)

### A1. Buat repo GitHub untuk aplikasi
1. Buka [github.com/new](https://github.com/new) → beri nama, misal `fleetops` → **Create repository**.
2. Di halaman repo kosong itu, klik **uploading an existing file**.
3. **Upload SEMUA isi folder `fleet-pwa/`** (drag & drop semua file dan foldernya, termasuk folder `.github` dan `icons` — pastikan struktur foldernya ikut terbawa, bukan cuma file `index.html` sendirian).
4. Klik **Commit changes**.

### A2. Buat project di Cloudflare Pages
1. Login ke [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create application** → tab **Pages** → **Connect to Git**.
2. Pilih repo `fleetops` yang baru dibuat tadi.
3. Biarkan pengaturan build kosong/default (situs ini statis, tidak perlu proses build) → **Save and Deploy**.

Selesai — situs Anda online di alamat seperti `https://fleetops.pages.dev`. Setiap kali Anda upload perubahan baru ke repo GitHub ini, situsnya otomatis update sendiri.

---

# BAGIAN B — Jembatan penyimpan data ke GitHub (Cloudflare Worker)

### B1. Buat repo GitHub KHUSUS untuk data
1. [github.com/new](https://github.com/new) lagi → beri nama, misal `fleetops-data` → boleh **Private** (disarankan, karena isinya data internal) → **Create repository**.
2. Repo ini **dibiarkan kosong** — tidak perlu upload apapun, nanti terisi otomatis.

### B2. Buat GitHub Token
1. GitHub → foto profil (kanan atas) → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. **Repository access** → **Only select repositories** → pilih `fleetops-data` saja.
3. **Permissions** → cari **Contents** → ubah ke **Read and write**.
4. **Generate token** → **salin token-nya sekarang juga** (halaman ini cuma menampilkannya sekali).

### B3. Buat Worker & tempel kode
1. Cloudflare dashboard → **Workers & Pages** → **Create application** → tab **Workers** → **Create Worker**.
2. Beri nama, misal `fleetops-worker` → **Deploy** (isinya masih kode contoh bawaan, akan ditimpa).
3. Klik **Edit code**.
4. **Hapus semua isi editor**, lalu **copy seluruh isi file `cloudflare-worker/worker.js`** dari paket ini, **paste** ke editor tersebut.
5. Klik **Deploy** / **Save and deploy**.
6. Catat URL Worker yang muncul, bentuknya seperti: `https://fleetops-worker.NAMA-SUBDOMAIN-ANDA.workers.dev`

### B4. Isi Variables (bukan edit kode — ini isi form biasa di dashboard)
Masih di halaman Worker → tab **Settings** → **Variables and Secrets** → **Add**:

| Nama Variable | Isi | Tipe |
|---|---|---|
| `ALLOWED_OWNER` | username GitHub Anda | Text biasa |
| `ALLOWED_REPO` | `fleetops-data` | Text biasa |
| `GITHUB_TOKEN` | token dari Langkah B2 | **Encrypt** (klik tombol Encrypt sebelum save) |

Klik **Deploy** untuk menyimpan.

---

# BAGIAN C — Hubungkan dari dalam aplikasi

1. Buka situs Anda dari Bagian A (`https://fleetops.pages.dev`).
2. Lihat footer paling bawah → klik **"atur repository"**.
3. Isi 3 kotak:
   - **URL Cloudflare Worker**: URL dari Langkah B3
   - **Owner/Username**: username GitHub Anda (sama seperti Langkah B4)
   - **Repository**: `fleetops-data`
4. Klik **Hubungkan**.

Kalau berhasil, muncul **"✔ Berhasil terhubung!"** dan badge **"☁️ Sinkron aktif"** di footer.

---

## Bagaimana cara kerjanya setelah ini

- Setiap kali data diubah (tambah mobil, catat penggunaan, dll), otomatis tersimpan ke repo `fleetops-data` sebagai **commit baru** — bisa dicek riwayatnya di tab **Commits** repo tersebut.
- Aplikasi otomatis cek pembaruan tiap ±20 detik dan setiap kali dibuka kembali.
- Kalau dibuka dari HP/laptop lain dan dihubungkan ke repo yang sama (ulangi Bagian C di device itu), datanya **otomatis digabung**, bukan saling menimpa.
- Kalau internet putus, aplikasi tetap jalan penuh pakai data tersimpan di perangkat itu (localStorage), dan akan sinkron lagi begitu online.

## Kalau ada yang gagal

- **"Worker tidak punya akses ke repo ini"** → cek lagi 3 Variables di Langkah B4, terutama `ALLOWED_OWNER`/`ALLOWED_REPO` harus **persis sama** dengan yang diisi di form Bagian C.
- **Badge tetap "Sinkron tidak berjalan"** → cek URL Worker di form Bagian C sudah benar dan diawali `https://`.
- Butuh cek detail error → buka situsnya, tekan F12 (DevTools) → tab **Console**, akan ada pesan error yang lebih rinci di sana.
