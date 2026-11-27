// Verifikasi fitur Peminjaman Supplier (KHUSUS ADMIN) —
// server uji terpisah (DB /tmp/supplier-test.db, port 3112).
// TIDAK menyentuh database utama. Jalankan: node test-supplier.js
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BASE = 'http://localhost:3112';
const DB_PATH = '/tmp/supplier-test.db';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
// foto bukti 1x1 PNG (data URI valid, kecil)
const PHOTO_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Ubah tanggal pinjam langsung di DB uji (server baca ulang tiap request).
// Jatuh tempo dihitung dinamis: taken_at + setting pengingat aktif.
function ageSupplierLoan(id, daysAgo) {
  const d = new DatabaseSync(DB_PATH);
  const taken = new Date(Date.now() - daysAgo * 86400000).toISOString();
  d.prepare('UPDATE supplier_loans SET taken_at = ? WHERE id = ?').run(taken, id);
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
    env: Object.assign({}, process.env, { PORT: '3112', DB_PATH }),
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

    console.log('== 2. Setting pengingat (default 2 hari) ==');
    r = await admin.req('/api/settings');
    check('GET /api/settings (Admin): default 2 hari', r.status === 200 && r.json.settings.supplier_reminder_days === 2, JSON.stringify(r.json));
    r = await user.req('/api/settings');
    check('GET /api/settings bisa dibaca User (200)', r.status === 200 && r.json.settings.supplier_reminder_days === 2, 'status=' + r.status);
    r = await anon.req('/api/settings');
    check('GET /api/settings tanpa login -> 401', r.status === 401, 'status=' + r.status);

    console.log('== 3. Barang uji ==');
    r = await admin.j('/api/items', { name: 'SEAL KARET 10MM', fd_code: 'FD013610', stock: 5, unit: 'PCS', rack: 'RAK 2', shelf: 'F.1', jolly_box: '18', category: 'SEAL' });
    check('buat barang A FD013610 stok 5', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idA = r.json.id;
    r = await admin.j('/api/items', { name: 'O-RING 20MM', fd_code: 'FD013611', barcode: 'BARB001', stock: 10, unit: 'PCS', rack: 'RAK 3', shelf: 'G.1', jolly_box: '7', category: 'SEAL' });
    check('buat barang B FD013611 stok 10', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idB = r.json.id;
    r = await admin.j('/api/items', { name: 'GASKET BESI', fd_code: 'FD013612', stock: 3, unit: 'PCS' });
    check('buat barang C FD013612 stok 3', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idC = r.json.id;
    r = await admin.j('/api/items', { name: 'BEARING 6204', fd_code: 'FD013613', stock: 4, unit: 'PCS' });
    check('buat barang D FD013613 stok 4', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idD = r.json.id;

    console.log('== 4. Supplier HANYA Admin (403 untuk User) ==');
    r = await user.j('/api/supplier-loans', { itemId: idA, qty: 1, supplier: 'PT Maju', purpose: 'contoh' });
    check('POST /api/supplier-loans oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await user.req('/api/supplier-loans');
    check('GET /api/supplier-loans oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await user.j('/api/supplier-loans/1/return', { photo: PHOTO_1X1 });
    check('POST /api/supplier-loans/:id/return oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await user.j('/api/supplier-loans/1/not-returned', {});
    check('POST /api/supplier-loans/:id/not-returned oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await user.req('/api/supplier-loans/1/return-photo');
    check('GET /api/supplier-loans/:id/return-photo oleh User -> 403', r.status === 403, 'status=' + r.status);
    r = await user.j('/api/settings/supplier-reminder-days', { days: 5 }, 'PUT');
    check('PUT setting pengingat oleh User -> 403', r.status === 403, 'status=' + r.status);

    console.log('== 5. Pinjam supplier (jalur stok) ==');
    r = await admin.j('/api/supplier-loans', { itemId: idA, qty: 2, supplier: 'PT Maju Jaya', purpose: 'contoh' });
    check('supplier bawa A 2 pcs untuk contoh (Admin)', r.status === 200 && r.json.loan && r.json.loan.status === 'dibawa' && r.json.balance === 3, JSON.stringify(r.json).slice(0, 200));
    const loanA = r.json.loan.id;
    const dueMs = Date.parse(r.json.loan.due_at) - Date.parse(r.json.loan.taken_at);
    check('jatuh tempo = dibawa + 2 hari (setting default)', Math.abs(dueMs - 2 * 86400000) < 60000, 'selisih=' + dueMs + 'ms');
    check('pinjaman mencatat supplier + purpose + pencatat', r.json.loan.supplier === 'PT Maju Jaya' && r.json.loan.purpose === 'contoh' && r.json.loan.taken_by === 'zico' && r.json.loan.non_stock === false, JSON.stringify(r.json.loan));
    r = await admin.req('/api/items/lookup?code=FD013610');
    check('stok A sekarang 3', r.json.item.stock === 3, 'stock=' + r.json.item.stock);
    r = await admin.req('/api/items/' + idA);
    check('kartu stok A mencatat "Dibawa supplier (contoh)"', JSON.stringify(r.json.card).includes('Dibawa supplier (contoh)'), JSON.stringify(r.json.card).slice(0, 300));
    r = await admin.j('/api/supplier-loans', { itemId: idA, qty: 10, supplier: 'PT Maju', purpose: 'contoh' });
    check('bawa melebihi stok DITOLAK (400, pesan jelas)', r.status === 400 && /Stok tidak cukup/.test(r.json.error || ''), 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/supplier-loans', { itemId: idA, qty: 0, supplier: 'PT Maju', purpose: 'contoh' });
    check('qty 0 DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/supplier-loans', { itemId: idA, qty: 1, supplier: '', purpose: 'contoh' });
    check('supplier kosong DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/supplier-loans', { itemId: idA, qty: 1, supplier: 'PT Maju', purpose: 'jual' });
    check('purpose bukan contoh/service DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/supplier-loans', { itemId: idA, qty: 1, supplier: 'PT Maju' });
    check('purpose kosong DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/supplier-loans', { itemId: 99999, qty: 1, supplier: 'PT Maju', purpose: 'contoh' });
    check('itemId tidak ada -> 404', r.status === 404, 'status=' + r.status);
    r = await admin.j('/api/supplier-loans', { code: 'BARB001', qty: 1, supplier: 'CV Servis', purpose: 'service' });
    check('bawa via barcode (B, 1 pc, service)', r.status === 200 && r.json.balance === 9, JSON.stringify(r.json).slice(0, 150));
    const loanBbarcode = r.json.loan.id;
    r = await admin.req('/api/supplier-loans?status=all');
    check('list semua: 2 pinjaman supplier', r.status === 200 && r.json.loans.length === 2, 'n=' + (r.json.loans && r.json.loans.length));
    const byId = {};
    for (const x of (r.json.loans || [])) byId[x.id] = x;
    check('list memuat nama barang + Kode FD + stok saat ini', byId[loanA] && byId[loanA].item_name === 'SEAL KARET 10MM' && byId[loanA].fd_code === 'FD013610' && byId[loanA].current_stock === 3, JSON.stringify(byId[loanA]));
    check('overdueCount awal 0', r.json.overdueCount === 0, 'overdueCount=' + r.json.overdueCount);

    console.log('== 6. Pinjam part NON-STOK (kode tidak dikenal, manual) ==');
    r = await admin.j('/api/supplier-loans', { code: 'FD999999', qty: 1, supplier: 'PT Maju', purpose: 'contoh' });
    check('kode tidak dikenal TANPA nama manual DITOLAK (400)', r.status === 400 && /manual/.test(r.json.error || ''), 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/supplier-loans', { code: 'FD999999', qty: 3, supplier: 'PT Maju', purpose: 'contoh', manualName: 'SEAL KARET CONTOH' });
    check('bawa part non-stok manual (FD999999, 3 pcs)', r.status === 200 && r.json.loan && r.json.loan.status === 'dibawa' && r.json.loan.non_stock === true, JSON.stringify(r.json).slice(0, 250));
    const loanNonStock = r.json.loan.id;
    check('non-stok mencatat manual_name + manual_code', r.json.loan.manual_name === 'SEAL KARET CONTOH' && r.json.loan.manual_code === 'FD999999' && r.json.loan.item_name === 'SEAL KARET CONTOH' && r.json.balance === null, JSON.stringify(r.json.loan));
    r = await admin.req('/api/items/lookup?code=FD999999');
    check('kode non-stok TETAP tidak ada di inventaris (404)', r.status === 404, 'status=' + r.status);
    for (const [id, want] of [[idA, 3], [idB, 9], [idC, 3], [idD, 4]]) {
      r = await admin.req('/api/items/' + id);
      check('stok barang id ' + id + ' tidak berubah (' + want + ')', r.json.item.stock === want, 'stock=' + r.json.item.stock);
    }
    r = await admin.j('/api/supplier-loans/' + loanNonStock + '/return', { photo: PHOTO_1X1 });
    check('kembali part non-stok dengan foto (tanpa ubah stok)', r.status === 200 && r.json.loan.status === 'dikembalikan' && r.json.balance === null, JSON.stringify(r.json).slice(0, 200));
    r = await admin.req('/api/items/' + idA);
    check('stok A tetap 3 setelah kembali non-stok', r.json.item.stock === 3, 'stock=' + r.json.item.stock);

    console.log('== 7. Terlambat + setting pengingat DINAMIS ==');
    ageSupplierLoan(loanBbarcode, 3); // dibawa 3 hari lalu
    r = await admin.req('/api/supplier-loans?status=terlambat');
    check('dengan setting 2 hari: B terlambat 1 hari', r.status === 200 && r.json.loans.length === 1 && r.json.loans[0].overdue_days === 1, 'n=' + (r.json.loans && r.json.loans.length) + ' ' + JSON.stringify(r.json.loans && r.json.loans[0]));
    r = await admin.j('/api/settings/supplier-reminder-days', { days: 5 }, 'PUT');
    check('PUT setting 2 -> 5 hari (Admin)', r.status === 200 && r.json.supplier_reminder_days === 5, JSON.stringify(r.json));
    r = await admin.req('/api/supplier-loans?status=terlambat');
    check('dengan setting 5 hari: B TIDAK lagi terlambat', r.status === 200 && r.json.loans.length === 0 && r.json.overdueCount === 0, 'n=' + (r.json.loans && r.json.loans.length));
    r = await admin.req('/api/supplier-loans?status=dibawa');
    const bNow = (r.json.loans || []).find((x) => x.id === loanBbarcode);
    const dueMs5 = bNow ? Date.parse(bNow.due_at) - Date.parse(bNow.taken_at) : -1;
    check('jatuh tempo B dihitung ulang = dibawa + 5 hari', Math.abs(dueMs5 - 5 * 86400000) < 60000, 'selisih=' + dueMs5 + 'ms');
    check('row memuat reminder_days = 5', bNow && bNow.reminder_days === 5, JSON.stringify(bNow));
    r = await admin.j('/api/settings/supplier-reminder-days', { days: 0 }, 'PUT');
    check('setting 0 hari DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/settings/supplier-reminder-days', { days: 31 }, 'PUT');
    check('setting 31 hari DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/settings/supplier-reminder-days', { days: 'abc' }, 'PUT');
    check('setting bukan angka DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.req('/api/settings');
    check('setting tetap 5 setelah penolakan', r.status === 200 && r.json.settings.supplier_reminder_days === 5, JSON.stringify(r.json));
    r = await admin.j('/api/settings/supplier-reminder-days', { days: 2 }, 'PUT');
    check('PUT setting kembali ke 2 hari', r.status === 200 && r.json.supplier_reminder_days === 2, JSON.stringify(r.json));
    r = await admin.req('/api/supplier-loans?status=terlambat');
    check('dengan setting 2 hari lagi: B terlambat 1 hari', r.status === 200 && r.json.loans.length === 1, 'n=' + (r.json.loans && r.json.loans.length));

    console.log('== 8. Kembalikan (foto bukti wajib, stok kembali) ==');
    r = await admin.j('/api/supplier-loans/' + loanA + '/return', {});
    check('kembali tanpa foto DITOLAK (400)', r.status === 400 && /Foto/.test(r.json.error || ''), 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/supplier-loans/' + loanA + '/return', { photo: 'bukan-data-uri' });
    check('kembali dengan foto tidak valid DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/supplier-loans/' + loanA + '/return', { photo: PHOTO_1X1 });
    check('kembali A dengan foto (stok 3 -> 5)', r.status === 200 && r.json.balance === 5 && r.json.loan.status === 'dikembalikan', JSON.stringify(r.json).slice(0, 200));
    check('kembali A tercatat returned_at + returned_by zico', !!r.json.loan.returned_at && r.json.loan.returned_by === 'zico' && r.json.loan.hasReturnPhoto === true, JSON.stringify(r.json.loan));
    r = await admin.req('/api/items/' + idA);
    check('kartu stok A mencatat "Kembali dari supplier"', JSON.stringify(r.json.card).includes('Kembali dari supplier'), JSON.stringify(r.json.card).slice(0, 300));
    r = await admin.j('/api/supplier-loans/' + loanA + '/return', { photo: PHOTO_1X1 });
    check('kembali 2x DITOLAK (400)', r.status === 400 && /sudah dikembalikan/.test(r.json.error || ''), 'status=' + r.status + ' ' + JSON.stringify(r.json));
    r = await admin.j('/api/supplier-loans/99999/return', { photo: PHOTO_1X1 });
    check('kembali pinjaman tidak ada -> 404', r.status === 404, 'status=' + r.status);
    r = await admin.req('/api/supplier-loans/' + loanA + '/return-photo');
    check('foto bukti A: 200 image/png', r.status === 200 && (r.headers.get('content-type') || '').includes('image/png') && r.buf.length > 10, 'status=' + r.status + ' len=' + (r.buf && r.buf.length));
    r = await admin.req('/api/supplier-loans/' + loanBbarcode + '/return-photo');
    check('foto bukti pinjaman aktif (belum kembali) -> 404', r.status === 404, 'status=' + r.status);
    r = await admin.j('/api/supplier-loans/' + loanBbarcode + '/return', { photo: PHOTO_1X1 });
    check('kembali B (stok 9 -> 10)', r.status === 200 && r.json.balance === 10, JSON.stringify(r.json).slice(0, 150));
    r = await admin.req('/api/supplier-loans/' + loanBbarcode + '/return-photo');
    check('foto bukti B setelah kembali: 200 image/png', r.status === 200 && (r.headers.get('content-type') || '').includes('image/png'), 'status=' + r.status);
    r = await admin.req('/api/supplier-loans?status=dikembalikan');
    check('list dikembalikan: 3 pinjaman (A + B + non-stok)', r.status === 200 && r.json.loans.length === 3, 'n=' + (r.json.loans && r.json.loans.length));
    r = await admin.req('/api/supplier-loans?status=terlambat');
    check('terlambat sekarang 0', r.status === 200 && r.json.loans.length === 0 && r.json.overdueCount === 0, 'n=' + (r.json.loans && r.json.loans.length));

    console.log('== 9. Tidak kembali (contoh yang memang tidak pulang) ==');
    r = await admin.j('/api/supplier-loans', { itemId: idC, qty: 1, supplier: 'PT Contoh', purpose: 'contoh' });
    check('supplier bawa C 1 pc untuk contoh (stok 3 -> 2)', r.status === 200 && r.json.balance === 2, JSON.stringify(r.json).slice(0, 150));
    const loanC = r.json.loan.id;
    r = await admin.j('/api/supplier-loans/' + loanC + '/not-returned', {});
    check('tandai C tidak kembali', r.status === 200 && r.json.loan.status === 'tidak_kembali', JSON.stringify(r.json).slice(0, 200));
    r = await admin.req('/api/items/lookup?code=FD013612');
    check('stok C TETAP 2 (tidak kembali = stok tidak pulih)', r.json.item.stock === 2, 'stock=' + r.json.item.stock);
    ageSupplierLoan(loanC, 5); // dibawa 5 hari lalu
    r = await admin.req('/api/supplier-loans?status=terlambat');
    check('C yang tidak kembali TIDAK muncul sebagai terlambat', r.status === 200 && !(r.json.loans || []).some((x) => x.id === loanC), 'n=' + (r.json.loans && r.json.loans.length));
    r = await admin.req('/api/supplier-loans?status=tidak_kembali');
    check('list tidak_kembali: 1 pinjaman (C)', r.status === 200 && r.json.loans.length === 1, 'n=' + (r.json.loans && r.json.loans.length));
    r = await admin.j('/api/supplier-loans/' + loanC + '/return', { photo: PHOTO_1X1 });
    check('kembali setelah ditandai tidak kembali DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/supplier-loans/' + loanC + '/not-returned', {});
    check('tandai tidak kembali 2x DITOLAK (400)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/supplier-loans/99999/not-returned', {});
    check('tidak-kembali pinjaman tidak ada -> 404', r.status === 404, 'status=' + r.status);

    console.log('== 10. YOI / MOI tidak berubah oleh siklus dibawa-kembali ==');
    r = await admin.j('/api/take', { itemId: idD, qty: 2, machine: 'BLOWMOULD', takenBy: 'zico' });
    check('ambil D 2 pcs (pemakaian nyata, stok 4 -> 2)', r.status === 200 && r.json.balance === 2, JSON.stringify(r.json));
    r = await admin.req('/api/items/' + idD);
    const usageBefore = r.json.item.usage;
    check('D punya history pemakaian (totalOut 2)', usageBefore.hasHistory === true && usageBefore.totalOut === 2, JSON.stringify(usageBefore));
    r = await admin.j('/api/supplier-loans', { itemId: idD, qty: 1, supplier: 'PT Servis', purpose: 'service' });
    check('supplier bawa D 1 pc (stok 2 -> 1)', r.status === 200 && r.json.balance === 1, JSON.stringify(r.json).slice(0, 150));
    const loanD = r.json.loan.id;
    r = await admin.j('/api/supplier-loans/' + loanD + '/return', { photo: PHOTO_1X1 });
    check('kembali D 1 pc (stok 1 -> 2)', r.status === 200 && r.json.balance === 2, JSON.stringify(r.json).slice(0, 150));
    r = await admin.req('/api/items/' + idD);
    const usageAfter = r.json.item.usage;
    check('YOI/MOI D TETAP: totalOut 2, avgPerMonth sama', usageAfter.totalOut === 2 && usageAfter.avgPerMonth === usageBefore.avgPerMonth && usageAfter.moi === usageBefore.moi, 'sebelum=' + JSON.stringify(usageBefore) + ' sesudah=' + JSON.stringify(usageAfter));
    r = await admin.req('/api/items/' + idC);
    check('C (hanya dibawa-tidak-kembali) hasHistory false', r.json.item.usage.hasHistory === false && r.json.item.usage.totalOut === 0, JSON.stringify(r.json.item.usage));
    r = await admin.req('/api/takes/recent');
    const notes = (r.json.takes || []).map((t) => t.note);
    check('"Dibawa supplier" TIDAK muncul di "Pengambilan terakhir" tab Ambil', !notes.some((n) => String(n).startsWith('Dibawa supplier')), JSON.stringify(notes));

    console.log('== 11. Tanpa login (401) ==');
    r = await anon.req('/api/supplier-loans');
    check('GET /api/supplier-loans tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.j('/api/supplier-loans', { itemId: idA, qty: 1, supplier: 'X', purpose: 'contoh' });
    check('POST /api/supplier-loans tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.j('/api/supplier-loans/' + loanA + '/return', { photo: PHOTO_1X1 });
    check('POST /api/supplier-loans/:id/return tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.j('/api/supplier-loans/' + loanC + '/not-returned', {});
    check('POST /api/supplier-loans/:id/not-returned tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.req('/api/supplier-loans/' + loanA + '/return-photo');
    check('GET /api/supplier-loans/:id/return-photo tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.j('/api/settings/supplier-reminder-days', { days: 5 }, 'PUT');
    check('PUT setting pengingat tanpa login -> 401', r.status === 401, 'status=' + r.status);

    console.log('== 12. Detail peminjaman supplier (GET single) ==');
    r = await admin.req('/api/supplier-loans/' + loanA);
    check('GET /api/supplier-loans/:id memuat semua field detail (nama, Kode FD, qty, supplier, purpose, tanggal, status, foto)', r.status === 200 && r.json.loan.item_name === 'SEAL KARET 10MM' && r.json.loan.fd_code === 'FD013610' && r.json.loan.qty === 2 && r.json.loan.supplier === 'PT Maju Jaya' && r.json.loan.purpose === 'contoh' && r.json.loan.taken_at && r.json.loan.due_at && r.json.loan.status === 'dikembalikan' && r.json.loan.hasReturnPhoto === true && r.json.loan.non_stock === false && r.json.loan.reminder_days === 2 && !!r.json.loan.returned_at && r.json.loan.returned_by === 'zico', JSON.stringify(r.json.loan));
    r = await admin.req('/api/supplier-loans/' + loanNonStock);
    check('GET /api/supplier-loans/:id non-stok: manual_name/code + penanda non_stock', r.status === 200 && r.json.loan.non_stock === true && r.json.loan.manual_name === 'SEAL KARET CONTOH' && r.json.loan.manual_code === 'FD999999' && r.json.loan.item_name === 'SEAL KARET CONTOH', JSON.stringify(r.json.loan));
    r = await admin.req('/api/supplier-loans/' + loanC);
    check('GET /api/supplier-loans/:id tidak_kembali: status + returned_at/by', r.status === 200 && r.json.loan.status === 'tidak_kembali' && !!r.json.loan.returned_at && r.json.loan.returned_by === 'zico', JSON.stringify(r.json.loan));
    r = await admin.req('/api/supplier-loans/' + loanD);
    check('GET /api/supplier-loans/:id pinjaman service: purpose service + stok saat ini', r.status === 200 && r.json.loan.purpose === 'service' && r.json.loan.current_stock === 2, JSON.stringify(r.json.loan));
    r = await admin.req('/api/supplier-loans/99999');
    check('GET /api/supplier-loans/:id tidak ada -> 404', r.status === 404, 'status=' + r.status);
    r = await anon.req('/api/supplier-loans/' + loanA);
    check('GET /api/supplier-loans/:id tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await user.req('/api/supplier-loans/' + loanA);
    check('GET /api/supplier-loans/:id oleh User -> 403 (khusus Admin)', r.status === 403, 'status=' + r.status);
    r = await admin.req('/api/supplier-loans?status=all');
    const supById = {};
    for (const x of (r.json.loans || [])) supById[x.id] = x;
    check('GET /api/supplier-loans list memuat semua field detail (non_stock, reminder_days, hasReturnPhoto)', supById[loanA] && supById[loanA].non_stock === false && supById[loanA].reminder_days === 2 && supById[loanA].hasReturnPhoto === true && supById[loanNonStock] && supById[loanNonStock].non_stock === true && supById[loanNonStock].manual_code === 'FD999999', JSON.stringify(supById[loanA]));

    console.log('== 13. Frontend ter-serve ==');
    r = await admin.req('/index.html');
    check('index.html: tombol nav Supplier', r.text.includes('data-view="supplier"') && r.text.includes('🏭 Supplier'));
    check('index.html: view Supplier + form kode/scan/jumlah/supplier/tujuan/simpan', r.text.includes('id="view-supplier"') && r.text.includes('id="supplier-code"') && r.text.includes('btn-scan-supplier') && r.text.includes('id="supplier-qty"') && r.text.includes('id="supplier-name"') && r.text.includes('id="supplier-purpose"') && r.text.includes('btn-save-supplier'));
    check('index.html: blok part non-stok (pesan + nama manual)', r.text.includes('id="supplier-manual"') && r.text.includes('Kode tidak ada di stok') && r.text.includes('id="supplier-manual-name"'));
    check('index.html: input pengingat hari + tombol simpan', r.text.includes('id="supplier-reminder-days"') && r.text.includes('btn-save-supplier-reminder'));
    check('index.html: kartu pengingat + daftar aktif + history + filter', r.text.includes('id="supplier-alert"') && r.text.includes('id="supplier-active"') && r.text.includes('id="supplier-list"') && r.text.includes('id="supplier-filter"'));
    check('index.html: form pengembalian supplier + foto wajib + tombol tidak kembali', r.text.includes('id="return-box-supplier"') && r.text.includes('id="return-supplier-photo-camera"') && r.text.includes('btn-save-return-supplier'));
    check('index.html: kartu peringatan supplier di Dashboard', r.text.includes('id="dash-supplier-alert"'));
    check('index.html: view detail peminjaman (tombol kembali + konten)', r.text.includes('id="view-loan-detail"') && r.text.includes('id="loan-detail-content"') && r.text.includes('id="btn-back-loan-detail"'));
    r = await admin.req('/app.js');
    check('app.js: loadSupplierLoans + lookupSupplier + loadSupplierAlert', r.text.includes('loadSupplierLoans') && r.text.includes('lookupSupplier') && r.text.includes('loadSupplierAlert'));
    check('app.js: openLoanDetail + baris supplier bisa diklik (data-supplier-detail)', r.text.includes('openLoanDetail') && r.text.includes('data-supplier-detail') && r.text.includes("openLoanDetail('supplier'"));
    check('app.js: scan target supplier', r.text.includes("openScanner('supplier')") && r.text.includes("scanTarget === 'supplier'"));
    check('app.js: nav Supplier disembunyikan untuk User (pola SO)', r.text.includes('button[data-view="supplier"]'));
    check('app.js: guard showView Supplier hanya Admin', r.text.includes('Menu Supplier hanya untuk Admin.'));
    check('app.js: simpan supplier ke POST /api/supplier-loans + tidak-kembali', r.text.includes("'/api/supplier-loans'") && r.text.includes('/not-returned'));
    check('app.js: badge Terlambat + tombol Kembalikan + Tidak kembali', r.text.includes('⚠️ Terlambat') && r.text.includes('✅ Kembalikan') && r.text.includes('Tidak kembali'));
    check('app.js: simpan setting pengingat via PUT /api/settings/supplier-reminder-days', r.text.includes("'/api/settings/supplier-reminder-days'") && r.text.includes("'PUT'"));
    r = await admin.req('/sw.js');
    check('sw.js: CACHE v8', r.text.includes('gudang-sparepart-v8'));
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
