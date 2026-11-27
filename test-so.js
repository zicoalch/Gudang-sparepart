// Verifikasi fitur Stock Opname (SO) — server uji terpisah (DB /tmp/so-test.db, port 3109).
// TIDAK menyentuh database utama. Jalankan: node test-so.js
const fs = require('fs');
const { spawn } = require('child_process');
const XLSX = require('xlsx');

const BASE = 'http://localhost:3109';
const DB_PATH = '/tmp/so-test.db';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function todayStr() {
  // "Hari ini" dalam WIB — harus sama dengan todayLocal() server; memakai
  // tanggal lokal VM (UTC) akan salah pada 00:00–07:00 WIB.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

class Jar {
  constructor() { this.cookie = ''; }
  async req(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(BASE + path, Object.assign({}, opts, { headers }));
    const set = r.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return { status: r.status, json: await r.json(), headers: r.headers };
    const ab = await r.arrayBuffer();
    return { status: r.status, text: Buffer.from(ab).toString('utf8'), headers: r.headers, buf: Buffer.from(ab) };
  }
  j(path, body, method = 'POST') {
    return this.req(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
}

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return true; } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: '3109', DB_PATH }),
    stdio: 'ignore',
  });
  const today = todayStr();
  try {
    if (!(await waitUp())) { console.log('FAIL server uji tidak jalan'); process.exit(1); }

    console.log('== 1. Setup & login (Admin + User) ==');
    const anon = new Jar();
    let r = await anon.j('/api/setup', { password: 'admin123', confirm: 'admin123' });
    check('setup admin zico', r.status === 200 && r.json.ok, JSON.stringify(r.json));
    const admin = new Jar();
    r = await admin.j('/api/login', { username: 'zico', password: 'admin123' });
    check('login zico/admin', r.status === 200 && r.json.role === 'admin');
    r = await admin.j('/api/accounts', { username: 'budi', password: 'budi1234', role: 'user' });
    check('admin buat akun user budi', r.status === 200 && r.json.username === 'budi');
    const user = new Jar();
    r = await user.j('/api/login', { username: 'budi', password: 'budi1234' });
    check('login budi/user', r.status === 200 && r.json.role === 'user');

    console.log('== 2. Barang uji ==');
    r = await admin.j('/api/items', { name: 'SHAFT SO', fd_code: 'FD013610', stock: 5, unit: 'PCS', rack: 'RAK 2', shelf: 'F.1', jolly_box: '18', category: 'BLOWMOULD' });
    check('buat barang A FD013610 stok 5', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idA = r.json.id;
    r = await admin.j('/api/items', { name: 'BAUT SO', fd_code: 'FD013611', barcode: 'BARB001', stock: 10, unit: 'PCS', rack: 'RAK 3', shelf: 'G.1', jolly_box: '7', category: 'BAUT' });
    check('buat barang B FD013611 stok 10', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idB = r.json.id;
    r = await admin.j('/api/items', { name: 'MUR SO', fd_code: 'FD013612', stock: 0, unit: 'PCS' });
    check('buat barang C FD013612 stok 0', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idC = r.json.id;
    r = await admin.j('/api/items', { name: 'RING SO', fd_code: 'FD013613', stock: 8, unit: 'PCS' });
    check('buat barang D FD013613 stok 8', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idD = r.json.id;

    console.log('== 3. Catat SO — cocok, selisih +, selisih - ==');
    r = await admin.j('/api/so', { itemId: idA, counted: 5 });
    check('SO cocok (5 vs 5): diff 0 status Sesuai', r.status === 200 && r.json.record.diff === 0 && r.json.record.status === 'Sesuai' && r.json.record.system_stock === 5, JSON.stringify(r.json).slice(0, 200));
    const recA = r.json.record.id;
    r = await user.j('/api/so', { code: 'FD013611', counted: 12 });
    check('SO oleh User DITOLAK (403)', r.status === 403, 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/so', { code: 'FD013611', counted: 12 });
    check('SO selisih + (12 vs 10): diff +2 status Selisih', r.status === 200 && r.json.record.diff === 2 && r.json.record.status === 'Selisih' && r.json.record.system_stock === 10, JSON.stringify(r.json).slice(0, 200));
    check('SO oleh Admin tercatat username zico', r.json.record.username === 'zico', 'username=' + r.json.record.username);
    const recB = r.json.record.id;
    r = await admin.j('/api/so', { code: 'FD013612', counted: 0 });
    check('SO counted 0 boleh (0 vs 0): diff 0 Sesuai', r.status === 200 && r.json.record.diff === 0 && r.json.record.status === 'Sesuai', JSON.stringify(r.json).slice(0, 200));
    const recC0 = r.json.record.id;
    r = await admin.j('/api/so', { code: 'BARB001', counted: 7 });
    check('SO via barcode (7 vs 10): diff -3 Selisih', r.status === 200 && r.json.record.diff === -3 && r.json.record.status === 'Selisih' && r.json.record.item_name === 'BAUT SO', JSON.stringify(r.json).slice(0, 200));
    const recBneg = r.json.record.id;
    r = await admin.j('/api/so', { itemId: idD, counted: 6 });
    check('SO selisih - (6 vs 8): diff -2 Selisih', r.status === 200 && r.json.record.diff === -2 && r.json.record.status === 'Selisih', JSON.stringify(r.json).slice(0, 200));
    const recD = r.json.record.id;

    console.log('== 3b. User DITOLAK di semua endpoint SO ==');
    r = await user.req('/api/so?date=' + today);
    check('GET /api/so oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await user.j('/api/so', { code: 'FD013610', counted: 1 });
    check('POST /api/so oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await user.req('/api/so/export?date=' + today);
    check('GET /api/so/export oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await user.j('/api/so/' + recB + '/adjust', {});
    check('POST /api/so/:id/adjust oleh User -> 403', r.status === 403, 'status=' + r.status);

    console.log('== 3c. History keluar disembunyikan dari User ==');
    r = await admin.j('/api/take', { itemId: idA, qty: 1, machine: 'BLOWMOULD', takenBy: 'zico' });
    check('Admin ambil 1 unit barang A (stok 5 -> 4)', r.status === 200 && r.json.balance === 4, JSON.stringify(r.json));
    r = await user.req('/api/takes/recent');
    check('GET /api/takes/recent tetap 200 untuk User (Ambil tidak rusak)', r.status === 200 && Array.isArray(r.json.takes) && r.json.takes.length >= 1, JSON.stringify(r.json).slice(0, 200));
    r = await admin.req('/api/out-history?date=' + today);
    check('GET /api/out-history oleh Admin: 200, total 1', r.status === 200 && r.json.total === 1, 'total=' + (r.json && r.json.total));
    r = await user.req('/api/out-history?date=' + today);
    check('GET /api/out-history oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await admin.req('/api/history');
    check('GET /api/history oleh Admin: 200 mode recent', r.status === 200 && r.json.mode === 'recent', 'mode=' + (r.json && r.json.mode));
    r = await user.req('/api/history');
    check('GET /api/history oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await admin.req('/api/history/export?date=' + today);
    check('GET /api/history/export oleh Admin: 200 + xlsx', r.status === 200 && (r.headers.get('content-type') || '').includes('sheet'), 'status=' + r.status);
    r = await user.req('/api/history/export?date=' + today);
    check('GET /api/history/export oleh User -> 403', r.status === 403, 'status=' + r.status);

    console.log('== 4. Validasi SO ==');
    r = await admin.j('/api/so', { code: 'TIDAKADA', counted: 1 });
    check('kode tidak ketemu -> 404 + pesan jelas', r.status === 404 && /tidak ditemukan/.test(r.json.error || ''), 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/so', { itemId: idA, counted: -1 });
    check('counted negatif -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/so', { itemId: idA, counted: 'abc' });
    check('counted bukan angka -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/so', { itemId: idA, counted: 2.5 });
    check('counted desimal -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/so', { itemId: idA });
    check('counted kosong -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/so', { counted: 1 });
    check('tanpa kode/itemId -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/so', { itemId: 99999, counted: 1 });
    check('itemId tidak ada -> 404', r.status === 404, 'status=' + r.status);

    console.log('== 5. Daftar SO per tanggal ==');
    r = await admin.req('/api/so?date=' + today);
    check('list hari ini: 5 catatan', r.status === 200 && r.json.records.length === 5, 'n=' + (r.json.records && r.json.records.length) + ' date=' + r.json.date);
    const byId = {};
    for (const x of (r.json.records || [])) byId[x.id] = x;
    check('list memuat fd_code + stok sistem + username', byId[recB] && byId[recB].fd_code === 'FD013611' && byId[recB].system_stock === 10 && byId[recB].username === 'zico', JSON.stringify(byId[recB]));
    r = await admin.req('/api/so');
    check('list tanpa tanggal = hari ini', r.status === 200 && r.json.date === today && r.json.records.length === 5, 'date=' + r.json.date);
    r = await admin.req('/api/so?date=2000-01-01');
    check('list tanggal kosong: 0 catatan', r.status === 200 && r.json.records.length === 0, 'n=' + r.json.records.length);

    console.log('== 6. Ekspor Excel SO ==');
    r = await admin.req('/api/so/export?date=' + today);
    check('ekspor oleh Admin: 200 + xlsx', r.status === 200 && (r.headers.get('content-type') || '').includes('sheet') && r.buf.length > 1000, 'status=' + r.status + ' len=' + (r.buf && r.buf.length));
    check('nama file stock-opname-<tanggal>.xlsx', (r.headers.get('content-disposition') || '').includes('stock-opname-' + today + '.xlsx'), r.headers.get('content-disposition'));
    const wb = XLSX.read(r.buf, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const hdr = rows.find((x) => x && x[0] === 'Kode FD');
    check('header: Kode FD, Nama, Stok Sistem, Jumlah SO, Selisih, Status, Waktu, Diinput oleh',
      !!hdr && hdr[1] === 'Nama Sparepart' && hdr[2] === 'Stok Sistem' && hdr[3] === 'Jumlah SO' && hdr[4] === 'Selisih' && hdr[5] === 'Status' && hdr[6] === 'Waktu' && hdr[7] === 'Diinput oleh', JSON.stringify(hdr));
    const rowB = rows.find((x) => x && x[0] === 'FD013611' && x[3] === 12);
    check('baris B: sistem 10, SO 12, selisih 2, status Selisih, oleh zico', !!rowB && rowB[2] === 10 && rowB[4] === 2 && rowB[5] === 'Selisih' && rowB[7] === 'zico', JSON.stringify(rowB));
    const rowA = rows.find((x) => x && x[0] === 'FD013610');
    check('baris A: selisih 0, status Sesuai', !!rowA && rowA[4] === 0 && rowA[5] === 'Sesuai', JSON.stringify(rowA));
    r = await admin.req('/api/so/export');
    check('ekspor tanpa tanggal = hari ini', r.status === 200 && (r.headers.get('content-disposition') || '').includes('stock-opname-' + today + '.xlsx'), r.headers.get('content-disposition'));

    console.log('== 7. Sesuaikan stok (adjust) ==');
    r = await user.j('/api/so/' + recB + '/adjust', {});
    check('adjust oleh User DITOLAK (403)', r.status === 403, 'status=' + r.status);
    r = await admin.j('/api/so/' + recB + '/adjust', {});
    check('adjust oleh Admin (B: stok 10 -> 12)', r.status === 200 && r.json.balance === 12, JSON.stringify(r.json));
    r = await admin.req('/api/items/lookup?code=FD013611');
    check('stok B sekarang 12', r.json.item.stock === 12, 'stock=' + r.json.item.stock);
    r = await admin.req('/api/items/' + idB);
    check('kartu stok B mencatat "Opname (SO)"', JSON.stringify(r.json.card).includes('Opname (SO)'), JSON.stringify(r.json.card).slice(0, 300));
    r = await admin.req('/api/so?date=' + today);
    const recBAfter = (r.json.records || []).find((x) => x.id === recB);
    check('catatan B bertanda adjusted=1', !!recBAfter && recBAfter.adjusted === true, JSON.stringify(recBAfter));
    r = await admin.j('/api/so/' + recB + '/adjust', {});
    check('adjust kedua kali DITOLAK (400)', r.status === 400, 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/so/' + recA + '/adjust', {});
    check('adjust saat diff 0 DITOLAK (400)', r.status === 400, 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/so/99999/adjust', {});
    check('adjust catatan tidak ada -> 404', r.status === 404, 'status=' + r.status);
    // adjust selisih negatif: D 8 -> 6 (move keluar)
    r = await admin.j('/api/so/' + recD + '/adjust', {});
    check('adjust selisih - oleh Admin (D: stok 8 -> 6)', r.status === 200 && r.json.balance === 6, JSON.stringify(r.json));
    r = await admin.req('/api/items/' + idD);
    const cardD = JSON.stringify(r.json.card);
    check('kartu stok D mencatat "Opname (SO)" + keluar 2', cardD.includes('Opname (SO)') && r.json.item.stock === 6, cardD.slice(0, 300));

    console.log('== 8. Tanpa login (401) ==');
    r = await anon.req('/api/so?date=' + today);
    check('GET /api/so tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.j('/api/so', { itemId: idA, counted: 1 });
    check('POST /api/so tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.req('/api/so/export?date=' + today);
    check('GET /api/so/export tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.j('/api/so/' + recBneg + '/adjust', {});
    check('POST /api/so/:id/adjust tanpa login -> 401', r.status === 401, 'status=' + r.status);

    console.log('== 9. Frontend ter-serve ==');
    r = await admin.req('/index.html');
    check('index.html: tombol nav SO', r.text.includes('data-view="so"'));
    check('index.html: view SO + date + ekspor', r.text.includes('id="view-so"') && r.text.includes('id="so-date"') && r.text.includes('btn-export-so'));
    check('index.html: input kode + scan + jumlah + simpan', r.text.includes('id="so-code"') && r.text.includes('btn-scan-so') && r.text.includes('id="so-counted"') && r.text.includes('btn-save-so'));
    check('index.html: daftar SO + label tanggal', r.text.includes('id="so-list"') && r.text.includes('id="so-date-label"'));
    check('index.html: seksi dash-out-section + dash-date-row', r.text.includes('id="dash-out-section"') && r.text.includes('id="dash-date-row"'));
    r = await admin.req('/app.js');
    check('app.js: lookupSo + loadSo', r.text.includes('lookupSo') && r.text.includes('loadSo'));
    check('app.js: scan target so', r.text.includes("openScanner('so')") && r.text.includes("scanTarget === 'so'"));
    check('app.js: badge Sesuai / Selisih', r.text.includes('✅ Sesuai') && r.text.includes('⚠️ Selisih'));
    check('app.js: tombol Sesuaikan stok hanya Admin + confirm', r.text.includes('Sesuaikan stok') && r.text.includes('IS_ADMIN') && r.text.includes("confirm('Sesuaikan stok"));
    check('app.js: ekspor SO ke /api/so/export', r.text.includes('/api/so/export'));
    check('app.js: simpan SO ke POST /api/so', r.text.includes("'/api/so'"));
    check('app.js: tombol nav SO disembunyikan untuk non-Admin', r.text.includes('button[data-view="so"]') && r.text.includes("IS_ADMIN ? '' : 'none'"));
    check('app.js: penjaga view SO (toast + alih ke dashboard)', r.text.includes('Menu SO hanya untuk Admin') && r.text.includes("(name === 'so' || name === 'history' || name === 'supplier') && !IS_ADMIN"));
    check('app.js: tombol nav Riwayat disembunyikan untuk non-Admin', r.text.includes('button[data-view="history"]') && r.text.includes("IS_ADMIN ? '' : 'none'"));
    check('app.js: penjaga view Riwayat (toast + alih ke dashboard)', r.text.includes('Menu Riwayat hanya untuk Admin'));
    check('app.js: bagian Sparepart keluar Dashboard disembunyikan untuk non-Admin', r.text.includes("$('#dash-out-section').style.display = IS_ADMIN") && r.text.includes("$('#dash-date-row').style.display = IS_ADMIN"));
    check('app.js: loadOutHistory hanya dipanggil untuk Admin', r.text.includes('if (IS_ADMIN) { loadOutHistory(); loadSupplierAlert(); }'));
    check('app.js: tombol Cetak QR Inventaris disembunyikan untuk non-Admin', r.text.includes("$('#btn-print-qr').style.display = IS_ADMIN"));
    check('app.js: tombol Cetak di kartu QR detail hanya Admin', r.text.includes("IS_ADMIN ? '<button class=\"btn\" id=\"btn-print-qr-one\">"));
    check('app.js: Unduh PNG QR tetap untuk semua peran', r.text.includes('⬇ Unduh PNG'));
    r = await user.req('/api/items/' + idB + '/qr');
    check('GET /api/items/:id/qr tetap 200 untuk User (tampilan QR tidak rusak)', r.status === 200 && (r.headers.get('content-type') || '').includes('image/png') && r.buf.length > 100, 'status=' + r.status + ' len=' + (r.buf && r.buf.length));
    r = await admin.req('/style.css');
    check('style.css: badge hijau', r.text.includes('.badge.green'));
    console.log('== 10. Simpan dengan tanggal pilihan + tanggal WIB ==');
    const pastDate = '2026-11-20';
    r = await admin.req('/api/so');
    check('GET /api/so tanpa tanggal = hari ini (WIB)', r.status === 200 && r.json.date === today, 'date=' + r.json.date + ' wib=' + today);
    r = await admin.j('/api/so', { itemId: idA, counted: 3, date: pastDate });
    check('simpan SO dengan tanggal pilihan: record.date = tanggal itu', r.status === 200 && r.json.record.date === pastDate, JSON.stringify(r.json).slice(0, 200));
    const recPast1 = r.json.record.id;
    r = await admin.j('/api/so', { itemId: idA, counted: 4, date: pastDate });
    check('simpan 2x barang sama di tanggal sama: baris kedua, bukan menimpa', r.status === 200 && r.json.record.date === pastDate && r.json.record.id !== recPast1, JSON.stringify(r.json).slice(0, 200));
    const recPast2 = r.json.record.id;
    r = await admin.req('/api/so?date=' + pastDate);
    const pastRows = (r.json.records || []).filter((x) => x.item_id === idA);
    check('GET tanggal pilihan: 2 catatan barang A', r.status === 200 && pastRows.length === 2, 'n=' + pastRows.length);
    check('kedua catatan tanggal pilihan memuat SO 3 dan 4', pastRows.some((x) => x.counted === 3) && pastRows.some((x) => x.counted === 4), JSON.stringify(pastRows));
    r = await admin.req('/api/so?date=' + today);
    check('GET hari ini: tidak ada catatan tanggal pilihan', !(r.json.records || []).some((x) => x.date === pastDate), 'n=' + r.json.records.length);
    r = await admin.req('/api/so/export?date=' + pastDate);
    const wbPast = XLSX.read(r.buf, { type: 'buffer' });
    const rowsPast = XLSX.utils.sheet_to_json(wbPast.Sheets[wbPast.SheetNames[0]], { header: 1 });
    check('ekspor tanggal pilihan: memuat SO 3 dan SO 4 yang baru disimpan',
      rowsPast.some((x) => x && x[0] === 'FD013610' && x[3] === 3) && rowsPast.some((x) => x && x[0] === 'FD013610' && x[3] === 4),
      JSON.stringify(rowsPast.slice(0, 6)));
    check('ekspor tanggal pilihan: nama file pakai tanggal pilihan', (r.headers.get('content-disposition') || '').includes('stock-opname-' + pastDate + '.xlsx'), r.headers.get('content-disposition'));
    r = await admin.req('/api/so/export?date=' + today);
    const wbToday = XLSX.read(r.buf, { type: 'buffer' });
    const rowsToday = XLSX.utils.sheet_to_json(wbToday.Sheets[wbToday.SheetNames[0]], { header: 1 });
    check('ekspor hari ini: tidak memuat catatan tanggal pilihan',
      !rowsToday.some((x) => x && x[0] === 'FD013610' && (x[3] === 3 || x[3] === 4)), JSON.stringify(rowsToday.slice(0, 6)));
    r = await admin.j('/api/so', { itemId: idA, counted: 5, date: '20-11-2026' });
    check('tanggal format tak valid: jatuh ke hari ini (WIB), bukan error', r.status === 200 && r.json.record.date === today, JSON.stringify(r.json).slice(0, 200));
    // adjust pada catatan bertanggal lampau: koreksi masuk kartu stok di tanggal SO-nya
    r = await admin.j('/api/items', { name: 'SELANG SO', fd_code: 'FD013614', stock: 20, unit: 'PCS' });
    check('buat barang E FD013614 stok 20', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idE = r.json.id;
    r = await admin.j('/api/so', { itemId: idE, counted: 18, date: pastDate });
    check('SO barang E tanggal pilihan (18 vs 20): diff -2', r.status === 200 && r.json.record.diff === -2 && r.json.record.date === pastDate, JSON.stringify(r.json).slice(0, 200));
    const recE = r.json.record.id;
    r = await admin.j('/api/so/' + recE + '/adjust', {});
    check('adjust barang E (stok 20 -> 18)', r.status === 200 && r.json.balance === 18, JSON.stringify(r.json));
    r = await admin.req('/api/items/' + idE);
    const dayPast = (r.json.card || []).find((g) => g.date === pastDate);
    check('kartu stok E: koreksi "Opname (SO)" tercatat di tanggal SO (bukan hari ini)',
      !!dayPast && dayPast.rows.some((m) => m.note === 'Opname (SO)' && m.kind === 'out' && m.qty === 2),
      JSON.stringify(r.json.card).slice(0, 400));
    check('kartu stok E: tidak ada koreksi Opname (SO) di hari ini',
      !(r.json.card || []).some((g) => g.date === today && g.rows.some((m) => m.note === 'Opname (SO)')),
      JSON.stringify(r.json.card).slice(0, 400));

    console.log('== 11. Frontend: simpan kirim tanggal + jam WIB ==');
    r = await admin.req('/app.js');
    check('app.js: simpan SO mengirim date dari date picker', r.text.includes("date: $('#so-date').value"));
    check('app.js: timeOf menampilkan jam WIB (geser +7 jam dari UTC)', r.text.includes('7 * 3600 * 1000') && r.text.includes('function timeOf'));
    r = await admin.req('/sw.js');
    check('sw.js: CACHE v9', r.text.includes("gudang-sparepart-v9"));
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
