// Suite uji Gudang Sparepart standalone (database uji test.db)
const fs = require('fs');
const XLSX = require('xlsx');
const BASE = 'http://localhost:3101';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
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
    if (ct.includes('application/json')) return { status: r.status, json: await r.json() };
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  }
  j(path, body, method = 'POST') {
    return this.req(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
}
(async () => {
  console.log('== 1. Setup & login Admin ==');
  const anon = new Jar();
  let r = await anon.j('/api/setup', { password: 'admin123', confirm: 'admin123' });
  check('setup admin zico', r.status === 200 && r.json.ok, JSON.stringify(r.json));
  r = await anon.j('/api/setup', { password: 'x', confirm: 'x' });
  check('setup kedua ditolak', r.status === 400, 'status=' + r.status);
  const admin = new Jar();
  r = await admin.j('/api/login', { username: 'zico', password: 'admin123' });
  check('login zico', r.status === 200 && r.json.role === 'admin', JSON.stringify(r.json));
  r = await admin.j('/api/login', { username: 'zico', password: 'salah' });
  check('login password salah ditolak', r.status === 401, 'status=' + r.status);
  r = await admin.req('/api/me');
  check('me = zico/admin', r.json.username === 'zico' && r.json.role === 'admin');

  console.log('== 2. Akun User & penolakan peran ==');
  r = await admin.j('/api/accounts', { username: 'budi', password: 'budi1234', role: 'user' });
  check('admin buat akun user budi', r.status === 200 && r.json.username === 'budi', JSON.stringify(r.json));
  const user = new Jar();
  r = await user.j('/api/login', { username: 'budi', password: 'budi1234' });
  check('login budi', r.status === 200 && r.json.role === 'user', JSON.stringify(r.json));
  r = await user.j('/api/items', { name: 'TEST', stock: 1 });
  check('user tambah barang DITOLAK (403)', r.status === 403, 'status=' + r.status);
  r = await user.j('/api/items/1', undefined, 'DELETE');
  check('user hapus barang DITOLAK (403)', r.status === 403, 'status=' + r.status);
  r = await user.req('/api/import/upload?filename=x.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x') });
  check('user impor DITOLAK (403)', r.status === 403, 'status=' + r.status);
  r = await user.req('/api/accounts');
  check('user lihat daftar akun DITOLAK (403)', r.status === 403, 'status=' + r.status);

  console.log('== 3. Impor Excel asli (Sheet2, 1.461 baris) ==');
  const buf = fs.readFileSync('/home/hatch/workspace/user/files/DATA_RAK_SPAREPART_NOV.XLSX');
  r = await admin.req('/api/import/upload?filename=DATA_RAK_SPAREPART_NOV.XLSX', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
  check('upload excel', r.status === 200 && r.json.ok, JSON.stringify(r.json).slice(0, 200));
  const jobId = r.json.jobId;
  const sheet2 = r.json.sheets.find((s) => s.name === 'Sheet2');
  check('Sheet2 terdeteksi 1462 baris', sheet2 && sheet2.rows === 1462, JSON.stringify(sheet2));
  check('mapping Sheet2: name+fd+stock terdeteksi', sheet2.mapping.name !== undefined && sheet2.mapping.fd_code !== undefined && sheet2.mapping.stock !== undefined, JSON.stringify(sheet2.mapping));
  r = await admin.j('/api/import/preview', { jobId, sheet: 'Sheet2' });
  check('preview: total 1461', r.json.total === 1461, 'total=' + r.json.total);
  check('preview: valid > 1400', r.json.valid > 1400, 'valid=' + r.json.valid);
  console.log('     preview:', JSON.stringify({ total: r.json.total, valid: r.json.valid, invalid: r.json.invalid, empty: r.json.empty, duplicates: r.json.duplicates }));
  let offset = 0, ins = 0, upd = 0, skip = 0, done = false, batches = 0;
  while (!done && batches < 20) {
    r = await admin.j('/api/import/batch', { jobId, mode: 'skip', offset });
    ins += r.json.inserted; upd += r.json.updated; skip += r.json.skipped;
    offset = r.json.processed; done = r.json.done; batches++;
  }
  check('impor batch selesai', done, 'batches=' + batches);
  console.log('     impor: inserted=' + ins + ' updated=' + upd + ' skipped=' + skip);
  check('1461 baris masuk', ins === 1461, 'inserted=' + ins);

  console.log('== 4. Verifikasi data impor ==');
  r = await admin.req('/api/stats');
  check('stats: 1461 jenis barang', r.json.items === 1461, 'items=' + r.json.items);
  r = await admin.req('/api/items/lookup?code=FD013610');
  check('lookup FD013610 ketemu', r.status === 200 && r.json.item.name === '1 SHAFT#JXS00-04B', JSON.stringify(r.json).slice(0, 200));
  check('FD013610 stok = 2 (dari Unrestricted, Opname kosong)', r.json.item.stock === 2, 'stock=' + r.json.item.stock);
  check('FD013610 rak=RAK 2 shaf=F.1 box=18 kategori=BLOWMOULD satuan=PCS',
    r.json.item.rack === 'RAK 2' && r.json.item.shelf === 'F.1' && r.json.item.jolly_box === '18' && r.json.item.category === 'BLOWMOULD' && r.json.item.unit === 'PCS',
    JSON.stringify(r.json.item));
  const fdId = r.json.item.id;
  r = await admin.req('/api/items?search=SHAFT&page=1&perPage=5');
  check('pencarian SHAFT jalan', r.json.items.length > 0);
  const allCaps = await admin.req('/api/items?perPage=100&page=1');
  const notCaps = allCaps.json.items.filter((i) => i.name !== i.name.toUpperCase());
  check('semua nama huruf kapital', notCaps.length === 0, 'pelanggar=' + notCaps.length);
  const noFd = await admin.req('/api/items?filter=all&perPage=100&page=1');
  const fdCount = noFd.json.items.filter((i) => i.fd_code).length;
  check('Kode FD terisi (sampel 100 pertama)', fdCount > 90, 'fd=' + fdCount);

  console.log('== 5. Impor ulang (duplikat) ==');
  r = await admin.req('/api/import/upload?filename=DATA_RAK_SPAREPART_NOV.XLSX', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf });
  const job2 = r.json.jobId;
  r = await admin.j('/api/import/preview', { jobId: job2, sheet: 'Sheet2' });
  check('preview ulang: duplikat terdeteksi 1461', r.json.duplicates === 1461, 'dup=' + r.json.duplicates);
  let off2 = 0, ins2 = 0, sk2 = 0, done2 = false;
  while (!done2) {
    r = await admin.j('/api/import/batch', { jobId: job2, mode: 'skip', offset: off2 });
    ins2 += r.json.inserted; sk2 += r.json.skipped; off2 = r.json.processed; done2 = r.json.done;
  }
  check('impor ulang mode skip: 0 baru, semua dilewati', ins2 === 0 && sk2 >= 1461, 'ins=' + ins2 + ' skip=' + sk2);
  r = await admin.req('/api/stats');
  check('jumlah barang tetap 1461 setelah impor ulang', r.json.items === 1461, 'items=' + r.json.items);

  console.log('== 6. Pengambilan (Ambil) ==');
  r = await user.j('/api/take', { itemId: fdId, qty: 1, machine: 'BLOWMOULD', takenBy: 'Budi' });
  check('user boleh ambil (stok 2->1)', r.status === 200 && r.json.balance === 1, JSON.stringify(r.json));
  r = await admin.req('/api/items/' + fdId);
  check('kartu stok mencatat pengambilan + mesin + pengambil',
    r.json.card.length > 0 && JSON.stringify(r.json.card).includes('BUDI') && JSON.stringify(r.json.card).includes('BLOWMOULD'),
    JSON.stringify(r.json.card).slice(0, 300));
  r = await user.j('/api/take', { itemId: fdId, qty: 5, machine: 'X', takenBy: 'Budi' });
  check('ambil melebihi stok ditolak + pesan jelas', r.status === 400 && /Stok tidak cukup/.test(r.json.error || '') && /Sisa 1/.test(r.json.error || ''), JSON.stringify(r.json));
  r = await admin.req('/api/out-history?date=' + new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0'));
  check('history keluar hari ini mencatat 1 unit', r.json.total === 1, 'total=' + r.json.total);
  r = await admin.req('/api/history');
  check('riwayat 60 terakhir jalan', r.json.mode === 'recent' && r.json.rows.length > 0);

  console.log('== 7. Ekspor Excel kartu stok ==');
  r = await admin.req('/api/items/' + fdId + '/export');
  check('ekspor 200 + xlsx', r.status === 200 && r.buf.length > 1000, 'status=' + r.status + ' len=' + (r.buf && r.buf.length));
  const wb = XLSX.read(r.buf, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const headerRow = rows.find((x) => x && x[0] === 'Tanggal');
  check('ekspor punya kolom Mesin & Diambil oleh', headerRow && headerRow[5] === 'Mesin' && headerRow[6] === 'Diambil oleh', JSON.stringify(headerRow));
  const takeRow = rows.find((x) => x && x[1] === 'Pengambilan');
  check('baris pengambilan ada mesin+pengambil di ekspor', takeRow && takeRow[5] === 'BLOWMOULD' && takeRow[6] === 'BUDI', JSON.stringify(takeRow));

  console.log('== 8. Ubah/hapus foto & proteksi ==');
  r = await admin.j('/api/items', { name: 'barang foto test', stock: 3, photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
  const fotoId = r.json.id;
  check('tambah barang dgn foto', r.status === 200 && fotoId, JSON.stringify(r.json));
  r = await admin.j('/api/items/' + fotoId, { name: 'BARANG FOTO TEST', stock: 5 }, 'PUT');
  check('ubah tanpa foto: sukses', r.status === 200, JSON.stringify(r.json));
  r = await admin.req('/api/items/' + fotoId);
  check('foto lama TIDAK hilang setelah ubah', !!r.json.item.photo, 'hasPhoto=' + !!r.json.item.photo);
  r = await user.j('/api/items/' + fotoId, { name: 'X', stock: 1 }, 'PUT');
  check('user ubah barang DITOLAK (403)', r.status === 403, 'status=' + r.status);
  r = await admin.j('/api/items/' + fotoId, undefined, 'DELETE');
  check('admin hapus barang', r.status === 200, JSON.stringify(r.json));

  console.log('== 9. Ganti password & hapus akun ==');
  r = await admin.j('/api/accounts/' + 2 + '/password', { password: 'baru1234' });
  check('admin ganti password user', r.status === 200, JSON.stringify(r.json));
  const user2 = new Jar();
  r = await user2.j('/api/login', { username: 'budi', password: 'baru1234' });
  check('login budi dgn password baru', r.status === 200, JSON.stringify(r.json));
  r = await admin.j('/api/accounts/1', undefined, 'DELETE');
  check('hapus akun admin DITOLAK', r.status === 400, 'status=' + r.status);

  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR SUITE:', e); process.exit(2); });
