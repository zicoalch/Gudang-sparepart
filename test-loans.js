// Verifikasi fitur Peminjaman Tools — server uji terpisah (DB /tmp/loans-test.db, port 3111).
// TIDAK menyentuh database utama. Jalankan: node test-loans.js
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BASE = 'http://localhost:3111';
const DB_PATH = '/tmp/loans-test.db';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// foto bukti 1x1 PNG (data URI valid, kecil)
const PHOTO_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Ubah tanggal pinjaman langsung di DB uji (server baca ulang tiap request).
// daysAgo = pinjaman dibuat N hari lalu; jatuh tempo = pinjam + 2 hari.
function ageLoan(id, daysAgo) {
  const d = new DatabaseSync(DB_PATH);
  const borrowed = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const due = new Date(Date.now() - (daysAgo - 2) * 86400000).toISOString();
  d.prepare('UPDATE loans SET borrowed_at = ?, due_at = ? WHERE id = ?').run(borrowed, due, id);
  d.close();
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
    env: Object.assign({}, process.env, { PORT: '3111', DB_PATH }),
    stdio: 'ignore',
  });
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
    r = await admin.j('/api/items', { name: 'KUNCI PAS 14', fd_code: 'FD013610', stock: 5, unit: 'PCS', rack: 'RAK 2', shelf: 'F.1', jolly_box: '18', category: 'TOOLS' });
    check('buat barang A FD013610 stok 5', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idA = r.json.id;
    r = await admin.j('/api/items', { name: 'OBENG PLUS', fd_code: 'FD013611', barcode: 'BARB001', stock: 10, unit: 'PCS', rack: 'RAK 3', shelf: 'G.1', jolly_box: '7', category: 'TOOLS' });
    check('buat barang B FD013611 stok 10', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idB = r.json.id;
    r = await admin.j('/api/items', { name: 'TANG POTONG', fd_code: 'FD013612', stock: 3, unit: 'PCS' });
    check('buat barang C FD013612 stok 3', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idC = r.json.id;
    r = await admin.j('/api/items', { name: 'MARTIL KECIL', fd_code: 'FD013613', stock: 4, unit: 'PCS' });
    check('buat barang D FD013613 stok 4', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idD = r.json.id;

    console.log('== 3. Pinjam ==');
    r = await admin.j('/api/loans', { itemId: idA, qty: 2, borrower: 'Budi' });
    check('pinjam A 2 pcs oleh Budi (Admin)', r.status === 200 && r.json.loan && r.json.loan.status === 'dipinjam' && r.json.balance === 3, JSON.stringify(r.json).slice(0, 200));
    const loanA = r.json.loan.id;
    const dueMs = Date.parse(r.json.loan.due_at) - Date.parse(r.json.loan.borrowed_at);
    check('jatuh tempo = pinjam + 48 jam', Math.abs(dueMs - 48 * 3600 * 1000) < 60000, 'selisih=' + dueMs + 'ms');
    check('pinjaman mencatat peminjam + username pencatat', r.json.loan.borrower === 'Budi' && r.json.loan.borrowed_by === 'zico', JSON.stringify(r.json.loan));
    r = await admin.req('/api/items/lookup?code=FD013610');
    check('stok A sekarang 3', r.json.item.stock === 3, 'stock=' + r.json.item.stock);
    r = await admin.req('/api/items/' + idA);
    check('kartu stok A mencatat "Pinjam"', JSON.stringify(r.json.card).includes('Pinjam'), JSON.stringify(r.json.card).slice(0, 300));
    r = await admin.j('/api/loans', { itemId: idA, qty: 10, borrower: 'Budi' });
    check('pinjam melebihi stok DITOLAK (400, pesan jelas)', r.status === 400 && /Stok tidak cukup/.test(r.json.error || ''), 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/loans', { itemId: idA, qty: 0, borrower: 'Budi' });
    check('qty 0 DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/loans', { itemId: idA, qty: 1, borrower: '' });
    check('peminjam kosong DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/loans', { itemId: idA, qty: 1, borrower: '   ' });
    check('peminjam spasi saja DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/loans', { code: 'TIDAKADA', qty: 1, borrower: 'Budi' });
    check('kode tidak ketemu -> 404', r.status === 404, 'status=' + r.status);
    r = await admin.j('/api/loans', { itemId: 99999, qty: 1, borrower: 'Budi' });
    check('itemId tidak ada -> 404', r.status === 404, 'status=' + r.status);
    r = await admin.j('/api/loans', { code: 'BARB001', qty: 1, borrower: 'Siti' });
    check('pinjam via barcode (B, 1 pc)', r.status === 200 && r.json.balance === 9, JSON.stringify(r.json).slice(0, 150));
    const loanBbarcode = r.json.loan.id;
    r = await user.j('/api/loans', { itemId: idB, qty: 3, borrower: 'Udin' });
    check('pinjam oleh User BOLEH (B 3 pcs, stok 9 -> 6)', r.status === 200 && r.json.balance === 6, JSON.stringify(r.json).slice(0, 150));
    const loanB = r.json.loan.id;
    r = await admin.j('/api/loans', { itemId: idC, qty: 1, borrower: 'Siti' });
    check('pinjam C 1 pc (stok 3 -> 2)', r.status === 200 && r.json.balance === 2, JSON.stringify(r.json).slice(0, 150));
    const loanC = r.json.loan.id;
    r = await admin.req('/api/loans?status=all');
    check('list semua: 4 pinjaman', r.status === 200 && r.json.loans.length === 4, 'n=' + (r.json.loans && r.json.loans.length));
    const byId = {};
    for (const x of (r.json.loans || [])) byId[x.id] = x;
    check('list memuat nama barang + Kode FD + stok saat ini', byId[loanA] && byId[loanA].item_name === 'KUNCI PAS 14' && byId[loanA].fd_code === 'FD013610' && byId[loanA].current_stock === 3, JSON.stringify(byId[loanA]));
    check('overdueCount awal 0', r.json.overdueCount === 0, 'overdueCount=' + r.json.overdueCount);

    console.log('== 4. Terlambat (umur pinjaman diubah di DB uji) ==');
    ageLoan(loanB, 3); // pinjam 3 hari lalu -> jatuh tempo 1 hari lalu -> terlambat 1 hari
    ageLoan(loanC, 5); // pinjam 5 hari lalu -> jatuh tempo 3 hari lalu -> terlambat 3 hari
    ageLoan(loanA, 1); // pinjam 1 hari lalu -> jatuh tempo besok -> BELUM terlambat
    r = await admin.req('/api/loans?status=terlambat');
    check('list terlambat: 2 pinjaman (B + C)', r.status === 200 && r.json.loans.length === 2, 'n=' + (r.json.loans && r.json.loans.length));
    const late = {};
    for (const x of (r.json.loans || [])) late[x.id] = x;
    check('B terlambat 1 hari (overdue=true, overdue_days=1)', !!late[loanB] && late[loanB].overdue === true && late[loanB].overdue_days === 1, JSON.stringify(late[loanB]));
    check('C terlambat 3 hari (overdue_days=3)', !!late[loanC] && late[loanC].overdue_days === 3, JSON.stringify(late[loanC]));
    check('overdueCount = 2', r.json.overdueCount === 2, 'overdueCount=' + r.json.overdueCount);
    r = await admin.req('/api/loans?status=dipinjam');
    check('list dipinjam: 4 pinjaman (termasuk yang terlambat)', r.status === 200 && r.json.loans.length === 4, 'n=' + (r.json.loans && r.json.loans.length));
    const active = {};
    for (const x of (r.json.loans || [])) active[x.id] = x;
    check('A (1 hari) TIDAK terlambat', !!active[loanA] && active[loanA].overdue === false && active[loanA].overdue_days === 0, JSON.stringify(active[loanA]));
    r = await user.req('/api/loans?status=terlambat');
    check('list terlambat bisa dilihat User (200)', r.status === 200 && r.json.loans.length === 2, 'status=' + r.status);

    console.log('== 5. Kembalikan (foto bukti wajib) ==');
    r = await admin.j('/api/loans/' + loanA + '/return', {});
    check('kembali tanpa foto DITOLAK (400)', r.status === 400 && /Foto/.test(r.json.error || ''), 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/loans/' + loanA + '/return', { photo: 'bukan-data-uri' });
    check('kembali dengan foto tidak valid DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/loans/' + loanA + '/return', { photo: PHOTO_1X1 });
    check('kembali A dengan foto (stok 3 -> 5)', r.status === 200 && r.json.balance === 5 && r.json.loan.status === 'dikembalikan', JSON.stringify(r.json).slice(0, 200));
    check('kembali A tercatat returned_at + returned_by zico', !!r.json.loan.returned_at && r.json.loan.returned_by === 'zico' && r.json.loan.hasReturnPhoto === true, JSON.stringify(r.json.loan));
    r = await admin.j('/api/loans/' + loanA + '/return', { photo: PHOTO_1X1 });
    check('kembali 2x DITOLAK (400)', r.status === 400 && /sudah dikembalikan/.test(r.json.error || ''), 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/loans/99999/return', { photo: PHOTO_1X1 });
    check('kembali pinjaman tidak ada -> 404', r.status === 404, 'status=' + r.status);
    r = await admin.req('/api/items/' + idA);
    check('kartu stok A mencatat "Kembali (Pinjam)"', JSON.stringify(r.json.card).includes('Kembali (Pinjam)'), JSON.stringify(r.json.card).slice(0, 300));
    r = await admin.req('/api/loans/' + loanA + '/return-photo');
    check('foto bukti A: 200 image/png', r.status === 200 && (r.headers.get('content-type') || '').includes('image/png') && r.buf.length > 10, 'status=' + r.status + ' len=' + (r.buf && r.buf.length));
    r = await user.j('/api/loans/' + loanB + '/return', { photo: PHOTO_1X1 });
    check('kembali oleh User BOLEH (B terlambat, stok 6 -> 9)', r.status === 200 && r.json.balance === 9, JSON.stringify(r.json).slice(0, 150));
    r = await admin.j('/api/loans/' + loanC + '/return', { photo: PHOTO_1X1 });
    check('kembali C (stok 2 -> 3)', r.status === 200 && r.json.balance === 3, JSON.stringify(r.json).slice(0, 150));
    r = await admin.req('/api/loans/' + loanBbarcode + '/return-photo');
    check('foto bukti pinjaman aktif (belum kembali) -> 404', r.status === 404, 'status=' + r.status);
    r = await admin.req('/api/loans?status=dikembalikan');
    check('list dikembalikan: 3 pinjaman', r.status === 200 && r.json.loans.length === 3, 'n=' + (r.json.loans && r.json.loans.length));
    r = await admin.req('/api/loans?status=terlambat');
    check('terlambat sekarang 0 (semua yang telat sudah kembali)', r.status === 200 && r.json.loans.length === 0 && r.json.overdueCount === 0, 'n=' + (r.json.loans && r.json.loans.length));

    console.log('== 6. YOI / MOI tidak berubah oleh siklus pinjam-kembali ==');
    r = await admin.j('/api/take', { itemId: idD, qty: 2, machine: 'BLOWMOULD', takenBy: 'zico' });
    check('ambil D 2 pcs (pemakaian nyata, stok 4 -> 2)', r.status === 200 && r.json.balance === 2, JSON.stringify(r.json));
    r = await admin.req('/api/items/' + idD);
    const usageBefore = r.json.item.usage;
    check('D punya history pemakaian (totalOut 2)', usageBefore.hasHistory === true && usageBefore.totalOut === 2, JSON.stringify(usageBefore));
    r = await admin.j('/api/loans', { itemId: idD, qty: 1, borrower: 'Rudi' });
    check('pinjam D 1 pc (stok 2 -> 1)', r.status === 200 && r.json.balance === 1, JSON.stringify(r.json).slice(0, 150));
    const loanD = r.json.loan.id;
    r = await admin.j('/api/loans/' + loanD + '/return', { photo: PHOTO_1X1 });
    check('kembali D 1 pc (stok 1 -> 2)', r.status === 200 && r.json.balance === 2, JSON.stringify(r.json).slice(0, 150));
    r = await admin.req('/api/items/' + idD);
    const usageAfter = r.json.item.usage;
    check('YOI/MOI D TETAP: totalOut 2, avgPerMonth sama', usageAfter.totalOut === 2 && usageAfter.avgPerMonth === usageBefore.avgPerMonth && usageAfter.moi === usageBefore.moi, 'sebelum=' + JSON.stringify(usageBefore) + ' sesudah=' + JSON.stringify(usageAfter));
    r = await admin.req('/api/items/' + idC);
    check('C (hanya pinjam-kembali, tanpa ambil) hasHistory false', r.json.item.usage.hasHistory === false && r.json.item.usage.totalOut === 0, JSON.stringify(r.json.item.usage));
    r = await admin.req('/api/takes/recent');
    const notes = (r.json.takes || []).map((t) => t.note);
    check('Pinjam TIDAK muncul di "Pengambilan terakhir" tab Ambil', !notes.includes('Pinjam') && !notes.includes('Kembali (Pinjam)'), JSON.stringify(notes));

    console.log('== 7. Tanpa login (401) ==');
    r = await anon.req('/api/loans');
    check('GET /api/loans tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.j('/api/loans', { itemId: idA, qty: 1, borrower: 'X' });
    check('POST /api/loans tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.j('/api/loans/' + loanBbarcode + '/return', { photo: PHOTO_1X1 });
    check('POST /api/loans/:id/return tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.req('/api/loans/' + loanA + '/return-photo');
    check('GET /api/loans/:id/return-photo tanpa login -> 401', r.status === 401, 'status=' + r.status);

    console.log('== 8. Frontend ter-serve ==');
    r = await admin.req('/index.html');
    check('index.html: tombol nav Pinjam', r.text.includes('data-view="loan"') && r.text.includes('🤝 Pinjam'));
    check('index.html: view Pinjam + form kode/scan/jumlah/peminjam/simpan', r.text.includes('id="view-loan"') && r.text.includes('id="loan-code"') && r.text.includes('btn-scan-loan') && r.text.includes('id="loan-qty"') && r.text.includes('id="loan-borrower"') && r.text.includes('btn-save-loan'));
    check('index.html: kartu pengingat + daftar aktif + history + filter', r.text.includes('id="loan-alert"') && r.text.includes('id="loan-active"') && r.text.includes('id="loan-list"') && r.text.includes('id="loan-filter"'));
    check('index.html: form pengembalian + foto wajib', r.text.includes('id="return-box"') && r.text.includes('id="return-photo-camera"') && r.text.includes('btn-save-return'));
    check('index.html: kartu peringatan Dashboard', r.text.includes('id="dash-loan-alert"'));
    r = await admin.req('/app.js');
    check('app.js: lookupLoan + loadLoans + loadLoanAlert', r.text.includes('lookupLoan') && r.text.includes('loadLoans') && r.text.includes('loadLoanAlert'));
    check('app.js: scan target loan', r.text.includes("openScanner('loan')") && r.text.includes("scanTarget === 'loan'"));
    check('app.js: simpan pinjam ke POST /api/loans + kembali ke /return', r.text.includes("'/api/loans'") && r.text.includes("/return'"));
    check('app.js: badge Terlambat + tombol Kembalikan + foto bukti', r.text.includes('⚠️ Terlambat') && r.text.includes('✅ Kembalikan') && r.text.includes('return-photo'));
    check('app.js: tombol simpan pengembalian terkunci tanpa foto', r.text.includes("$('#btn-save-return').disabled = true") && r.text.includes('Foto bukti pengembalian wajib'));
    check('app.js: nav Pinjam TIDAK disembunyikan untuk User', !r.text.includes('button[data-view="loan"]'));
    r = await admin.req('/sw.js');
    check('sw.js: CACHE v5', r.text.includes('gudang-sparepart-v5'));
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
