#!/usr/bin/env node
/* ============================================================================
   FleetOps — Notifikasi Telegram Otomatis (dijalankan oleh GitHub Actions)
   ============================================================================
   Dipanggil oleh .github/workflows/telegram-notify.yml tiap jam.

   PENTING soal keakuratan: semua fungsi di bawah ini adalah PORTING PERSIS
   dari index.html (computeAlerts() dan fungsi-fungsi bantunya). Sengaja
   di-copy manual (bukan di-import dari index.html) karena index.html
   dirancang jalan di browser (pakai DOM dsb), sementara script ini jalan
   murni di Node.js tanpa browser. Kalau nanti computeAlerts() atau fungsi
   bantunya di index.html diubah, SALIN ULANG perubahan yang sama persis ke
   sini juga — supaya notifikasi Telegram tidak pernah beda hasil dengan
   lonceng notifikasi di aplikasi.

   Sumber data: file JSON hasil sinkron 2 arah (lihat pushToGithub() di
   index.html) di path FLEETOPS_DATA_PATH, berbentuk:
     { "data": { cars:[], usage:[], services:[], documents:[], etollCards:[], ... },
       "tombstones": {...} }
   Karena script ini jalan di GitHub Actions PADA REPO YANG SAMA (lewat
   actions/checkout), file ini dibaca langsung dari disk — TIDAK lewat
   Cloudflare Worker/GitHub API, dan TIDAK butuh token GitHub sama sekali.
   ============================================================================ */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DATA_PATH = process.env.FLEETOPS_DATA_PATH || 'data/fleetops-data.json';
const STATE_PATH = process.env.FLEETOPS_NOTIF_STATE_PATH || join(dirname(DATA_PATH), 'notif-state.json');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// TELEGRAM_CHAT_ID Secret sekarang OPSIONAL -- penerima utama diambil dari
// field "Telegram Chat ID" di menu Data Sopir (index.html), supaya admin
// tidak perlu bolak-balik ke GitHub Secrets tiap ada sopir baru yang mau
// didaftarkan. Secret ini, kalau tetap diisi, jadi penerima TAMBAHAN (mis.
// buat admin/pengelola yang bukan sopir).
const ADMIN_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN belum diisi di GitHub Secrets (Settings → Secrets and variables → Actions). Berhenti.');
  process.exit(1);
}

// ============================================================================
// MODE TES (v3.97.0) -- dipicu lewat "Run workflow" manual di tab Actions
// dengan input test_chat_id diisi (lihat tombol "🧪 Test Notifikasi" di
// Data Sopir, index.html, yang menyiapkan Chat ID-nya + link ke sini).
// Kirim 1 pesan tes SEDERHANA langsung ke Chat ID itu, TIDAK menyentuh
// logika deteksi alert/anti-spam sama sekali -- supaya bisa dites kapan
// saja tanpa terpengaruh status notif-state.json yang sudah ada, dan tidak
// perlu file data.json ada dulu.
// ============================================================================
const TEST_CHAT_ID = (process.env.TEST_CHAT_ID || '').trim();
if (TEST_CHAT_ID) {
  console.log(`🧪 Mode tes -- mengirim 1 pesan percobaan ke Chat ID ${TEST_CHAT_ID}...`);
  const testText = [
    '🧪 <b>Ini pesan TES dari FleetOps</b>',
    '',
    'Kalau Anda menerima pesan ini, artinya notifikasi Telegram sudah tersambung dengan benar ke nomor ini.',
    '',
    `<i>Dikirim manual (mode tes) ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })} WIB</i>`,
  ].join('\n');
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TEST_CHAT_ID, text: testText, parse_mode: 'HTML' })
    });
    const resBody = await res.json().catch(() => ({}));
    if (!res.ok || !resBody.ok) {
      console.error(`❌ Gagal kirim pesan tes ke ${TEST_CHAT_ID}:`, JSON.stringify(resBody));
      console.error('   Penyebab tersering: sopir belum pernah mengirim pesan APA PUN ke bot ini dulu (Telegram mewajibkan itu sebelum bot boleh kirim duluan), atau Chat ID-nya salah ketik.');
      process.exit(1);
    }
    console.log(`✅ Pesan tes berhasil terkirim ke ${TEST_CHAT_ID}.`);
    process.exit(0);
  } catch (e) {
    console.error(`❌ Gagal kirim pesan tes ke ${TEST_CHAT_ID}:`, e.message);
    process.exit(1);
  }
}

if (!existsSync(DATA_PATH)) {
  console.log(`ℹ️  Belum ada file data di "${DATA_PATH}" — kemungkinan belum pernah ada device yang sinkron ke repo ini. Dilewati (bukan error, tidak ada yang dikirim).`);
  process.exit(0);
}

let raw;
try {
  raw = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
} catch (e) {
  console.error(`❌ Gagal parse "${DATA_PATH}" sebagai JSON:`, e.message);
  process.exit(1);
}

const state = raw.data || {};
state.cars = state.cars || [];
state.usage = state.usage || [];
state.services = state.services || [];
state.documents = state.documents || [];
state.drivers = state.drivers || [];
state.etollCards = state.etollCards || [];
state.bookings = state.bookings || []; // v3.102.0 -- Reminder Booking H-1

/* ============================================================================
   ---- BAGIAN PORTING DARI index.html (JANGAN diubah rumusnya sendirian) ----
   ============================================================================ */

function today() { return new Date().toISOString().slice(0, 10); }

// v3.103.0 -- PORTING PERSIS dari index.html: langganan notifikasi PER
// SOPIR. driver.notifKategori (array key) menentukan kategori apa saja yang
// dikirim ke Telegram sopir itu -- null/undefined = SEMUA kategori (supaya
// sopir lama yang sudah terdaftar sebelum fitur ini tidak tiba-tiba
// berhenti dapat notif apa pun).
const NOTIF_CATEGORIES = [
  { key: 'doc', prefix: 'doc-' },
  { key: 'service', prefix: 'svc-' },
  { key: 'etoll', prefix: 'etoll-' },
  { key: 'bbm', prefix: 'bbm-' },
  { key: 'booking', prefix: 'booking-h1-' },
];
function categoryOfAlertId(id) {
  const found = NOTIF_CATEGORIES.find(c => id.startsWith(c.prefix));
  return found ? found.key : null;
}
function alertsForDriver(allAlerts, driver) {
  const kategoriDipilih = Array.isArray(driver.notifKategori) ? driver.notifKategori : null;
  if (!kategoriDipilih) return allAlerts;
  return allAlerts.filter(a => kategoriDipilih.includes(categoryOfAlertId(a.id)));
}

// v3.95.0 -- PORTING PERSIS dari getNotifSettings() di index.html. Ambang
// batas notifikasi sekarang bisa diatur admin lewat menu Pengaturan (dikunci
// PIN Insight) -- dibaca dari state.notifSettings (ikut tersinkron lewat
// data.json yang sama), dengan fallback default SAMA PERSIS dengan index.html
// kalau field-nya belum ada (data lama / belum pernah diatur).
const NOTIF_SETTINGS_DEFAULT = { docExpiryDays: 30, serviceWarnPct: 80, bbmMinDefault: 20, etollMinDefault: 25000 };
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
// ---- PORTING PERSIS dari index.html: kalkulasi Tanda Terima Perjalanan
// (v3.103.0, khusus utk auto-kirim resi via Telegram -- lihat bagian bawah
// file). SENGAJA TIDAK ikut porting perhitungan Efisiensi BBM (buildFuelChain,
// algoritma paling kompleks di aplikasi) -- resi Telegram fokus ke info yang
// paling dibutuhkan sopir (jarak, durasi, biaya), efisiensi lengkap tetap
// bisa dilihat di aplikasi. ----
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
function usageBiayaOpTotal(u) { return usageBiayaOpItems(u).reduce((sum, it) => sum + (Number(it.nominal) || 0), 0); }
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
  const biayaOpTotal = usageBiayaOpTotal(u);
  const grandTotal = (Number(u.biayaBensin) || 0) + biayaTol + biayaOpTotal;

  const lines = [
    '🧾 <b>Tanda Terima Perjalanan</b>', '',
    `<b>Mobil:</b> ${escapeHtmlTg(carLabel(u.carId))}`,
    `<b>Sopir:</b> ${escapeHtmlTg(driverLabel(u.driverId, u.driver))}`,
    `<b>Tujuan:</b> ${escapeHtmlTg(u.tujuan || '-')}`,
    `<b>Berangkat:</b> ${escapeHtmlTg(u.tglKeluar || '-')}${u.jamKeluar ? ', ' + u.jamKeluar : ''}`,
    `<b>Tiba:</b> ${u.tglKembali ? escapeHtmlTg(u.tglKembali) + (u.jamKembali ? ', ' + u.jamKembali : '') : '-'}`,
    `<b>Durasi:</b> ${fmtDurationMinutes(getTripDurationMinutes(u))}`, '',
    `Jarak Tempuh: ${jarak != null ? jarak.toLocaleString('id-ID') + ' KM' : '-'}`,
  ];
  if (u.literBensin) lines.push(`BBM Diisi: ${u.literBensin} L`);
  lines.push(`Biaya BBM: ${fmtMoney(u.biayaBensin || 0)}`);
  if (biayaTolInfo) lines.push(`Biaya Tol: ${fmtMoney(biayaTol)}`);
  biayaOpItems.forEach(it => {
    lines.push(`${escapeHtmlTg(it.kategori)}${it.jenisBbm ? ' · ' + escapeHtmlTg(it.jenisBbm) : ''}: ${fmtMoney(it.nominal)}`);
  });
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

function serviceReminderInfo(car) {
  if (!car.intervalKm && !car.intervalBulan) return null;
  const lastService = state.services
    .filter(s => s.carId === car.id)
    .sort((a, b) => b.tanggal.localeCompare(a.tanggal))[0];
  if (!lastService) return { level: 'warn', text: 'Belum ada riwayat servis tercatat' };

  let pctKm = null, pctBulan = null;
  if (car.intervalKm && lastService.odometer != null && car.odometerSaatIni != null) {
    const traveled = car.odometerSaatIni - lastService.odometer;
    pctKm = traveled / car.intervalKm;
  }
  if (car.intervalBulan) {
    const months = monthsBetween(lastService.tanggal, today());
    pctBulan = months / car.intervalBulan;
  }
  if (pctKm === null && pctBulan === null) return { level: 'warn', text: 'Data odometer belum cukup untuk hitung pengingat' };
  const pct = Math.max(pctKm || 0, pctBulan || 0);

  let perkiraanTanggal = null;
  if (car.intervalBulan && lastService.tanggal) {
    const d = new Date(lastService.tanggal);
    d.setMonth(d.getMonth() + car.intervalBulan);
    perkiraanTanggal = d;
  }
  if (car.intervalKm && lastService.odometer != null && car.odometerSaatIni != null) {
    const sisaKm = car.intervalKm - (car.odometerSaatIni - lastService.odometer);
    const avgKmPerDay = computeAvgKmPerDay(car.id);
    if (avgKmPerDay && avgKmPerDay > 0) {
      const sisaHari = sisaKm / avgKmPerDay;
      const dKm = new Date();
      dKm.setDate(dKm.getDate() + Math.round(sisaHari));
      if (!perkiraanTanggal || dKm < perkiraanTanggal) perkiraanTanggal = dKm;
    }
  }
  const perkiraanText = perkiraanTanggal
    ? ` (perkiraan ${perkiraanTanggal.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })})`
    : '';

  if (pct >= 1) return { level: 'danger', text: 'Sudah waktunya servis/ganti oli' + perkiraanText };
  if (pct >= (getNotifSettings().serviceWarnPct / 100)) return { level: 'warn', text: 'Segera servis (mendekati jadwal)' + perkiraanText };
  return { level: 'ok', text: 'Servis masih jauh' + perkiraanText };
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

// ---- computeAlerts() -- PERSIS SAMA dgn index.html (4 jenis alert) ----
function computeAlerts() {
  const alerts = [];
  const ns = getNotifSettings();

  state.documents.forEach(d => {
    const sisa = daysBetween(d.tglExpired);
    if (sisa <= ns.docExpiryDays) {
      alerts.push({
        id: 'doc-' + d.id,
        ic: sisa < 0 ? '⛔' : '📄', level: sisa < 0 ? 'danger' : 'warn',
        judul: `${d.jenis} ${sisa < 0 ? 'kedaluwarsa' : 'akan habis'}`,
        keterangan: `${carLabel(d.carId)} — ${sisa < 0 ? Math.abs(sisa) + ' hari lalu' : sisa + ' hari lagi'}`
      });
    }
  });

  state.cars.forEach(c => {
    const r = serviceReminderInfo(c);
    if (r && (r.level === 'warn' || r.level === 'danger')) {
      alerts.push({ id: 'svc-' + c.id, ic: '🔧', level: r.level, judul: 'Servis/Ganti Oli', keterangan: `${carLabel(c.id)} — ${r.text}` });
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

  // v3.102.0 -- PORTING PERSIS dari index.html: Reminder Booking H-1.
  const besok = new Date(); besok.setDate(besok.getDate() + 1);
  const besokStr = `${besok.getFullYear()}-${String(besok.getMonth() + 1).padStart(2, '0')}-${String(besok.getDate()).padStart(2, '0')}`;
  (state.bookings || []).forEach(b => {
    if (b.status !== 'dipesan' || b.tglMulai !== besokStr) return;
    alerts.push({ id: 'booking-h1-' + b.id, ic: '📅', level: 'warn', judul: 'Booking besok', keterangan: `${carLabel(b.carId)} — ${b.tujuan || '(tanpa tujuan)'}${b.jamMulai ? ' · ' + b.jamMulai : ''}` });
  });

  alerts.sort((a, b) => (a.level === 'danger' ? 0 : 1) - (b.level === 'danger' ? 0 : 1));
  return alerts;
}

/* ============================================================================
   ---- Jam Sunyi (v3.102.0) ----
   Kalau diaktifkan (state.notifSettings.quietHoursEnabled): notifikasi level
   "warn" (biasa) DITUNDA ke pengecekan berikutnya selama masih dalam rentang
   jam sunyi -- notifikasi level "danger" (mendesak) TETAP terkirim kapan pun,
   tidak pernah ditunda, karena sifatnya darurat.
   ============================================================================ */
function isWithinQuietHours(ns) {
  if (!ns.quietHoursEnabled) return false;
  const jakartaHM = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit' });
  const [nowH, nowM] = jakartaHM.split(':').map(Number);
  const nowMin = nowH * 60 + nowM;
  const [startH, startM] = (ns.quietHoursStart || '22:00').split(':').map(Number);
  const [endH, endM] = (ns.quietHoursEnd || '06:00').split(':').map(Number);
  const startMin = startH * 60 + startM;
  const endMin = endH * 60 + endM;
  // Rentang yang melewati tengah malam (mis. 22:00 -> 06:00) butuh logika OR,
  // bukan AND, karena "malam" itu dua sisi kalender yang beda.
  if (startMin === endMin) return false; // rentang kosong (start=end) -> anggap tidak aktif
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

/* ============================================================================
   ---- Anti-spam & Riwayat berbasis notif-state.json ----
   Prinsip anti-spam: sekali sebuah id alert dinotifkan pada level tertentu,
   TIDAK dikirim ulang tiap jam selama levelnya belum NAIK (warn -> danger)
   atau belum pernah selesai lalu muncul lagi.
   v3.102.0 -- struktur file BERUBAH dari flat {id: level} jadi
   {dedup: {id: level}, history: [...]} -- dedup tetap fungsi yang sama,
   history baru: log ringkas tiap kali BENAR-BENAR ada yang terkirim (dibaca
   index.html untuk halaman "Riwayat Notifikasi"). File lama (flat, dari
   sebelum v3.102.0) tetap kebaca aman sebagai {dedup: <isi lama>, history: []}.
   ============================================================================ */
const alerts = computeAlerts();
const ns = getNotifSettings();

let prevStateRaw = {};
if (existsSync(STATE_PATH)) {
  try { prevStateRaw = JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch (e) { prevStateRaw = {}; }
}
// Deteksi format lama (flat -- tidak ada key "dedup"/"history" sama sekali,
// tapi ada isi lain) vs format baru.
const isOldFlatFormat = prevStateRaw && typeof prevStateRaw === 'object' && !('dedup' in prevStateRaw) && !('history' in prevStateRaw);
const prevDedup = isOldFlatFormat ? prevStateRaw : (prevStateRaw.dedup || {});
const prevHistory = Array.isArray(prevStateRaw.history) ? prevStateRaw.history : [];
// v3.103.0 -- "newReceiptsSent" SENGAJA "let" (bukan "const") dan diisi
// SEBELUM persistState() didefinisikan -- supaya fungsi persistState() di
// bawah (dipanggil dari BANYAK titik keluar berbeda di alur alert) SELALU
// menulis nilai receiptsSent yang TERBARU, apa pun jalur keluarnya. Kalau
// ini ditulis terpisah/belakangan, berisiko baris kode yang lebih dulu
// selesai malah MENIMPA hasil kirim resi yang baru saja disimpan.
let newReceiptsSent = Array.isArray(prevStateRaw.receiptsSent) ? prevStateRaw.receiptsSent : [];

const LEVEL_RANK = { warn: 1, danger: 2 };
const toSendCandidates = alerts.filter(a => {
  const prevLevel = prevDedup[a.id];
  if (!prevLevel) return true; // masalah baru (atau baru muncul lagi setelah sempat selesai)
  return LEVEL_RANK[a.level] > LEVEL_RANK[prevLevel]; // dikirim lagi cuma kalau levelnya naik
});

const inQuietHours = isWithinQuietHours(ns);
const suppressedByQuietHours = inQuietHours ? toSendCandidates.filter(a => a.level !== 'danger') : [];
const suppressedIds = new Set(suppressedByQuietHours.map(a => a.id));
const toSend = toSendCandidates.filter(a => !suppressedIds.has(a.id));

if (suppressedByQuietHours.length > 0) {
  console.log(`🌙 Jam sunyi aktif (${ns.quietHoursStart}–${ns.quietHoursEnd} WIB) -- ${suppressedByQuietHours.length} notifikasi level "warn" ditunda ke pengecekan berikutnya (bukan hilang).`);
}

// dedup BARU: alert yang DISUPRES jam sunyi SENGAJA TIDAK diperbarui levelnya
// (biarkan tetap seperti dedup LAMA, atau kosong kalau memang belum pernah
// ada) -- supaya begitu jam sunyi berakhir, alert itu masih dianggap "baru"
// dan BENAR terkirim, bukan malah dianggap "sudah" cuma karena levelnya
// sempat tercatat padahal belum benar-benar terkirim.
const newDedup = {};
alerts.forEach(a => {
  if (suppressedIds.has(a.id)) {
    if (prevDedup[a.id]) newDedup[a.id] = prevDedup[a.id];
    return;
  }
  newDedup[a.id] = a.level;
});

function persistState(historyEntry) {
  const newHistory = historyEntry ? [historyEntry, ...prevHistory].slice(0, 100) : prevHistory; // cap 100 entri terakhir
  const stateDir = dirname(STATE_PATH);
  if (stateDir && !existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ dedup: newDedup, history: newHistory, receiptsSent: newReceiptsSent }, null, 2) + '\n');
}

/* ============================================================================
   ---- Auto-kirim Tanda Terima Perjalanan (v3.103.0) ----
   Dijalankan SEBELUM alur alert manapun sempat process.exit(), supaya TIDAK
   PERNAH terlewat cuma karena kebetulan tidak ada alert baru saat itu.
   Trip yang sudah "selesai", sopirnya punya Telegram Chat ID, dan BELUM
   pernah dikirimi resi (dicek lewat newReceiptsSent) -- dikirimi 1 pesan
   teks terformat langsung ke sopir itu SAJA (bukan siaran ke semua).
   CATATAN JUJUR: karena script ini jalan per-jam (cron), resi ini BISA
   telat sampai ~1 jam setelah trip ditandai selesai -- bukan instan.
   ============================================================================ */
const receiptsSentSet = new Set(newReceiptsSent);
const tripsNeedingReceipt = state.usage.filter(u =>
  u.status === 'selesai' && !receiptsSentSet.has(u.id) &&
  (() => { const d = state.drivers.find(x => x.id === u.driverId); return d && (d.telegramChatId || '').toString().trim(); })()
);
if (tripsNeedingReceipt.length > 0) {
  console.log(`🧾 ${tripsNeedingReceipt.length} resi perjalanan baru untuk dikirim...`);
  for (const u of tripsNeedingReceipt) {
    const driver = state.drivers.find(x => x.id === u.driverId);
    const chatId = (driver.telegramChatId || '').toString().trim();
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: buildTripReceiptText(u), parse_mode: 'HTML' })
      });
      const resBody = await res.json().catch(() => ({}));
      if (!res.ok || !resBody.ok) {
        console.error(`❌ Gagal kirim resi trip ${u.id} ke ${driver.nama} (${chatId}):`, JSON.stringify(resBody));
        continue; // JANGAN masuk newReceiptsSent kalau gagal -- coba lagi jam berikutnya
      }
      newReceiptsSent = [...newReceiptsSent, u.id].slice(-500); // cap 500 id terakhir, cukup besar utk riwayat trip yg wajar
      console.log(`✅ Resi trip ${u.id} terkirim ke ${driver.nama}.`);
    } catch (e) {
      console.error(`❌ Gagal kirim resi trip ${u.id} ke ${driver.nama} (${chatId}):`, e.message);
    }
  }
}

if (toSend.length === 0) {
  persistState(null); // tetap simpan dedup terbaru (termasuk yg levelnya turun/hilang), cuma tidak ada histori baru
  console.log(`✅ Tidak ada notifikasi baru untuk dikirim (${alerts.length} masalah aktif, semua sudah pernah dinotifkan pada level yang sama${suppressedByQuietHours.length > 0 ? ', sisanya ditunda jam sunyi' : ''}).`);
  process.exit(0);
}

// ---- Kumpulkan penerima: semua sopir yang "Telegram Chat ID"-nya diisi di
// menu Data Sopir + (opsional) 1 admin lewat Secret TELEGRAM_CHAT_ID ----
const recipients = new Map(); // chatId -> { label, driver } -- driver null utk Admin (Secret), dapat SEMUA kategori tanpa filter
if (ADMIN_CHAT_ID) recipients.set(ADMIN_CHAT_ID, { label: 'Admin (Secret)', driver: null });
state.drivers.forEach(d => {
  const cid = (d.telegramChatId || '').toString().trim();
  if (cid) recipients.set(cid, { label: d.nama || 'Sopir', driver: d });
});

if (recipients.size === 0) {
  persistState(null); // dedup tetap disimpan walau tidak ada penerima -- supaya tidak menumpuk jadi kiriman besar sekaligus begitu ada sopir baru daftar nanti
  console.log(`⚠️  Ada ${toSend.length} notifikasi baru, tapi belum ada satu pun sopir yang mengisi "Telegram Chat ID" di menu Data Sopir (dan TELEGRAM_CHAT_ID Secret juga kosong). Tidak ada yang dikirim.`);
  process.exit(0);
}

/* ============================================================================
   ---- Susun & kirim pesan Telegram (PER PENERIMA -- v3.103.0) ----
   Isi pesan bisa BEDA-BEDA tiap penerima sekarang, tergantung kategori yang
   dia langgan (lihat alertsForDriver di atas) -- makanya pesan disusun DI
   DALAM loop kirim, bukan 1x di luar seperti sebelumnya.
   ============================================================================ */
function escapeHtmlTg(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}
function buildAlertMessageText(items) {
  const danger = items.filter(a => a.level === 'danger');
  const warn = items.filter(a => a.level === 'warn');
  const lines = ['🚨 <b>FleetOps — Perlu Perhatian</b>', ''];
  function addGroup(list, heading) {
    if (list.length === 0) return;
    lines.push(heading);
    list.forEach(a => {
      lines.push(`${a.ic} <b>${escapeHtmlTg(a.judul)}</b>`);
      lines.push(`   ${escapeHtmlTg(a.keterangan)}`);
    });
    lines.push('');
  }
  addGroup(danger, '🔴 <b>Mendesak</b>');
  addGroup(warn, '🟡 <b>Perlu Diperhatikan</b>');
  lines.push(`<i>Dikirim otomatis ${new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })} WIB</i>`);
  return lines.join('\n').trim();
}

let sukses = 0;
let gagal = 0;
let dilewati = 0; // penerima yang TIDAK dikirimi karena tidak ada 1 pun alert yang cocok kategori langganannya
for (const [chatId, { label, driver }] of recipients) {
  const alertsForThis = driver ? alertsForDriver(toSend, driver) : toSend;
  if (alertsForThis.length === 0) {
    dilewati++;
    continue; // tidak ada yang relevan buat langganan kategori penerima ini -- tidak usah kirim pesan kosong
  }
  const text = buildAlertMessageText(alertsForThis);
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const resBody = await res.json().catch(() => ({}));
    if (!res.ok || !resBody.ok) {
      // Jangan hentikan penerima lain cuma karena 1 gagal (mis. sopir belum
      // pernah chat ke bot, atau blokir bot) -- log saja & lanjut.
      console.error(`❌ Gagal kirim ke ${label} (${chatId}):`, JSON.stringify(resBody));
      gagal++;
      continue;
    }
    sukses++;
  } catch (e) {
    console.error(`❌ Gagal kirim ke ${label} (${chatId}):`, e.message);
    gagal++;
  }
}

console.log(`✅ Terkirim ke ${sukses}/${recipients.size} penerima (${toSend.length} notifikasi baru dari total ${alerts.length} masalah aktif)${dilewati>0 ? `, ${dilewati} dilewati (tidak ada yang cocok kategori langganannya)` : ''}.`);

// v3.102.0 -- Riwayat Notifikasi: catat ringkas apa yang BENAR-BENAR terkirim
// kali ini (dibaca index.html untuk halaman "Riwayat Notifikasi"). Cuma isi
// judul+level (bukan keterangan lengkap) supaya file tidak membengkak --
// detail lengkapnya tetap bisa dilihat via alert yang sama di lonceng app.
persistState({
  waktu: Date.now(),
  items: toSend.map(a => ({ judul: a.judul, level: a.level })),
  penerimaSukses: sukses,
  penerimaGagal: gagal,
});

if (sukses === 0) process.exit(1); // semua penerima gagal -> tandai job Actions ini gagal, biar kelihatan di tab Actions

