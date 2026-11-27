// Seed database utama: 10 baris pertama Sheet2 file Excel user.
// Memakai API impor server sendiri (mapping yang sama persis dengan fitur impor).
// Akun admin sementara dibuat dengan password acak sekali pakai, lalu DIHAPUS
// lagi langsung dari SQLite — supaya alur "buat password Admin saat pertama
// kali buka aplikasi" tetap utuh untuk user.
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { DatabaseSync } = require('node:sqlite');

const BASE = 'http://localhost:3102';
const SRC = '/home/hatch/workspace/user/files/DATA_RAK_SPAREPART_NOV.XLSX';
const MAIN_DB = '/home/hatch/workspace/gudang-sparepart-standalone/data/gudang.db';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}

(async () => {
  // 1. Potong Sheet2: header + 10 baris data pertama
  const wb = XLSX.readFile(SRC);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Sheet2'], { header: 1, defval: null });
  const head10 = rows.slice(0, 11);
  console.log('Sheet2 total baris:', rows.length, '| dipotong jadi:', head10.length, '(header + 10 data)');
  const wb10 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb10, XLSX.utils.aoa_to_sheet(head10), 'Sheet2');
  const tmpFile = '/tmp/seed-10-rows.xlsx';
  XLSX.writeFile(wb10, tmpFile);
  const buf = fs.readFileSync(tmpFile);

  // 2. Setup admin sementara (password acak sekali pakai, hanya di memori)
  const tmpPw = crypto.randomBytes(12).toString('hex');
  let r = await fetch(BASE + '/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: tmpPw, confirm: tmpPw }) });
  let j = await r.json();
  check('setup admin sementara di DB utama', r.status === 200 && j.ok, JSON.stringify(j));

  // 3. Login
  r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'zico', password: tmpPw }) });
  j = await r.json();
  const cookie = r.headers.get('set-cookie').split(';')[0];
  check('login admin sementara', r.status === 200 && j.role === 'admin', JSON.stringify(j));

  // 4. Impor via API (jalur yang sama dengan fitur impor aplikasi)
  r = await fetch(BASE + '/api/import/upload?filename=seed-10-rows.xlsx', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie }, body: buf });
  j = await r.json();
  check('upload file 10 baris', r.status === 200 && j.ok, JSON.stringify(j).slice(0, 200));
  const jobId = j.jobId;
  r = await fetch(BASE + '/api/import/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ jobId, sheet: 'Sheet2' }) });
  j = await r.json();
  console.log('     preview:', JSON.stringify({ total: j.total, valid: j.valid, invalid: j.invalid, empty: j.empty, duplicates: j.duplicates }));
  check('preview: total 10, valid 10', j.total === 10 && j.valid === 10, JSON.stringify(j));
  r = await fetch(BASE + '/api/import/batch', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ jobId, mode: 'skip', offset: 0 }) });
  j = await r.json();
  check('batch impor: 10 baru', j.done && j.inserted === 10, JSON.stringify(j));

  // 5. Verifikasi via API
  r = await fetch(BASE + '/api/stats', { headers: { Cookie: cookie } });
  j = await r.json();
  check('stats DB utama: 10 jenis barang', j.items === 10, 'items=' + j.items);
  r = await fetch(BASE + '/api/items?perPage=100&page=1', { headers: { Cookie: cookie } });
  j = await r.json();
  const items = j.items;
  check('semua nama huruf kapital', items.every((i) => i.name === i.name.toUpperCase()));
  check('semua Kode FD terisi', items.every((i) => i.fd_code && i.fd_code.startsWith('FD')));
  console.log('     10 barang awal:');
  for (const it of items) console.log('      -', it.fd_code, '|', it.name, '| stok', it.stock, it.unit, '| rak', it.rack || '-', '| shaf', it.shelf || '-', '| box', it.jolly_box || '-', '|', it.category || '-');
  const first = items.find((i) => i.fd_code === 'FD013610');
  check('FD013610 ada, stok 2', !!first && first.stock === 2, JSON.stringify(first));

  // 6. Hapus akun admin sementara + sesi langsung dari SQLite
  const db = new DatabaseSync(MAIN_DB);
  db.exec("DELETE FROM sessions; DELETE FROM accounts;");
  const accCount = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
  const itemCount = db.prepare('SELECT COUNT(*) c FROM items').get().c;
  const moveCount = db.prepare('SELECT COUNT(*) c FROM moves').get().c;
  check('akun admin sementara terhapus (0 akun)', accCount === 0, 'accounts=' + accCount);
  check('10 barang tetap ada setelah hapus akun', itemCount === 10, 'items=' + itemCount);
  console.log('     moves tercatat:', moveCount);
  db.close();

  // 7. Status akhir: setupNeeded harus true lagi (user buat password sendiri)
  r = await fetch(BASE + '/api/status');
  j = await r.json();
  check('setupNeeded=true lagi (alur pertama utuh)', j.setupNeeded === true, JSON.stringify(j));

  console.log('\nHASIL SEED: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR SEED:', e); process.exit(2); });
