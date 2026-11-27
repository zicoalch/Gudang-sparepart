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
CREATE TABLE IF NOT EXISTS so_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  counted INTEGER NOT NULL,
  system_stock INTEGER NOT NULL,
  diff INTEGER NOT NULL,
  username TEXT DEFAULT '',
  adjusted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_so_date ON so_records(date, id);
CREATE INDEX IF NOT EXISTS idx_so_item ON so_records(item_id, date);
CREATE TABLE IF NOT EXISTS tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id INTEGER REFERENCES tools(id) ON DELETE SET NULL,
  qty INTEGER NOT NULL,
  borrower TEXT NOT NULL,
  borrowed_by TEXT NOT NULL DEFAULT '',
  machine TEXT DEFAULT '',
  borrowed_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  returned_at TEXT DEFAULT '',
  returned_by TEXT DEFAULT '',
  return_photo TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'dipinjam' CHECK (status IN ('dipinjam','dikembalikan'))
);
-- Indeks loans dibuat SETELAH migrasi di bawah (skema lama belum punya tool_id).
-- Peminjaman dibawa supplier: part inventaris dibawa keluar (contoh/service),
-- mengurangi stok sementara; kembali → stok pulih; bisa ditandai tidak kembali.
-- Bisa juga untuk part NON-STOK (kode tidak ada di inventaris): dicatat manual
-- dengan item_id NULL + manual_name/manual_code, tanpa perubahan stok.
-- Jatuh tempo TIDAK disimpan — dihitung dinamis dari taken_at + setting
-- pengingat aktif (supplier_reminder_days), supaya mengubah setting langsung
-- mengevaluasi ulang semua pinjaman supplier yang masih aktif.
CREATE TABLE IF NOT EXISTS supplier_loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  manual_name TEXT DEFAULT '',
  manual_code TEXT DEFAULT '',
  qty INTEGER NOT NULL,
  supplier TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'contoh' CHECK (purpose IN ('contoh','service')),
  taken_by TEXT NOT NULL DEFAULT '',
  taken_at TEXT NOT NULL,
  returned_at TEXT DEFAULT '',
  returned_by TEXT DEFAULT '',
  return_photo TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'dibawa' CHECK (status IN ('dibawa','dikembalikan','tidak_kembali'))
);
CREATE INDEX IF NOT EXISTS idx_supplier_loans_item ON supplier_loans(item_id);
CREATE INDEX IF NOT EXISTS idx_supplier_loans_status ON supplier_loans(status, taken_at);
-- Pengaturan aplikasi (key-value). Saat ini: supplier_reminder_days (1–30, default 2).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`);

// migrasi: kolom sidik foto (perceptual hash + histogram warna) untuk "Cari pakai Foto"
for (const col of ['photo_hash TEXT DEFAULT \'\'', 'photo_hist TEXT DEFAULT \'\'']) {
  const name = col.split(' ')[0];
  const has = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('items') WHERE name = ?").get(name).c;
  if (!has) db.exec('ALTER TABLE items ADD COLUMN ' + col);
}

// migrasi loans lama (item_id -> tool_id): peminjaman tools kini berbasis nama
// tools saja, bukan barang inventaris. Tabel loans saat ini kosong di semua DB,
// jadi skema lama bisa di-drop; bila ternyata berisi data, migrasikan dengan
// membuat satu tool per nama barang yang pernah dipinjam — tidak ada pinjaman
// yang hilang.
{
  const cols = db.prepare("SELECT name FROM pragma_table_info('loans')").all().map((r) => r.name);
  if (cols.includes('item_id')) {
    const n = db.prepare('SELECT COUNT(*) c FROM loans').get().c;
    const newLoansSql = `CREATE TABLE loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER REFERENCES tools(id) ON DELETE SET NULL,
      qty INTEGER NOT NULL,
      borrower TEXT NOT NULL,
      borrowed_by TEXT NOT NULL DEFAULT '',
      machine TEXT DEFAULT '',
      borrowed_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      returned_at TEXT DEFAULT '',
      returned_by TEXT DEFAULT '',
      return_photo TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'dipinjam' CHECK (status IN ('dipinjam','dikembalikan'))
    )`;
    if (n === 0) {
      db.exec('DROP TABLE loans');
      db.exec(newLoansSql);
    } else {
      db.exec(newLoansSql.replace('CREATE TABLE loans', 'CREATE TABLE loans_new'));
      const rows = db.prepare('SELECT * FROM loans').all();
      for (const r of rows) {
        const item = db.prepare('SELECT name FROM items WHERE id = ?').get(r.item_id);
        const toolName = (item && item.name) || ('Barang #' + r.item_id);
        let tool = db.prepare('SELECT id FROM tools WHERE name = ? COLLATE NOCASE').get(toolName);
        if (!tool) tool = { id: db.prepare('INSERT INTO tools (name, created_at, created_by) VALUES (?,?,?)').run(toolName, nowIso(), 'migrasi').lastInsertRowid };
        db.prepare(`INSERT INTO loans_new (id, tool_id, qty, borrower, borrowed_by, borrowed_at, due_at, returned_at, returned_by, return_photo, status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(r.id, tool.id, r.qty, r.borrower, r.borrowed_by, r.borrowed_at, r.due_at, r.returned_at, r.returned_by, r.return_photo, r.status);
      }
      db.exec('DROP TABLE loans');
      db.exec('ALTER TABLE loans_new RENAME TO loans');
    }
    db.exec('DROP INDEX IF EXISTS idx_loans_item');
    db.exec('CREATE INDEX IF NOT EXISTS idx_loans_tool ON loans(tool_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status, due_at)');
  }
}

// migrasi: kolom mesin yang digunakan untuk peminjaman tools (opsional).
// ADD COLUMN saja — tabel loans kini berisi data user, jangan drop/recreate.
{
  const has = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('loans') WHERE name = 'machine'").get().c;
  if (!has) db.exec("ALTER TABLE loans ADD COLUMN machine TEXT DEFAULT ''");
}

// migrasi: kolom pencatat untuk pergerakan stok (dipakai detail catatan pengambilan).
// ADD COLUMN saja — tabel moves berisi data user, jangan drop/recreate.
{
  const has = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('moves') WHERE name = 'created_by'").get().c;
  if (!has) db.exec("ALTER TABLE moves ADD COLUMN created_by TEXT DEFAULT ''");
}

// Indeks loans — dibuat di sini (setelah migrasi) supaya DB lama yang skema
// loans-nya masih item_id tidak gagal saat blok CREATE TABLE di atas jalan.
db.exec('CREATE INDEX IF NOT EXISTS idx_loans_tool ON loans(tool_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status, due_at)');

// ---------- helpers ----------
const LOW_STOCK = 5; // stok <= 5 (dan > 0) dianggap menipis
function nowIso() { return new Date().toISOString(); }
function todayLocal() {
  // Tanggal kalender di WIB (Asia/Jakarta). Server jalan di UTC, sedangkan
  // pengguna di WIB — memakai tanggal server menggeser hari pada 00:00–07:00 WIB
  // sehingga catatan SO tersimpan di tanggal yang salah dan tidak muncul di daftar.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function timeWIB(iso) {
  // Jam (HH:MM) dalam WIB dari timestamp ISO (UTC). Jangan iris langsung dari
  // ISO — itu jam UTC, 7 jam lebih lambat dari WIB.
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
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
// Peminjaman tools bukan pemakaian (tools tidak tercatat di moves).
// Part yang dibawa supplier juga bukan pemakaian: "Dibawa supplier (…)"
// mengurangi stok sementara dan "Kembali dari supplier" mengembalikannya.
function usageStats(itemId, stock) {
  const row = db.prepare(`SELECT COALESCE(SUM(qty),0) AS total_out, MIN(date) AS first_date
    FROM moves WHERE item_id = ? AND kind = 'out' AND note != 'Opname impor Excel' AND note != 'Opname (SO)' AND note != 'Pinjam' AND note NOT LIKE 'Dibawa supplier%'`).get(itemId);
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
  // cocokkan tanpa peduli huruf besar/kecil (dipakai Ambil/SO + cek duplikat Kode FD di form)
  const row = db.prepare('SELECT * FROM items WHERE UPPER(fd_code) = UPPER(?) OR UPPER(barcode) = UPPER(?) LIMIT 1').get(code, code);
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
      name, barcode: upperName(b.barcode), fd_code: upperName(b.fd_code),
      stock, rack: upperName(b.rack), unit: upperName(b.unit) || 'PCS',
      shelf: upperName(b.shelf), jolly_box: upperName(b.jolly_box),
      category: upperName(b.category), notes: upperName(b.notes), photo,
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
  const note = upperName(req.body.note) || (kind === 'in' ? 'Stok masuk' : 'Stok keluar');
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
  const machine = upperName(req.body.machine);
  const takenBy = upperName(req.body.takenBy);
  if (isNaN(itemId)) return fail(res, 400, 'Barang belum dipilih.');
  if (isNaN(qty) || qty <= 0) return fail(res, 400, 'Jumlah harus angka lebih dari 0.');
  if (!takenBy) return fail(res, 400, 'Nama pemakai wajib diisi.');
  const r = withTx(() => {
    const row = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    if (!row) return { error: 'Barang tidak ditemukan.' };
    if (row.stock < qty) return { error: 'Stok tidak cukup. Sisa ' + row.stock + ', diminta ' + qty + '.' };
    const next = row.stock - qty;
    db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), itemId);
    db.prepare(`INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(itemId, todayLocal(), 'out', qty, next, machine, takenBy, 'Pengambilan', nowIso(), req.account.username);
    return { balance: next, name: row.name };
  });
  if (r.error) return fail(res, 400, r.error);
  ok(res, { balance: r.balance, name: r.name });
});

app.get('/api/takes/recent', requireAuth, (req, res) => {
  // hanya pengambilan biasa — pergerakan Pinjam / Kembali (Pinjam) punya
  // history sendiri di menu Pinjam, dan part yang dibawa supplier punya
  // history sendiri di menu Supplier, jadi tidak ikut di sini.
  // Mendukung page/perPage untuk infinite scroll di menu Ambil (tanpa
  // param = 20 pertama, sama seperti sebelum ada paginasi).
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = Math.min(100, Math.max(10, parseInt(req.query.perPage || '20', 10)));
  const w = `WHERE m.kind = 'out' AND m.note != 'Pinjam' AND m.note NOT LIKE 'Dibawa supplier%'`;
  const total = db.prepare(`SELECT COUNT(*) c FROM moves m JOIN items i ON i.id = m.item_id ${w}`).get().c;
  const rows = db.prepare(`SELECT m.*, i.name AS item_name, i.fd_code FROM moves m
    JOIN items i ON i.id = m.item_id ${w} ORDER BY m.id DESC LIMIT ? OFFSET ?`).all(perPage, (page - 1) * perPage);
  ok(res, { takes: rows, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) });
});

// ---------- detail / hapus / ubah satu catatan pengambilan ----------
// Latar: hapus catatan pengambilan HARUS per id moves, bukan per barang.
// Dulu satu-satunya "Hapus" yang bisa dicapai dari baris pengambilan adalah
// hapus barang (DELETE /api/items/:id) yang menghapus barang beserta SEMUA
// riwayatnya — user menghapus 1 dari 2 catatan pengambilan yang sama, kedua
// catatan hilang bersama barangnya. Endpoint di bawah ini hanya menyentuh
// SATU baris moves (berdasarkan id moves) dan mengembalikan/menyesuaikan stok.
function takeById(id) {
  return db.prepare(`SELECT m.*, i.name AS item_name, i.fd_code FROM moves m
    JOIN items i ON i.id = m.item_id WHERE m.id = ?`).get(id);
}
function takeListRow(id) {
  // catatan yang tampil di "Pengambilan terakhir": kind out, bukan Pinjam/supplier
  const r = takeById(id);
  if (!r) return null;
  if (r.kind !== 'out' || r.note === 'Pinjam' || r.note.startsWith('Dibawa supplier')) return null;
  return r;
}
function takeRow(r) {
  return {
    id: r.id, item_id: r.item_id, item_name: r.item_name, fd_code: r.fd_code || '',
    date: r.date, kind: r.kind, qty: r.qty, balance: r.balance,
    machine: r.machine || '', taken_by: r.taken_by || '', note: r.note || '',
    created_by: r.created_by || '', created_at: r.created_at,
    // hanya catatan 'Pengambilan' yang bisa diubah/dihapus dari sini;
    // penyesuaian stok manual ('Stok keluar') dan koreksi SO ('Opname (SO)')
    // hanya bisa dilihat — diurus lewat menu masing-masing.
    editable: r.kind === 'out' && r.note === 'Pengambilan',
  };
}

// Detail satu catatan pengambilan — semua peran yang login boleh melihat.
app.get('/api/takes/:id', requireAuth, (req, res) => {
  const r = takeListRow(parseInt(req.params.id, 10));
  if (!r) return fail(res, 404, 'Catatan pengambilan tidak ditemukan.');
  ok(res, { take: takeRow(r) });
});

// Hapus SATU catatan pengambilan — Admin saja. Stok dikembalikan sebesar qty
// catatan itu; catatan lain dari barang yang sama tidak tersentuh.
app.delete('/api/takes/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = withTx(() => {
    const row = db.prepare('SELECT * FROM moves WHERE id = ?').get(id);
    if (!row) return { error: 'Catatan pengambilan tidak ditemukan.', status: 404 };
    if (row.kind !== 'out' || row.note !== 'Pengambilan') return { error: 'Catatan ini bukan catatan pengambilan, tidak bisa dihapus dari sini.', status: 400 };
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(row.item_id);
    if (!item) return { error: 'Barang tidak ditemukan.', status: 404 };
    const next = item.stock + row.qty;
    db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), row.item_id);
    db.prepare('DELETE FROM moves WHERE id = ?').run(id);
    // saldo (Sisa) pergerakan sesudahnya ikut bergeser sebesar qty yang dikembalikan,
    // supaya kartu stok tetap konsisten.
    db.prepare('UPDATE moves SET balance = balance + ? WHERE item_id = ? AND id > ?').run(row.qty, row.item_id, id);
    return { balance: next, item_name: item.name, qty: row.qty };
  });
  if (r.error) return fail(res, r.status || 400, r.error);
  ok(res, { balance: r.balance, message: 'Catatan pengambilan "' + r.item_name + '" (' + r.qty + ' pcs) dihapus, stok dikembalikan.' });
});

// Ubah SATU catatan pengambilan — Admin saja. Boleh ubah qty, nama pemakai,
// mesin. Stok disesuaikan sebesar selisih qty (lama − baru); qty baru yang
// lebih besar ditolak bila selisihnya melebihi stok tersedia. Id dan tanggal
// asli tetap (UPDATE pada baris moves itu, bukan hapus + buat baru).
app.put('/api/takes/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const qty = parseInt(req.body.qty, 10);
  const takenBy = upperName(req.body.taken_by);
  const machine = upperName(req.body.machine);
  if (isNaN(qty) || qty <= 0) return fail(res, 400, 'Jumlah harus angka lebih dari 0.');
  if (!takenBy) return fail(res, 400, 'Nama pemakai wajib diisi.');
  const r = withTx(() => {
    const row = db.prepare('SELECT * FROM moves WHERE id = ?').get(id);
    if (!row) return { error: 'Catatan pengambilan tidak ditemukan.', status: 404 };
    if (row.kind !== 'out' || row.note !== 'Pengambilan') return { error: 'Catatan ini bukan catatan pengambilan, tidak bisa diubah dari sini.', status: 400 };
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(row.item_id);
    if (!item) return { error: 'Barang tidak ditemukan.', status: 404 };
    const delta = row.qty - qty; // >0: qty mengecil -> stok bertambah; <0: qty membesar -> stok berkurang
    if (delta < 0 && item.stock < -delta) return { error: 'Stok tidak cukup. Sisa ' + item.stock + ', tambahan ' + (-delta) + ' melebihi stok.', status: 400 };
    const next = item.stock + delta;
    if (delta !== 0) {
      db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), row.item_id);
      db.prepare('UPDATE moves SET balance = balance + ? WHERE item_id = ? AND id > ?').run(delta, row.item_id, id);
    }
    db.prepare('UPDATE moves SET qty = ?, machine = ?, taken_by = ?, balance = balance + ? WHERE id = ?').run(qty, machine, takenBy, delta, id);
    return { balance: next };
  });
  if (r.error) return fail(res, r.status || 400, r.error);
  ok(res, { balance: r.balance });
});

// ---------- daftar tools (nama saja, tanpa kode) ----------
// Tools diinput manual oleh Admin/User; peminjaman tools memilih dari daftar ini.
app.get('/api/tools', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM tools ORDER BY name COLLATE NOCASE ASC').all();
  ok(res, { tools: rows.map((t) => ({ id: t.id, name: t.name, created_at: t.created_at, created_by: t.created_by || '' })) });
});

app.post('/api/tools', requireAuth, (req, res) => {
  const name = upperName(req.body.name);
  if (!name) return fail(res, 400, 'Nama tools wajib diisi.');
  const dup = db.prepare('SELECT id FROM tools WHERE name = ? COLLATE NOCASE').get(name);
  if (dup) return fail(res, 409, 'Tools "' + name + '" sudah ada di daftar.');
  const ins = db.prepare('INSERT INTO tools (name, created_at, created_by) VALUES (?,?,?)').run(name, nowIso(), req.account.username);
  ok(res, { tool: { id: ins.lastInsertRowid, name, created_by: req.account.username } });
});

app.delete('/api/tools/:id', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(id);
  if (!tool) return fail(res, 404, 'Tools tidak ditemukan.');
  const active = db.prepare("SELECT COUNT(*) c FROM loans WHERE tool_id = ? AND status = 'dipinjam'").get(id).c;
  if (active) return fail(res, 400, 'Tools "' + tool.name + '" masih punya ' + active + ' pinjaman aktif, tidak bisa dihapus.');
  db.prepare('DELETE FROM tools WHERE id = ?').run(id);
  ok(res, { message: 'Tools "' + tool.name + '" dihapus.' });
});

// ---------- peminjaman tools — semua peran yang login boleh ----------
// Satu pinjaman = sejumlah pcs dari satu TOOLS (hanya nama, tanpa kode),
// dipinjam seseorang, wajib dikembalikan dalam 2 hari (48 jam). Foto bukti
// pengembalian WAJIB. Tools BUKAN stok sparepart: peminjaman TIDAK mengubah
// stok inventaris dan TIDAK mencatat move — murni catatan peminjaman.
const LOAN_DUE_MS = 48 * 3600 * 1000;
function loanById(id) {
  return db.prepare(`SELECT l.*, t.name AS tool_name
    FROM loans l LEFT JOIN tools t ON t.id = l.tool_id WHERE l.id = ?`).get(id);
}
function loanRow(r) {
  const due = new Date(r.due_at);
  const now = new Date();
  const overdueDays = r.status === 'dipinjam' && now > due ? Math.floor((now - due) / 86400000) : 0;
  return {
    id: r.id, tool_id: r.tool_id, tool_name: r.tool_name || '(tools dihapus)',
    qty: r.qty, borrower: r.borrower, borrowed_by: r.borrowed_by || '',
    machine: r.machine || '',
    borrowed_at: r.borrowed_at, due_at: r.due_at,
    returned_at: r.returned_at || '', returned_by: r.returned_by || '',
    status: r.status, overdue: r.status === 'dipinjam' && now > due,
    overdue_days: overdueDays, hasReturnPhoto: !!r.return_photo,
  };
}

app.post('/api/loans', requireAuth, (req, res) => {
  const qty = parseInt(req.body.qty, 10);
  const borrower = upperName(req.body.borrower);
  const machine = upperName(req.body.machine || ''); // opsional: mesin yang dipakai
  if (isNaN(qty) || qty <= 0) return fail(res, 400, 'Jumlah harus angka lebih dari 0.');
  if (!borrower) return fail(res, 400, 'Nama peminjam wajib diisi.');
  let tool = null;
  if (req.body.toolId !== undefined && req.body.toolId !== null && String(req.body.toolId) !== '') {
    const toolId = parseInt(req.body.toolId, 10);
    if (isNaN(toolId)) return fail(res, 400, 'Tools belum dipilih.');
    tool = db.prepare('SELECT * FROM tools WHERE id = ?').get(toolId);
    if (!tool) return fail(res, 404, 'Tools tidak ditemukan.');
  } else {
    const name = upperName(req.body.tool || req.body.name || '');
    if (!name) return fail(res, 400, 'Nama tools belum diisi.');
    tool = db.prepare('SELECT * FROM tools WHERE name = ? COLLATE NOCASE').get(name);
    if (!tool) return fail(res, 404, 'Tools "' + name + '" belum ada di daftar. Tambahkan dulu di menu Peminjaman Tools.');
  }
  const borrowedAt = nowIso();
  const dueAt = new Date(Date.now() + LOAN_DUE_MS).toISOString();
  const ins = db.prepare(`INSERT INTO loans (tool_id, qty, borrower, borrowed_by, machine, borrowed_at, due_at, status)
    VALUES (?,?,?,?,?,?,?,?)`).run(tool.id, qty, borrower, req.account.username, machine, borrowedAt, dueAt, 'dipinjam');
  const loan = loanById(ins.lastInsertRowid);
  ok(res, { loan: loanRow(loan) });
});

app.get('/api/loans', requireAuth, (req, res) => {
  const filter = req.query.status || 'all'; // all | dipinjam | dikembalikan | terlambat
  const rows = db.prepare(`SELECT l.*, t.name AS tool_name
    FROM loans l LEFT JOIN tools t ON t.id = l.tool_id ORDER BY l.borrowed_at DESC, l.id DESC`).all();
  const all = rows.map(loanRow);
  let loans = all;
  if (filter === 'dipinjam') loans = all.filter((l) => l.status === 'dipinjam');
  else if (filter === 'dikembalikan') loans = all.filter((l) => l.status === 'dikembalikan');
  else if (filter === 'terlambat') loans = all.filter((l) => l.overdue);
  const overdueCount = all.filter((l) => l.overdue).length;
  ok(res, { loans, overdueCount });
});

// Detail satu pinjaman tools (untuk tampilan detail dari history).
app.get('/api/loans/:id', requireAuth, (req, res) => {
  const loan = loanById(parseInt(req.params.id, 10));
  if (!loan) return fail(res, 404, 'Pinjaman tidak ditemukan.');
  ok(res, { loan: loanRow(loan) });
});

app.post('/api/loans/:id/return', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const photo = req.body.photo;
  if (!photo || typeof photo !== 'string' || !photo.startsWith('data:image/')) {
    return fail(res, 400, 'Foto bukti pengembalian wajib diisi.');
  }
  if (photo.length > 1500000) return fail(res, 400, 'Foto terlalu besar (maks ~1 MB setelah dikompres).');
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(id);
  if (!loan) return fail(res, 404, 'Pinjaman tidak ditemukan.');
  if (loan.status === 'dikembalikan') return fail(res, 400, 'Pinjaman ini sudah dikembalikan pada ' + (loan.returned_at || '').slice(0, 10) + '.');
  db.prepare(`UPDATE loans SET status = 'dikembalikan', returned_at = ?, returned_by = ?, return_photo = ? WHERE id = ?`)
    .run(nowIso(), req.account.username, photo, id);
  const out = loanById(id);
  ok(res, { loan: loanRow(out) });
});

app.get('/api/loans/:id/return-photo', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT return_photo FROM loans WHERE id = ?').get(id);
  if (!row || !row.return_photo) return fail(res, 404, 'Pinjaman ini belum punya foto bukti pengembalian.');
  const buf = signatureFromDataUri(row.return_photo);
  if (!buf) return fail(res, 404, 'Foto tidak bisa dibaca.');
  const mime = /^data:(image\/[a-zA-Z+]+);base64,/.exec(row.return_photo);
  res.setHeader('Content-Type', (mime && mime[1]) || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(buf);
});

// ---------- pengaturan aplikasi ----------
// Pengingat supplier (hari) bisa diatur Admin 1–30, default 2. Dibaca semua
// peran yang login; diubah hanya Admin.
function supplierReminderDays() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'supplier_reminder_days'").get();
  const n = parseInt(row && row.value, 10);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? n : 2;
}
app.get('/api/settings', requireAuth, (req, res) => {
  ok(res, { settings: { supplier_reminder_days: supplierReminderDays() } });
});
app.put('/api/settings/supplier-reminder-days', requireAuth, requireAdmin, (req, res) => {
  const days = parseInt(req.body.days, 10);
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    return fail(res, 400, 'Pengingat harus 1–30 hari.');
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('supplier_reminder_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(days));
  ok(res, { supplier_reminder_days: days });
});

// ---------- peminjaman dibawa supplier — KHUSUS ADMIN ----------
// Part inventaris dibawa supplier untuk contoh atau service, wajib kembali
// dalam N hari (setting pengingat, default 2 hari). Foto bukti pengembalian
// WAJIB saat kembali. Membawa part mengurangi stok (move keluar
// "Dibawa supplier (contoh/service)"); kembali menambah stok (move masuk
// "Kembali dari supplier"). Keduanya tercatat di kartu stok barang, tapi
// TIDAK dihitung sebagai pemakaian YOI/MOI.
// Kode yang TIDAK ada di inventaris tetap bisa dicatat sebagai part non-stok
// (nama part diisi manual): tanpa perubahan stok sama sekali.
// Contoh yang memang tidak kembali bisa ditandai "tidak kembali" — record
// ditutup tanpa perubahan stok.
function supplierLoanById(id) {
  return db.prepare(`SELECT s.*, i.name AS item_name, i.fd_code, i.stock AS current_stock
    FROM supplier_loans s LEFT JOIN items i ON i.id = s.item_id WHERE s.id = ?`).get(id);
}
function supplierLoanRow(r) {
  // Jatuh tempo dihitung DINAMIS dari taken_at + setting pengingat saat ini —
  // mengubah setting langsung mengevaluasi ulang semua pinjaman aktif.
  const due = new Date(new Date(r.taken_at).getTime() + supplierReminderDays() * 86400000);
  const now = new Date();
  const overdueDays = r.status === 'dibawa' && now > due ? Math.floor((now - due) / 86400000) : 0;
  return {
    id: r.id, item_id: r.item_id == null ? null : r.item_id,
    item_name: r.item_name || r.manual_name || '(barang dihapus)',
    fd_code: r.fd_code || r.manual_code || '',
    manual_name: r.manual_name || '', manual_code: r.manual_code || '',
    non_stock: r.item_id == null,
    qty: r.qty, supplier: r.supplier, purpose: r.purpose, taken_by: r.taken_by || '',
    taken_at: r.taken_at, due_at: due.toISOString(),
    returned_at: r.returned_at || '', returned_by: r.returned_by || '',
    status: r.status, overdue: r.status === 'dibawa' && now > due,
    overdue_days: overdueDays, hasReturnPhoto: !!r.return_photo,
    current_stock: r.current_stock == null ? null : r.current_stock,
    reminder_days: supplierReminderDays(),
  };
}

app.post('/api/supplier-loans', requireAuth, requireAdmin, (req, res) => {
  const qty = parseInt(req.body.qty, 10);
  const supplier = upperName(req.body.supplier);
  const purpose = cleanStr(req.body.purpose);
  if (isNaN(qty) || qty <= 0) return fail(res, 400, 'Jumlah harus angka lebih dari 0.');
  if (!supplier) return fail(res, 400, 'Nama supplier wajib diisi.');
  if (purpose !== 'contoh' && purpose !== 'service') return fail(res, 400, 'Tujuan harus "Contoh" atau "Service".');
  let item = null;
  let manualName = '';
  let manualCode = '';
  if (req.body.itemId !== undefined && req.body.itemId !== null && String(req.body.itemId) !== '') {
    const itemId = parseInt(req.body.itemId, 10);
    if (isNaN(itemId)) return fail(res, 400, 'Barang belum dipilih.');
    item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    if (!item) return fail(res, 404, 'Barang tidak ditemukan.');
  } else {
    const code = upperName(req.body.code || '');
    if (!code) return fail(res, 400, 'Kode FD / barcode belum diisi.');
    item = db.prepare('SELECT * FROM items WHERE UPPER(fd_code) = UPPER(?) OR UPPER(barcode) = UPPER(?) LIMIT 1').get(code, code);
    if (!item) {
      // jalur non-stok: kode tidak dikenal — catat manual, tanpa ubah stok
      manualName = upperName(req.body.manualName || req.body.manual_name || '');
      if (!manualName) return fail(res, 400, 'Kode tidak ada di stok — isi nama part secara manual.');
      manualCode = code;
    }
  }
  const r = withTx(() => {
    let next = null;
    if (item) {
      const row = db.prepare('SELECT * FROM items WHERE id = ?').get(item.id);
      if (row.stock < qty) return { error: 'Stok tidak cukup. Sisa ' + row.stock + ', diminta ' + qty + '.' };
      next = row.stock - qty;
      db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), item.id);
      db.prepare(`INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(item.id, todayLocal(), 'out', qty, next, purpose, supplier, 'Dibawa supplier (' + purpose + ')', nowIso());
    }
    const takenAt = nowIso();
    const ins = db.prepare(`INSERT INTO supplier_loans (item_id, manual_name, manual_code, qty, supplier, purpose, taken_by, taken_at, status)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(item ? item.id : null, manualName, manualCode, qty, supplier, purpose, req.account.username, takenAt, 'dibawa');
    return { loanId: ins.lastInsertRowid, balance: next };
  });
  if (r.error) return fail(res, 400, r.error);
  const loan = supplierLoanById(r.loanId);
  ok(res, { loan: supplierLoanRow(loan), balance: r.balance });
});

app.get('/api/supplier-loans', requireAuth, requireAdmin, (req, res) => {
  const filter = req.query.status || 'all'; // all | dibawa | dikembalikan | tidak_kembali | terlambat
  const rows = db.prepare(`SELECT s.*, i.name AS item_name, i.fd_code, i.stock AS current_stock
    FROM supplier_loans s LEFT JOIN items i ON i.id = s.item_id ORDER BY s.taken_at DESC, s.id DESC`).all();
  const all = rows.map(supplierLoanRow);
  let loans = all;
  if (filter === 'dibawa') loans = all.filter((l) => l.status === 'dibawa');
  else if (filter === 'dikembalikan') loans = all.filter((l) => l.status === 'dikembalikan');
  else if (filter === 'tidak_kembali') loans = all.filter((l) => l.status === 'tidak_kembali');
  else if (filter === 'terlambat') loans = all.filter((l) => l.overdue);
  const overdueCount = all.filter((l) => l.overdue).length;
  ok(res, { loans, overdueCount });
});

// Detail satu pinjaman supplier (untuk tampilan detail dari history).
app.get('/api/supplier-loans/:id', requireAuth, requireAdmin, (req, res) => {
  const loan = supplierLoanById(parseInt(req.params.id, 10));
  if (!loan) return fail(res, 404, 'Pinjaman supplier tidak ditemukan.');
  ok(res, { loan: supplierLoanRow(loan) });
});

app.post('/api/supplier-loans/:id/return', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const photo = req.body.photo;
  if (!photo || typeof photo !== 'string' || !photo.startsWith('data:image/')) {
    return fail(res, 400, 'Foto bukti pengembalian wajib diisi.');
  }
  if (photo.length > 1500000) return fail(res, 400, 'Foto terlalu besar (maks ~1 MB setelah dikompres).');
  const r = withTx(() => {
    const loan = db.prepare('SELECT * FROM supplier_loans WHERE id = ?').get(id);
    if (!loan) return { error: 'Peminjaman tidak ditemukan.', status: 404 };
    if (loan.status === 'dikembalikan') return { error: 'Part ini sudah dikembalikan pada ' + (loan.returned_at || '').slice(0, 10) + '.', status: 400 };
    if (loan.status === 'tidak_kembali') return { error: 'Peminjaman ini sudah ditandai tidak kembali.', status: 400 };
    let next = null;
    if (loan.item_id != null) {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(loan.item_id);
      if (!item) return { error: 'Barang tidak ditemukan.', status: 404 };
      next = item.stock + loan.qty;
      db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), item.id);
      db.prepare(`INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(item.id, todayLocal(), 'in', loan.qty, next, loan.purpose, loan.supplier, 'Kembali dari supplier', nowIso());
    }
    db.prepare(`UPDATE supplier_loans SET status = 'dikembalikan', returned_at = ?, returned_by = ?, return_photo = ? WHERE id = ?`)
      .run(nowIso(), req.account.username, photo, id);
    return { balance: next };
  });
  if (r.error) return fail(res, r.status || 400, r.error);
  const loan = supplierLoanById(id);
  ok(res, { loan: supplierLoanRow(loan), balance: r.balance });
});

app.post('/api/supplier-loans/:id/not-returned', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const loan = db.prepare('SELECT * FROM supplier_loans WHERE id = ?').get(id);
  if (!loan) return fail(res, 404, 'Peminjaman tidak ditemukan.');
  if (loan.status === 'dikembalikan') return fail(res, 400, 'Part ini sudah dikembalikan.');
  if (loan.status === 'tidak_kembali') return fail(res, 400, 'Peminjaman ini sudah ditandai tidak kembali.');
  db.prepare(`UPDATE supplier_loans SET status = 'tidak_kembali', returned_at = ?, returned_by = ? WHERE id = ?`)
    .run(nowIso(), req.account.username, id);
  const out = supplierLoanById(id);
  ok(res, { loan: supplierLoanRow(out) });
});

app.get('/api/supplier-loans/:id/return-photo', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT return_photo FROM supplier_loans WHERE id = ?').get(id);
  if (!row || !row.return_photo) return fail(res, 404, 'Peminjaman ini belum punya foto bukti pengembalian.');
  const buf = signatureFromDataUri(row.return_photo);
  if (!buf) return fail(res, 404, 'Foto tidak bisa dibaca.');
  const mime = /^data:(image\/[a-zA-Z+]+);base64,/.exec(row.return_photo);
  res.setHeader('Content-Type', (mime && mime[1]) || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(buf);
});

// ---------- stock opname (SO) — semua peran yang login boleh mencatat & ekspor ----------
// Satu catatan SO = jumlah fisik hasil hitungan manual untuk satu barang pada satu
// tanggal, lengkap dengan snapshot stok sistem saat dicatat dan selisihnya.
// Kolom date (tanggal lokal) mengikuti pola tabel moves: created_at disimpan UTC,
// sedangkan filter per tanggal harus memakai tanggal lokal pengguna.
function soStatus(diff) { return diff === 0 ? 'Sesuai' : 'Selisih'; }
function soRow(r) {
  return {
    id: r.id, item_id: r.item_id, item_name: r.item_name, fd_code: r.fd_code || '',
    date: r.date, counted: r.counted, system_stock: r.system_stock, diff: r.diff,
    status: soStatus(r.diff), current_stock: r.current_stock,
    username: r.username || '', adjusted: r.adjusted === 1, created_at: r.created_at,
  };
}
function soRecordById(id) {
  return db.prepare(`SELECT s.*, i.name AS item_name, i.fd_code, i.stock AS current_stock
    FROM so_records s JOIN items i ON i.id = s.item_id WHERE s.id = ?`).get(id);
}

app.get('/api/so', requireAuth, requireAdmin, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayLocal();
  const rows = db.prepare(`SELECT s.*, i.name AS item_name, i.fd_code, i.stock AS current_stock
    FROM so_records s JOIN items i ON i.id = s.item_id WHERE s.date = ? ORDER BY s.created_at DESC, s.id DESC`).all(date);
  ok(res, { date, records: rows.map(soRow) });
});

app.post('/api/so', requireAuth, requireAdmin, (req, res) => {
  const countedRaw = req.body.counted;
  const counted = typeof countedRaw === 'number' ? countedRaw : Number(String(countedRaw == null ? '' : countedRaw).trim());
  if (countedRaw === undefined || countedRaw === null || String(countedRaw).trim() === '' || !Number.isInteger(counted) || counted < 0) {
    return fail(res, 400, 'Jumlah SO harus angka bulat 0 atau lebih.');
  }
  let item = null;
  if (req.body.itemId !== undefined && req.body.itemId !== null && String(req.body.itemId) !== '') {
    const itemId = parseInt(req.body.itemId, 10);
    if (isNaN(itemId)) return fail(res, 400, 'Barang belum dipilih.');
    item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
    if (!item) return fail(res, 404, 'Barang tidak ditemukan.');
  } else {
    const code = upperName(req.body.code || '');
    if (!code) return fail(res, 400, 'Kode FD / barcode belum diisi.');
    item = db.prepare('SELECT * FROM items WHERE fd_code = ? OR barcode = ? LIMIT 1').get(code, code);
    if (!item) return fail(res, 404, 'Barang dengan kode "' + code + '" tidak ditemukan.');
  }
  const diff = counted - item.stock;
  // Tanggal SO mengikuti tanggal yang sedang dipilih pengguna (dikirim client);
  // tanpa tanggal, pakai hari ini (WIB). Sebelumnya tanggal selalu hari ini
  // menurut server, sehingga SO yang dicatat sambil melihat tanggal lain
  // tidak muncul di daftar tanggal tersebut.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : todayLocal();
  const r = db.prepare(`INSERT INTO so_records (item_id, date, counted, system_stock, diff, username, adjusted, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(item.id, date, counted, item.stock, diff, req.account.username, 0, nowIso());
  const rec = soRecordById(r.lastInsertRowid);
  ok(res, { record: soRow(rec), item: itemRow(item) });
});

// ekspor Excel catatan SO — Admin saja
app.get('/api/so/export', requireAuth, requireAdmin, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayLocal();
  const rows = db.prepare(`SELECT s.*, i.name AS item_name, i.fd_code FROM so_records s
    JOIN items i ON i.id = s.item_id WHERE s.date = ? ORDER BY s.created_at ASC, s.id ASC`).all(date);
  const aoa = [
    ['Stock Opname — ' + date],
    [],
    ['Kode FD', 'Nama Sparepart', 'Stok Sistem', 'Jumlah SO', 'Selisih', 'Status', 'Waktu', 'Diinput oleh'],
  ];
  for (const m of rows) {
    aoa.push([
      m.fd_code || '', m.item_name || '', m.system_stock, m.counted,
      m.diff, soStatus(m.diff), m.created_at ? timeWIB(m.created_at) : '', m.username || '',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 14 }, { wch: 34 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Opname');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="stock-opname-' + date + '.xlsx"');
  res.send(buf);
});

// sesuaikan stok sistem ke jumlah SO — Admin saja; sekali saja per catatan
app.post('/api/so/:id/adjust', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = withTx(() => {
    const rec = db.prepare('SELECT * FROM so_records WHERE id = ?').get(id);
    if (!rec) return { error: 'Catatan SO tidak ditemukan.', status: 404 };
    if (rec.diff === 0) return { error: 'Jumlah SO sudah sesuai dengan stok sistem, tidak perlu disesuaikan.', status: 400 };
    if (rec.adjusted === 1) return { error: 'Stok sudah pernah disesuaikan dari catatan SO ini.', status: 400 };
    const item = db.prepare('SELECT * FROM items WHERE id = ?').get(rec.item_id);
    if (!item) return { error: 'Barang tidak ditemukan.', status: 404 };
    db.prepare('UPDATE items SET stock = ?, updated_at = ? WHERE id = ?').run(rec.counted, nowIso(), item.id);
    const kind = rec.diff > 0 ? 'in' : 'out';
    // Koreksi tercatat pada tanggal catatan SO-nya, bukan hari ini — supaya
    // kartu stok menampilkan "Opname (SO)" di hari yang sama dengan SO-nya.
    db.prepare(`INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(item.id, rec.date, kind, Math.abs(rec.diff), rec.counted, '', '', 'Opname (SO)', nowIso());
    db.prepare('UPDATE so_records SET adjusted = 1 WHERE id = ?').run(id);
    return { balance: rec.counted, name: item.name };
  });
  if (r.error) return fail(res, r.status || 400, r.error);
  ok(res, { balance: r.balance, name: r.name });
});

// ---------- history ----------
app.get('/api/out-history', requireAuth, requireAdmin, (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayLocal();
  const rows = db.prepare(`SELECT m.*, i.name AS item_name, i.fd_code FROM moves m
    JOIN items i ON i.id = m.item_id WHERE m.kind = 'out' AND m.date = ? ORDER BY m.id ASC`).all(date);
  const total = rows.reduce((s, r) => s + r.qty, 0);
  ok(res, { date, total, rows });
});

// ekspor Excel history pengambilan (keluar) — Admin saja
app.get('/api/history/export', requireAuth, requireAdmin, (req, res) => {
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

app.get('/api/history', requireAuth, requireAdmin, (req, res) => {
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
  // mode recent: 60 terakhir — mendukung page/perPage untuk infinite
  // scroll di menu Riwayat (tanpa param = 60 pertama, sama seperti dulu).
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = Math.min(100, Math.max(10, parseInt(req.query.perPage || '60', 10)));
  const total = db.prepare(`SELECT COUNT(*) c FROM moves m JOIN items i ON i.id = m.item_id`).get().c;
  const rows = db.prepare(`SELECT m.*, i.name AS item_name, i.fd_code FROM moves m
    JOIN items i ON i.id = m.item_id ORDER BY m.id DESC LIMIT ? OFFSET ?`).all(perPage, (page - 1) * perPage);
  ok(res, { mode: 'recent', rows, total, page, perPage, pages: Math.max(1, Math.ceil(total / perPage)) });
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
    const fd = upperName(get('fd_code'));
    let stock = toInt(get('stock'));
    if (stock == null) stock = toInt(get('stock_fallback'));
    if (stock == null) stock = 0;
    const row = {
      name, fd_code: fd, barcode: upperName(get('barcode')),
      stock: Math.max(0, stock), rack: upperName(get('rack')),
      unit: upperName(get('unit')) || 'PCS', shelf: upperName(get('shelf')),
      jolly_box: upperName(get('jolly_box')), category: upperName(get('category')),
      notes: upperName(get('notes')),
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
