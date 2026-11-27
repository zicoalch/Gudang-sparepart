// Gudang Sparepart — standalone server (Node.js + SQLite)
// Jalankan:  PORT=3000 node server.js   (DB_PATH opsional, default ./data/gudang.db)
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const Jimp = require('jimp');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'gudang.db');
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  barcode TEXT DEFAULT '',
  fd_code TEXT DEFAULT '',
  stock INTEGER NOT NULL DEFAULT 0,
  rack TEXT DEFAULT '',
  unit TEXT DEFAULT 'PCS',
  shelf TEXT DEFAULT '',
  jolly_box TEXT DEFAULT '',
  category TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_fd ON items(fd_code);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('in','out','adjust')),
  qty INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  machine TEXT DEFAULT '',
  taken_by TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_item ON moves(item_id, date, id);
CREATE INDEX IF NOT EXISTS idx_moves_date ON moves(date, id);
`);

// migrasi: kolom sidik foto (perceptual hash + histogram warna) untuk "Cari pakai Foto"
for (const col of ['photo_hash TEXT DEFAULT \'\'', 'photo_hist TEXT DEFAULT \'\'']) {
  const name = col.split(' ')[0];
  const has = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('items') WHERE name = ?").get(name).c;
  if (!has) db.exec('ALTER TABLE items ADD COLUMN ' + col);
}

// ---------- helpers ----------
const LOW_STOCK = 5; // stok <= 5 (dan > 0) dianggap menipis
function nowIso() { return new Date().toISOString(); }
function todayLocal() {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function withTx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}
function ok(res, data) { return res.json(Object.assign({ ok: true }, data || {})); }
function fail(res, status, msg) { return res.status(status).json({ ok: false, error: msg }); }

function getSessionAccount(req) {
  const cookies = parseCookies(req);
  const token = cookies.gs_session;
  if (!token) return null;
  const row = db.prepare('SELECT s.*, a.username, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?').get(token);
  if (!row) return null;
  if (row.expires_at < nowIso()) { db.prepare('DELETE FROM sessions WHERE id = ?').run(token); return null; }
  return { id: row.account_id, username: row.username, role: row.role };
}
function requireAuth(req, res, next) {
  const acc = getSessionAccount(req);
  if (!acc) return fail(res, 401, 'Belum login. Silakan login dulu.');
  req.account = acc;
  next();
}
function requireAdmin(req, res, next) {
  if (req.account.role !== 'admin') return fail(res, 403, 'Hanya Admin yang boleh melakukan ini.');
  next();
}
function upperName(s) { return String(s || '').trim().toUpperCase(); }
function cleanStr(s) { return String(s == null ? '' : s).trim(); }

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// raw body untuk upload file impor (.xlsx/.csv)
app.use('/api/import/upload', express.raw({ type: '*/*', limit: '25mb' }));

// ---------- status / setup / auth ----------
app.get('/api/status', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
  ok(res, { setupNeeded: n === 0, loggedIn: !!getSessionAccount(req) });
});

app.post('/api/setup', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
  if (n > 0) return fail(res, 400, 'Admin sudah dibuat. Gunakan layar login.');
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || password);
  if (password.length < 4) return fail(res, 400, 'Password minimal 4 karakter.');
  if (password !== confirm) return fail(res, 400, 'Konfirmasi password tidak cocok.');
  const salt = newSalt();
  db.prepare('INSERT INTO accounts (username, password_hash, salt, role, created_at) VALUES (?,?,?,? ,?)')
    .run('zico', hashPassword(password, salt), salt, 'admin', nowIso());
  ok(res, { message: 'Akun Admin zico berhasil dibuat. Silakan login.' });
});

app.post('/api/login', (req, res) => {
  const username = cleanStr(req.body.username).toLowerCase();
  const password = String(req.body.password || '');
  const acc = db.prepare('SELECT * FROM accounts WHERE lower(username) = ?').get(username);
  if (!acc || hashPassword(password, acc.salt) !== acc.password_hash) {
    return fail(res, 401, 'Username atau password salah.');
  }
  const token = newToken();
  const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, acc.id, nowIso(), exp);
  res.cookie('gs_session', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 3600 * 1000 });
  ok(res, { username: acc.username, role: acc.role });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = parseCookies(req).gs_session;
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
  res.clearCookie('gs_session', { path: '/' });
  ok(res, {});
});

app.get('/api/me', requireAuth, (req, res) => ok(res, { username: req.account.username, role: req.account.role }));

// ganti password sendiri
app.post('/api/change-password', requireAuth, (req, res) => {
  const oldPw = String(req.body.oldPassword || '');
  const newPw = String(req.body.newPassword || '');
  if (newPw.length < 4) return fail(res, 400, 'Password baru minimal 4 karakter.');
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.account.id);
  if (hashPassword(oldPw, acc.salt) !== acc.password_hash) return fail(res, 400, 'Password lama salah.');
  const salt = newSalt();
  db.prepare('UPDATE accounts SET password_hash = ?, salt = ? WHERE id = ?').run(hashPassword(newPw, salt), salt, acc.id);
  // cabut semua sesi lain milik akun ini (sesi saat ini tetap jalan)
  const token = parseCookies(req).gs_session;
  db.prepare('DELETE FROM sessions WHERE account_id = ? AND id != ?').run(acc.id, token || '');
  ok(res, { message: 'Password berhasil diganti.' });
});

// ---------- manajemen akun (admin) ----------
app.get('/api/accounts', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, username, role, created_at FROM accounts ORDER BY id').all();
  ok(res, { accounts: rows });
});

app.post('/api/accounts', requireAuth, requireAdmin, (req, res) => {
  const username = cleanStr(req.body.username).toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) return fail(res, 400, 'Username 3–30 karakter: huruf kecil, angka, titik, _ atau -.');
  if (password.length < 4) return fail(res, 400, 'Password minimal 4 karakter.');
  const exists = db.prepare('SELECT id FROM accounts WHERE lower(username) = ?').get(username);
  if (exists) return fail(res, 400, 'Username sudah dipakai.');
  const salt = newSalt();
  const r = db.prepare('INSERT INTO accounts (username, password_hash, salt, role, created_at) VALUES (?,?,?,?,?)')
    .run(username, hashPassword(password, salt), salt, role, nowIso());
  ok(res, { id: r.lastInsertRowid, username, role });
});

app.post('/api/accounts/:id/password', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const newPw = String(req.body.password || '');
  if (newPw.length < 4) return fail(res, 400, 'Password baru minimal 4 karakter.');
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!acc) return fail(res, 404, 'Akun tidak ditemukan.');
  const salt = newSalt();
  db.prepare('UPDATE accounts SET password_hash = ?, salt = ? WHERE id = ?').run(hashPassword(newPw, salt), salt, id);
  db.prepare('DELETE FROM sessions WHERE account_id = ?').run(id);
  ok(res, { message: 'Password akun ' + acc.username + ' berhasil diganti.' });
});

app.delete('/api/accounts/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!acc) return fail(res, 404, 'Akun tidak ditemukan.');
  if (acc.role === 'admin') return fail(res, 400, 'Akun Admin tidak bisa dihapus.');
  if (acc.id === req.account.id) return fail(res, 400, 'Tidak bisa menghapus akun sendiri.');
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  ok(res, { message: 'Akun ' + acc.username + ' dihapus.' });
});

// ---------- dashboard / statistik ----------
app.get('/api/stats', requireAuth, (req, res) => {
  const items = db.prepare('SELECT COUNT(*) c FROM items').get().c;
  const units = db.prepare('SELECT COALESCE(SUM(stock),0) s FROM items').get().s;
  const low = db.prepare('SELECT COUNT(*) c FROM items WHERE stock > 0 AND stock <= ?').get(LOW_STOCK).c;
  const out = db.prepare('SELECT COUNT(*) c FROM items WHERE stock <= 0').get().c;
  const racks = db.prepare("SELECT COUNT(DISTINCT rack) c FROM items WHERE rack IS NOT NULL AND trim(rack) != ''").get().c;
  const boxes = db.prepare("SELECT COUNT(DISTINCT jolly_box) c FROM items WHERE jolly_box IS NOT NULL AND trim(jolly_box) != ''").get().c;
  const withPhoto = db.prepare("SELECT COUNT(*) c FROM items WHERE photo IS NOT NULL AND trim(photo) != ''").get().c;
  ok(res, { items, units, low, out, racks, boxes, withPhoto });
});

// ---------- YOI / MOI ----------
// MOI (Months of Inventory) = stok saat ini / rata-rata pemakaian per bulan.
// YOI (Years of Inventory) = MOI / 12.
// Rata-rata pemakaian = total pengambilan (kind='out') dibagi jumlah bulan sejak
// pengambilan pertama tercatat. 1 bulan = 30 hari, dibulatkan ke atas, minimal 1 bulan.
// Koreksi opname impor Excel bukan pemakaian, jadi tidak dihitung.
function usageStats(itemId, stock) {
  const row = db.prepare(`SELECT COALESCE(SUM(qty),0) AS total_out, MIN(date) AS first_date
    FROM moves WHERE item_id = ? AND kind = 'out' AND note != 'Opname impor Excel'`).get(itemId);
  const totalOut = row.total_out || 0;
  if (!totalOut || !row.first_date) {
    return { hasHistory: false, totalOut: 0, months: 0, avgPerMonth: 0, moi: null, yoi: null, firstDate: null };
  }
  const first = new Date(row.first_date + 'T00:00:00');
  const today = new Date(todayLocal() + 'T00:00:00');
  const days = Math.max(0, Math.round((today - first) / 86400000));
  const months = Math.max(1, Math.ceil(days / 30));
  const avgPerMonth = totalOut / months;
  const moi = avgPerMonth > 0 ? stock / avgPerMonth : null;
  return { hasHistory: true, totalOut, months, avgPerMonth, moi, yoi: moi == null ? null : moi / 12, firstDate: row.first_date };
}

// ---------- cari pakai foto (perceptual hash + histogram warna) ----------
// Sidik foto: dHash 64-bit (grayscale 9x8, bandingkan piksel bersebelahan) +
// histogram warna 64 bin (kuantisasi 4 level per kanal RGB, ternormalisasi).
// Skor kemiripan = 0.4 * (1 - hamming/64) + 0.6 * irisan histogram.
// Ambang "cukup mirip": 0.60 (dikalibrasi: foto sama persis = 1.00, foto sama
// di-crop/diputar ≈ 0.64–0.65, foto tak berhubungan ≈ 0.37–0.46).
const PHOTO_SIM_THRESHOLD = 0.6;
async function computePhotoSignature(buf) {
  const img = await Jimp.read(buf);
  const g = img.clone().resize(9, 8).grayscale();
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = Jimp.intToRGBA(g.getPixelColor(x, y)).r;
      const b = Jimp.intToRGBA(g.getPixelColor(x + 1, y)).r;
      hash = (hash << 1n) | (a > b ? 1n : 0n);
    }
  }
  const h = img.clone().resize(32, 32);
  const bins = new Array(64).fill(0);
  h.scan(0, 0, h.bitmap.width, h.bitmap.height, function (x, y, idx) {
    const r = this.bitmap.data[idx] >> 6, gg = this.bitmap.data[idx + 1] >> 6, b = this.bitmap.data[idx + 2] >> 6;
    bins[(r << 4) | (gg << 2) | b]++;
  });
  const total = h.bitmap.width * h.bitmap.height;
  return { hash: hash.toString(16).padStart(16, '0'), hist: bins.map((v) => v / total) };
}
function signatureFromDataUri(dataUri) {
  const m = /^data:image\/[a-zA-Z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUri || '').trim());
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}
async function signatureForPhoto(dataUri) {
  const buf = signatureFromDataUri(dataUri);
  if (!buf) return null;
  try { return await computePhotoSignature(buf); } catch (_) { return null; }
}
function hammingHex(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}
function photoScore(query, stored) {
  const ham = hammingHex(query.hash, stored.hash);
  const hist = JSON.parse(stored.hist);
  let inter = 0;
  for (let i = 0; i < 64; i++) inter += Math.min(query.hist[i], hist[i]);
  return 0.4 * (1 - ham / 64) + 0.6 * inter;
}
// Backfill bertahap: hitung sidik untuk barang berfoto yang belum punya hash.
// Dibatasi 25 per panggilan supaya satu request tidak terlalu lama; foto yang
// gagal di-decode ditandai 'ERR' agar tidak diulang terus. Kembalikan jumlah
// yang masih tertunda.
async function backfillPhotoHashes() {
  const rows = db.prepare("SELECT id, photo FROM items WHERE photo != '' AND (photo_hash IS NULL OR photo_hash = '') LIMIT 25").all();
  for (const r of rows) {
    const sig = await signatureForPhoto(r.photo);
    if (sig) db.prepare('UPDATE items SET photo_hash = ?, photo_hist = ? WHERE id = ?').run(sig.hash, JSON.stringify(sig.hist), r.id);
    else db.prepare("UPDATE items SET photo_hash = 'ERR' WHERE id = ?").run(r.id);
  }
  return db.prepare("SELECT COUNT(*) c FROM items WHERE photo != '' AND (photo_hash IS NULL OR photo_hash = '')").get().c;
}

// ---------- barang ----------
function itemRow(r) {
  return {
    id: r.id, name: r.name, barcode: r.barcode || '', fd_code: r.fd_code || '',
    stock: r.stock, rack: r.rack || '', unit: r.unit || 'PCS', shelf: r.shelf || '',
    jolly_box: r.jolly_box || '', category: r.category || '', notes: r.notes || '',
    hasPhoto: !!r.photo, created_at: r.created_at, updated_at: r.updated_at,
    usage: usageStats(r.id, r.stock),
  };
}

app.get('/api/items', requireAuth, (req, res) => {
  const q = cleanStr(req.query.search || '');
  const filter = req.query.filter || 'all'; // all | low | out
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = Math.min(100, Math.max(10, parseInt(req.query.perPage || '50', 10)));
  const where = [];
  const params = [];
  if (q) {
    where.push('(name LIKE ? OR barcode LIKE ? OR fd_code LIKE ? OR rack LIKE ? OR jolly_box LIKE ?)');
    const like = '%' + q + '%';
    params.push(like, like, like, like, like);
  }
  if (filter === 'low') where.push('stock > 0 AND stock <= ' + LOW_STOCK);
  if (filter === 'out') where.push('stock <= 0');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) c FROM items ' + w).get(...params).c;
  const rows = db.prepare(`SELECT * FROM items ${w} ORDER BY name ASC LIMIT ? OFFSET ?`).all(...params, perPage, (page - 1) * perPage);
  ok(res, { items: rows.map(itemRow), total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) });
});

app.get('/api/items/lookup', requireAuth, (req, res) => {
  const code = cleanStr(req.query.code || '');
  if (!code) return fail(res, 400, 'Kode kosong.');
  const row = db.prepare('SELECT * FROM items WHERE fd_code = ? OR barcode = ? LIMIT 1').get(code, code);
  if (!row) return fail(res, 404, 'Barang dengan kode "' + code + '" tidak ditemukan.');
  ok(res, { item: itemRow(row) });
});

app.get('/api/items/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) return fail(res, 404, 'Barang tidak ditemukan.');
  const item = itemRow(row);
  if (row.photo) item.photo = row.photo;
  // kartu stok: pergerakan dikelompokkan per tanggal (terbaru dulu)
  const moves = db.prepare('SELECT * FROM moves WHERE item_id = ? ORDER BY date DESC, id DESC').all(id);
  const byDate = {};
  for (const m of moves) {
    if (!byDate[m.date]) byDate[m.date] = { date: m.date, rows: [], endBalance: null };
    byDate[m.date].rows.push({
      id: m.id, kind: m.kind, qty: m.qty, balance: m.balance,
      machine: m.machine || '', taken_by: m.taken_by || '', note: m.note || '', created_at: m.created_at,
    });
  }
  // saldo akhir hari = balance dari pergerakan pertama hari itu (id terbesar = terakhir terjadi)
  for (const d of Object.keys(byDate)) {
    const rows = byDate[d].rows;
    byDate[d].endBalance = rows.length ? rows[0].balance : 0;
    byDate[d].rows.sort((a, b) => b.id - a.id);
  }
  const card = Object.values(byDate).sort((a, b) => (a.date < b.date ? 1 : -1));
  ok(res, { item, card });
});

function validateItemInput(b) {
  const name = upperName(b.name);
  if (!name) return { error: 'Nama sparepart wajib diisi.' };
  const stock = parseInt(b.stock, 10);
  if (isNaN(stock) || stock < 0) return { error: 'Stok harus angka 0 atau lebih.' };
  let photo = '';
  if (b.photo) {
    if (typeof b.photo !== 'string' || !b.photo.startsWith('data:image/')) return { error: 'Foto tidak valid.' };
    if (b.photo.length > 1500000) return { error: 'Foto terlalu besar (maks ~1 MB setelah dikompres).' };
    photo = b.photo;
  }
  return {
    data: {
      name, barcode: cleanStr(b.barcode), fd_code: cleanStr(b.fd_code),
      stock, rack: cleanStr(b.rack), unit: cleanStr(b.unit) || 'PCS',
      shelf: cleanStr(b.shelf), jolly_box: cleanStr(b.jolly_box),
      category: cleanStr(b.category), notes: cleanStr(b.notes), photo,
    },
  };
}

app.post('/api/items', requireAuth, requireAdmin, async (req, res) => {
  const v = validateItemInput(req.body);
  if (v.error) return fail(res, 400, v.error);
  const d = v.data;
  // sidik foto dihitung sekali saat foto diunggah
  const sig = d.photo ? await signatureForPhoto(d.photo) : null;
  const r = withTx(() => {
    const ins = db.prepare(`INSERT INTO items (name, barcode, fd_code, stock, rack, unit, shelf, jolly_box, category, notes, photo, photo_hash, photo_hist, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(d.name, d.barcode, d.fd_code, d.stock, d.rack, d.unit, d.shelf, d.jolly_box, d.category, d.notes, d.photo, sig ? sig.hash : '', sig ? JSON.stringify(sig.hist) : '', nowIso(), nowIso());
    if (d.stock > 0) {
      db.prepare(`INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(ins.lastInsertRowid, todayLocal(), 'in', d.stock, d.stock, '', '', 'Stok awal', nowIso());
    }
    return ins.lastInsertRowid;
  });
  ok(res, { id: r });
});

app.put('/api/items/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) return fail(res, 404, 'Barang tidak ditemukan.');
  const v = validateItemInput(req.body);
  if (v.error) return fail(res, 400, v.error);
  const d = v.data;
  // ATURAN PENTING: tanpa foto baru, foto lama TIDAK BOLEH hilang
  const photo = d.photo || row.photo;
  // foto baru (berbeda dari yang tersimpan) -> hitung ulang sidiknya
  let photoHash = row.photo_hash || '', photoHist = row.photo_hist || '';
  if (d.photo && d.photo !== row.photo) {
    const sig = await signatureForPhoto(d.photo);
    if (sig) { photoHash = sig.hash; photoHist = JSON.stringify(sig.hist); }
    else { photoHash = ''; photoHist = ''; }
  }
  db.prepare(`UPDATE items SET name=?, barcode=?, fd_code=?, stock=?, rack=?, unit=?, shelf=?, jolly_box=?, category=?, notes=?, photo=?, photo_hash=?, photo_hist=?, updated_at=? WHERE id=?`)
    .run(d.name, d.barcode, d.fd_code, d.stock, d.rack, d.unit, d.shelf, d.jolly_box, d.category, d.notes, photo, photoHash, photoHist, nowIso(), id);
  ok(res, { id });
});

app.delete('/api/items/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) return fail(res, 404, 'Barang tidak ditemukan.');
  db.prepare('DELETE FROM items WHERE id = ?').run(id);
  ok(res, { message: 'Barang "' + row.name + '" dihapus.' });
});

// atur stok manual (masuk/keluar) — Admin saja
app.post('/api/items/:id/adjust', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const qty = parseInt(req.body.qty, 10);
  const kind = req.body.kind === 'out' ? 'out' : 'in';
  const note = cleanStr(req.body.note) || (kind === 'in' ? 'Stok masuk' : 'Stok keluar');
  if (isNaN(qty) || qty <= 0) return fail(res, 400, 'Jumlah harus angka lebih dari 0.');
  const r = withTx(() => {
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    if (!row) return { error: 'Barang tidak ditemukan.' };
    const next = kind === 'in' ? row.stock + qty : row.stock - qty;
    if (next < 0) return { error: 'Stok tidak cukup. Sisa ' + row.stock + ', diminta ' + qty + '.' };
    db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), id);
    db.prepare(`INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, todayLocal(), kind, qty, next, '', '', note, nowIso());
    return { balance: next };
  });
  if (r.error) return fail(res, 400, r.error);
  ok(res, { balance: r.balance });
});

// ---------- pengambilan (Ambil) — semua peran yang login boleh ----------
app.post('/api/take', requireAuth, (req, res) => {
  const itemId = parseInt(req.body.itemId, 10);
  const qty = parseInt(req.body.qty, 10);
  const machine = cleanStr(req.body.machine);
  const takenBy = cleanStr(req.body.takenBy);
  if (isNaN(itemId)) return fail(res, 400, 'Barang belum dipilih.');
  if (isNaN(qty) || qty <= 0) return fail(res, 400, 'Jumlah harus angka lebih dari 0.');
  if (!takenBy) return fail(res, 400, 'Nama pemakai wajib diisi.');
  const r = withTx(() => {
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    if (!row) return { error: 'Barang tidak ditemukan.' };
    if (row.stock < qty) return { error: 'Stok tidak cukup. Sisa ' + row.stock + ', diminta ' + qty + '.' };
    const next = row.stock - qty;
    db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), itemId);
    db.prepare(`INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(itemId, todayLocal(), 'out', qty, next, machine, takenBy, 'Pengambilan', nowIso());
    return { balance: next, name: row.name };
  });
  if (r.error) return fail(res, 400, r.error);
  ok(res, { balance: r.balance, name: r.name });
});

app.get('/api/takes/recent', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT m.*, i.name AS item_name, i.fd_code FROM moves m
    JOIN items i ON i.id = m.item_id WHERE m.kind = 'out' ORDER BY m.id DESC LIMIT 20`).all();
  ok(res, { takes: rows });
});

// ---------- history ----------
app.get('/api/out-history', requireAuth, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayLocal();
  const rows = db.prepare(`SELECT m.*, i.name AS item_name, i.fd_code FROM moves m
    JOIN items i ON i.id = m.item_id WHERE m.kind = 'out' AND m.date = ? ORDER BY m.id ASC`).all(date);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  ok(res, { date, total, rows });
});

// ekspor Excel history pengambilan (keluar) — semua peran yang login boleh (hanya baca)
app.get('/api/history/export', requireAuth, (req, res) => {
  const date = req.query.date || '';
  let rows, label;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    rows = db.prepare(`SELECT m.*, i.name AS item_name, i.fd_code FROM moves m
      JOIN items i ON i.id = m.item_id WHERE m.kind = 'out' AND m.date = ? ORDER BY m.id ASC`).all(date);
    label = date;
  } else {
    rows = db.prepare(`SELECT m.*, i.name AS item_name, i.fd_code FROM moves m
      JOIN items i ON i.id = m.item_id WHERE m.kind = 'out' ORDER BY m.id DESC LIMIT 60`).all();
    label = '60-terakhir';
  }
  const aoa = [
    ['History Pengambilan Sparepart' + (date ? ' — ' + date : ' — 60 terakhir')],
    [],
    ['Kode FD', 'Nama Sparepart', 'Jumlah', 'Mesin', 'Nama Pengambil', 'Tanggal', 'Jam'],
  ];
  for (const m of rows) {
    aoa.push([
      m.fd_code || '', m.item_name || '', m.qty, m.machine || '', m.taken_by || '',
      m.date, m.created_at ? m.created_at.slice(11, 16) : '',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 14 }, { wch: 34 }, { wch: 9 }, { wch: 16 }, { wch: 18 }, { wch: 12 }, { wch: 8 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pengambilan');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="history-pengambilan-' + label + '.xlsx"');
  res.send(buf);
});

app.get('/api/history', requireAuth, (req, res) => {
  const date = req.query.date || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    // ringkasan harian: per barang — total masuk, total keluar, stok akhir hari
    const rows = db.prepare(`SELECT m.item_id, i.name AS item_name, i.fd_code,
        SUM(CASE WHEN m.kind='in' THEN m.qty ELSE 0 END) AS masuk,
        SUM(CASE WHEN m.kind='out' THEN m.qty ELSE 0 END) AS keluar,
        MAX(m.balance) AS _b
      FROM moves m JOIN items i ON i.id = m.item_id WHERE m.date = ? GROUP BY m.item_id ORDER BY i.name`).all(date);
    // stok akhir hari = balance dari pergerakan terakhir hari itu per barang
    for (const r of rows) {
      const last = db.prepare('SELECT balance FROM moves WHERE item_id = ? AND date = ? ORDER BY id DESC LIMIT 1').get(r.item_id, date);
      r.stok_akhir = last ? last.balance : 0;
      delete r._b;
    }
    const totalMasuk = rows.reduce((s, r) => s + r.masuk, 0);
    const totalKeluar = rows.reduce((s, r) => s + r.keluar, 0);
    return ok(res, { date, mode: 'day', rows, totalMasuk, totalKeluar });
  }
  const rows = db.prepare(`SELECT m.*, i.name AS item_name, i.fd_code FROM moves m
    JOIN items i ON i.id = m.item_id ORDER BY m.id DESC LIMIT 60`).all();
  ok(res, { mode: 'recent', rows });
});

// ---------- impor Excel ----------
const importJobs = new Map(); // jobId -> {rows, filename, sheet, createdAt}

function normHeader(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/[\s._-]+/g, ' ').trim();
}
const HEADER_MAP = {
  'material description': 'name', 'nama': 'name', 'nama sparepart': 'name',
  'material': 'fd_code', 'kode fd': 'fd_code', 'fd code': 'fd_code',
  'kode fusion': 'notes', 'catatan': 'notes',
  'qty stok opname': 'stock', 'stok opname': 'stock', 'stok': 'stock', 'qty': 'stock', 'jumlah': 'stock',
  'unrestricted': 'stock_fallback',
  'location': 'rack', 'rak': 'rack', 'no rak': 'rack',
  'no rak': 'shelf', 'shaf': 'shelf', 'no shaf': 'shelf',
  'no jolly box': 'jolly_box', 'jolly box': 'jolly_box', 'no jollybox': 'jolly_box',
  'mesin': 'category', 'kategori': 'category',
  'base unit of measure': 'unit', 'satuan': 'unit', 'base unit': 'unit',
  'barcode': 'barcode',
};
function detectMapping(headers) {
  // kembalikan {field: colIndex}; 'No.Rak' di file user = shaf, 'Location' = rak
  const map = {};
  headers.forEach((h, i) => {
    const n = normHeader(h);
    if (!n) return;
    if (n === 'no rak') { map.shelf = i; return; } // No.Rak (F.1, G.1) = shaf
    const f = HEADER_MAP[n];
    if (f && map[f] === undefined) map[f] = i;
  });
  return map;
}
function parseCsvText(text) {
  const rows = [];
  let cur = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { cur.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cur.push(field); field = ''; rows.push(cur); cur = [];
    } else field += c;
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}
function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[.,\s]/g, (m, off, s) => (m === '.' && /\d{3}$/.test(s.slice(off)) ? '' : m)), 10);
  if (isNaN(n)) { const n2 = parseFloat(String(v).replace(',', '.')); return isNaN(n2) ? null : Math.trunc(n2); }
  return n;
}
function mapImportRows(rawRows, mapping) {
  const out = [];
  for (const r of rawRows) {
    const get = (f) => (mapping[f] === undefined ? '' : (r[mapping[f]] ?? ''));
    const name = upperName(get('name'));
    const fd = cleanStr(get('fd_code'));
    let stock = toInt(get('stock'));
    if (stock == null) stock = toInt(get('stock_fallback'));
    if (stock == null) stock = 0;
    const row = {
      name, fd_code: fd, barcode: cleanStr(get('barcode')),
      stock: Math.max(0, stock), rack: cleanStr(get('rack')),
      unit: cleanStr(get('unit')) || 'PCS', shelf: cleanStr(get('shelf')),
      jolly_box: cleanStr(get('jolly_box')), category: cleanStr(get('category')),
      notes: cleanStr(get('notes')),
    };
    const empty = !row.name && !row.fd_code && !row.barcode;
    const valid = !!row.name;
    out.push(Object.assign(row, { valid, empty, error: valid ? '' : 'Nama kosong' }));
  }
  return out;
}

// langkah 1: upload file -> daftar sheet + header + mapping per sheet
app.post('/api/import/upload', requireAuth, requireAdmin, (req, res) => {
  const buf = req.body;
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return fail(res, 400, 'File kosong.');
  const filename = cleanStr(req.query.filename || 'file');
  const isZip = buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  const isCsv = /\.csv$/i.test(filename) || !isZip;
  try {
    let sheets = [];
    if (isCsv) {
      const text = buf.toString('utf8');
      const rows = parseCsvText(text);
      const headers = rows[0] || [];
      sheets = [{ name: 'CSV', rows: rows.length, headers, mapping: detectMapping(headers) }];
      const jobId = newToken();
      importJobs.set(jobId, { rows: mapImportRows(rows.slice(1), sheets[0].mapping), filename, sheet: 'CSV', createdAt: Date.now() });
      return ok(res, { jobId, sheets, filename });
    }
    const wb = XLSX.read(buf, { type: 'buffer' });
    const jobId = newToken();
    const parsed = {};
    for (const s of wb.SheetNames) {
      const ws = wb.Sheets[s];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      const headers = (rows[0] || []).map((h) => (h == null ? '' : String(h)));
      const mapping = detectMapping(headers);
      parsed[s] = mapImportRows(rows.slice(1), mapping);
      sheets.push({ name: s, rows: rows.length, headers, mapping });
    }
    importJobs.set(jobId, { sheets: parsed, filename, createdAt: Date.now() });
    ok(res, { jobId, sheets, filename });
  } catch (e) {
    return fail(res, 400, 'File tidak bisa dibaca sebagai Excel/CSV: ' + e.message);
  }
});

// langkah 2: preview sheet yang dipilih
app.post('/api/import/preview', requireAuth, requireAdmin, (req, res) => {
  const { jobId, sheet } = req.body;
  const job = importJobs.get(jobId);
  if (!job) return fail(res, 400, 'Sesi impor tidak ditemukan. Upload ulang filenya.');
  let rows;
  if (job.sheets) {
    if (!job.sheets[sheet]) return fail(res, 400, 'Sheet tidak ditemukan.');
    rows = job.sheets[sheet];
    job.sheet = sheet;
  } else rows = job.rows;
  const valid = rows.filter((r) => r.valid).length;
  const invalid = rows.filter((r) => !r.valid && !r.empty).length;
  const empty = rows.filter((r) => r.empty).length;
  // hitung duplikat berdasarkan Kode FD yang sudah ada di database
  const fdSet = new Set(rows.filter((r) => r.valid && r.fd_code).map((r) => r.fd_code));
  let dup = 0;
  if (fdSet.size) {
    const placeholders = [...fdSet].map(() => '?').join(',');
    dup = db.prepare(`SELECT COUNT(*) c FROM items WHERE fd_code IN (${placeholders})`).get(...fdSet).c;
  }
  ok(res, {
    total: rows.length, valid, invalid, empty, duplicates: dup,
    sample: rows.filter((r) => r.valid).slice(0, 8),
    invalidSample: rows.filter((r) => !r.valid && !r.empty).slice(0, 5),
  });
});

// langkah 3: impor bertahap (batch) — dipanggil berulang oleh client sampai done
app.post('/api/import/batch', requireAuth, requireAdmin, (req, res) => {
  const { jobId, mode, offset } = req.body;
  const job = importJobs.get(jobId);
  if (!job) return fail(res, 400, 'Sesi impor tidak ditemukan. Upload ulang filenya.');
  const rows = job.sheets ? (job.sheets[job.sheet || Object.keys(job.sheets)[0]] || []) : job.rows;
  const off = Math.max(0, parseInt(offset || '0', 10));
  const BATCH = 200;
  const chunk = rows.slice(off, off + BATCH);
  const dupMode = mode === 'update' ? 'update' : 'skip';
  let inserted = 0, updated = 0, skipped = 0;
  withTx(() => {
    for (const r of chunk) {
      if (!r.valid) { skipped++; continue; }
      let existing = null;
      if (r.fd_code) existing = db.prepare('SELECT * FROM items WHERE fd_code = ?').get(r.fd_code);
      if (!existing && r.name) existing = db.prepare('SELECT * FROM items WHERE name = ? AND (fd_code IS NULL OR fd_code = ?)').get(r.name, '');
      if (existing) {
        if (dupMode === 'skip') { skipped++; continue; }
        // mode opname: update stok + catat selisih di history; foto TIDAK disentuh
        const diff = r.stock - existing.stock;
        db.prepare(`UPDATE items SET stock=?, rack=?, unit=?, shelf=?, jolly_box=?, category=?, notes=?, updated_at=? WHERE id=?`)
          .run(r.stock, r.rack || existing.rack, r.unit, r.shelf || existing.shelf, r.jolly_box || existing.jolly_box, r.category || existing.category, r.notes || existing.notes, nowIso(), existing.id);
        if (diff !== 0) {
          db.prepare(`INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(existing.id, todayLocal(), diff > 0 ? 'in' : 'out', Math.abs(diff), r.stock, '', '', 'Opname impor Excel', nowIso());
        }
        updated++;
      } else {
        const ins = db.prepare(`INSERT INTO items (name, barcode, fd_code, stock, rack, unit, shelf, jolly_box, category, notes, photo, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?)`)
          .run(r.name, r.barcode, r.fd_code, r.stock, r.rack, r.unit, r.shelf, r.jolly_box, r.category, r.notes, '', nowIso(), nowIso());
        if (r.stock > 0) {
          db.prepare(`INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(ins.lastInsertRowid, todayLocal(), 'in', r.stock, r.stock, '', '', 'Stok awal (impor Excel)', nowIso());
        }
        inserted++;
      }
    }
  });
  const done = off + chunk.length >= rows.length;
  if (done) importJobs.delete(jobId);
  ok(res, { done, processed: Math.min(off + chunk.length, rows.length), total: rows.length, inserted, updated, skipped });
});

// template kosong
app.get('/api/template', requireAuth, requireAdmin, (req, res) => {
  const headers = ['Plant', 'Storage location', 'Material', 'Kode Fusion', 'Material description', 'Base Unit of Measure', 'Unrestricted', 'Location', 'Mesin', 'Qty Stok Opname', 'No.Jolly Box', 'No.Rak'];
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="template-sparepart.xlsx"');
  res.send(buf);
});

// ekspor Excel kartu stok satu barang
app.get('/api/items/:id/export', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) return fail(res, 404, 'Barang tidak ditemukan.');
  const moves = db.prepare('SELECT * FROM moves WHERE item_id = ? ORDER BY date ASC, id ASC').all(id);
  const aoa = [
    ['Kartu Stok Sparepart'],
    ['Nama', row.name],
    ['Kode FD', row.fd_code || ''],
    ['Barcode', row.barcode || ''],
    ['Lokasi', [row.rack, row.shelf, row.jolly_box].filter(Boolean).join(' / ')],
    [],
    ['Tanggal', 'Keterangan', 'Masuk', 'Keluar', 'Sisa', 'Mesin', 'Diambil oleh'],
  ];
  for (const m of moves) {
    const ket = m.note || (m.kind === 'in' ? 'Stok masuk' : m.kind === 'out' ? 'Pengambilan' : 'Penyesuaian');
    aoa.push([
      m.date, ket,
      m.kind === 'in' ? m.qty : '',
      m.kind === 'out' ? m.qty : '',
      m.balance, m.machine || '', m.taken_by || '',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 18 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Kartu Stok');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const safeName = (row.name || 'barang').replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_').slice(0, 50);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="kartu-stok-' + safeName + '.xlsx"');
  res.send(buf);
});

// QR code barang — mengkodekan Kode FD (fallback ke barcode); dipakai di detail,
// lembar cetak, dan scan tab Ambil (BarcodeDetector membaca QR, lalu lookup kode)
app.get('/api/items/:id/qr', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  if (!row) return fail(res, 404, 'Barang tidak ditemukan.');
  const code = cleanStr(row.fd_code) || cleanStr(row.barcode);
  if (!code) return fail(res, 400, 'Barang ini belum punya Kode FD / barcode untuk dibuatkan QR.');
  try {
    const buf = await QRCode.toBuffer(code, { type: 'png', width: 512, margin: 1, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'inline; filename="qr-' + code.replace(/[^\w\-]+/g, '_') + '.png"');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (e) {
    return fail(res, 500, 'QR gagal dibuat: ' + e.message);
  }
});

// foto barang (thumbnail untuk hasil "Cari pakai Foto")
app.get('/api/items/:id/photo', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT photo FROM items WHERE id = ?').get(id);
  if (!row || !row.photo) return fail(res, 404, 'Barang ini belum punya foto.');
  const buf = signatureFromDataUri(row.photo);
  if (!buf) return fail(res, 404, 'Foto tidak bisa dibaca.');
  const mime = /^data:(image\/[a-zA-Z+]+);base64,/.exec(row.photo);
  res.setHeader('Content-Type', (mime && mime[1]) || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(buf);
});

// ---------- cari pakai foto ----------
// Terima foto query (data URI JPEG, sudah dikecilkan client-side), hitung sidiknya,
// bandingkan dengan sidik tersimpan, kembalikan 5 yang paling mirip.
// Barang berfoto yang belum punya sidik di-backfill bertahap (maks 25/panggilan).
app.post('/api/search/photo', requireAuth, async (req, res) => {
  const photo = req.body && req.body.photo;
  if (!photo || typeof photo !== 'string' || !photo.startsWith('data:image/')) {
    return fail(res, 400, 'Foto tidak valid.');
  }
  if (photo.length > 1500000) return fail(res, 400, 'Foto terlalu besar (maks ~1 MB setelah dikompres).');
  const query = await signatureForPhoto(photo);
  if (!query) return fail(res, 400, 'Foto tidak bisa dibaca. Coba foto lain.');
  const pendingBackfill = await backfillPhotoHashes();
  const totalItems = db.prepare('SELECT COUNT(*) c FROM items').get().c;
  const withPhoto = db.prepare("SELECT COUNT(*) c FROM items WHERE photo IS NOT NULL AND trim(photo) != ''").get().c;
  const hashed = db.prepare("SELECT COUNT(*) c FROM items WHERE photo_hash IS NOT NULL AND photo_hash != '' AND photo_hash != 'ERR'").get().c;
  const rows = db.prepare("SELECT id, name, fd_code, stock, unit, photo_hash, photo_hist FROM items WHERE photo_hash IS NOT NULL AND photo_hash != '' AND photo_hash != 'ERR'").all();
  const scored = rows.map((r) => {
    const score = photoScore(query, { hash: r.photo_hash, hist: r.photo_hist });
    return {
      id: r.id, name: r.name, fd_code: r.fd_code || '', stock: r.stock, unit: r.unit || 'PCS',
      score: Math.round(score * 1000) / 1000,
      label: score >= 0.8 ? 'Sangat mirip' : score >= PHOTO_SIM_THRESHOLD ? 'Mirip' : 'Kurang mirip',
    };
  }).sort((a, b) => b.score - a.score).slice(0, 5);
  const best = scored.length ? scored[0].score : 0;
  ok(res, {
    results: scored,
    totalItems, withPhoto, hashed, pendingBackfill,
    threshold: PHOTO_SIM_THRESHOLD,
    hasMatch: best >= PHOTO_SIM_THRESHOLD,
  });
});

// ---------- file statis + PWA ----------
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return fail(res, 404, 'API tidak ditemukan.');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Gudang Sparepart jalan di http://localhost:' + PORT);
  console.log('Database: ' + DB_PATH);
});
