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

/* ============================================================================
   ---- BAGIAN PORTING DARI index.html (JANGAN diubah rumusnya sendirian) ----
   ============================================================================ */

function today() { return new Date().toISOString().slice(0, 10); }

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

  alerts.sort((a, b) => (a.level === 'danger' ? 0 : 1) - (b.level === 'danger' ? 0 : 1));
  return alerts;
}

/* ============================================================================
   ---- Anti-spam berbasis notif-state.json ----
   Prinsip: sekali sebuah id alert dinotifkan pada level tertentu, TIDAK
   dikirim ulang tiap jam selama levelnya belum NAIK (warn -> danger) atau
   belum pernah selesai lalu muncul lagi (id hilang dari notif-state.json,
   lalu muncul lagi -> dianggap baru).
   ============================================================================ */
const alerts = computeAlerts();

let prevState = {};
if (existsSync(STATE_PATH)) {
  try { prevState = JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch (e) { prevState = {}; }
}

const LEVEL_RANK = { warn: 1, danger: 2 };
const toSend = alerts.filter(a => {
  const prevLevel = prevState[a.id];
  if (!prevLevel) return true; // masalah baru (atau baru muncul lagi setelah sempat selesai)
  return LEVEL_RANK[a.level] > LEVEL_RANK[prevLevel]; // dikirim lagi cuma kalau levelnya naik
});

const newState = {};
alerts.forEach(a => { newState[a.id] = a.level; });

const stateDir = dirname(STATE_PATH);
if (stateDir && !existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2) + '\n');

if (toSend.length === 0) {
  console.log(`✅ Tidak ada notifikasi baru untuk dikirim (${alerts.length} masalah aktif, semua sudah pernah dinotifkan pada level yang sama).`);
  process.exit(0);
}

// ---- Kumpulkan penerima: semua sopir yang "Telegram Chat ID"-nya diisi di
// menu Data Sopir + (opsional) 1 admin lewat Secret TELEGRAM_CHAT_ID ----
const recipients = new Map(); // chatId -> label (buat log, bukan dikirim ke pesan)
if (ADMIN_CHAT_ID) recipients.set(ADMIN_CHAT_ID, 'Admin (Secret)');
state.drivers.forEach(d => {
  const cid = (d.telegramChatId || '').toString().trim();
  if (cid) recipients.set(cid, d.nama || 'Sopir');
});

if (recipients.size === 0) {
  console.log(`⚠️  Ada ${toSend.length} notifikasi baru, tapi belum ada satu pun sopir yang mengisi "Telegram Chat ID" di menu Data Sopir (dan TELEGRAM_CHAT_ID Secret juga kosong). Tidak ada yang dikirim.`);
  process.exit(0);
}

/* ============================================================================
   ---- Susun & kirim pesan Telegram ----
   ============================================================================ */
function escapeHtmlTg(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

const danger = toSend.filter(a => a.level === 'danger');
const warn = toSend.filter(a => a.level === 'warn');

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

const text = lines.join('\n').trim();

let sukses = 0;
let gagal = 0;
for (const [chatId, label] of recipients) {
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

console.log(`✅ Terkirim ke ${sukses}/${recipients.size} penerima (${toSend.length} notifikasi baru dari total ${alerts.length} masalah aktif).`);
if (sukses === 0) process.exit(1); // semua penerima gagal -> tandai job Actions ini gagal, biar kelihatan di tab Actions

