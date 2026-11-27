// Verifikasi peringatan Kode FD duplikat di form Tambah/Ubah — server uji terpisah (DB /tmp/fd-test.db, port 3110).
// TIDAK menyentuh database utama. Jalankan: node test-fd.js
const fs = require('fs');
const { spawn } = require('child_process');

const BASE = 'http://localhost:3110';
const DB_PATH = '/tmp/fd-test.db';
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
    return { status: r.status, text: Buffer.from(await r.arrayBuffer()).toString('utf8') };
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
    env: Object.assign({}, process.env, { PORT: '3110', DB_PATH }),
    stdio: 'ignore',
  });
  let code = 0;
  try {
    if (!(await waitUp())) { console.log('FAIL server uji tidak jalan'); process.exit(1); }

    console.log('== 1. Setup & login ==');
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
    r = await admin.j('/api/items', { name: 'SHAFT FD', fd_code: 'FD013610', stock: 2, unit: 'PCS', rack: 'RAK 2', shelf: 'F.1', jolly_box: '18', category: 'BLOWMOULD' });
    check('buat barang A FD013610 stok 2 rak RAK 2', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    const idA = r.json.id;
    r = await admin.j('/api/items', { name: 'BAUT FD', fd_code: 'FD013611', barcode: 'BARB001', stock: 10, unit: 'PCS', rack: 'RAK 3', shelf: 'G.1', jolly_box: '7', category: 'BAUT' });
    check('buat barang B FD013611 + barcode BARB001', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));
    r = await admin.j('/api/items', { name: 'MUR KECIL', fd_code: 'fd013612', stock: 0, unit: 'PCS' });
    check('buat barang C fd kecil fd013612 (tersimpan huruf kecil)', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 120));

    console.log('== 3. Endpoint lookup (dipakai cek duplikat) ==');
    r = await admin.req('/api/items/lookup?code=' + encodeURIComponent('FD013610'));
    check('lookup FD013610 persis → 200 + barang A', r.status === 200 && r.json.item && r.json.item.id === idA && r.json.item.name === 'SHAFT FD' && r.json.item.stock === 2 && r.json.item.rack === 'RAK 2', JSON.stringify(r.json).slice(0, 200));
    r = await admin.req('/api/items/lookup?code=' + encodeURIComponent('fd013610'));
    check('lookup fd013610 huruf kecil → 200 + barang A (abaikan huruf)', r.status === 200 && r.json.item && r.json.item.id === idA, 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=' + encodeURIComponent('FD013610 '));
    check('lookup "FD013610 " spasi ujung → 200 + barang A (trim)', r.status === 200 && r.json.item && r.json.item.id === idA, 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=' + encodeURIComponent('FD013612'));
    check('lookup FD013612 huruf besar → 200, temukan barang C yg tersimpan huruf kecil', r.status === 200 && r.json.item && r.json.item.name === 'MUR KECIL', 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=' + encodeURIComponent('BARB001'));
    check('lookup barcode BARB001 → 200 + barang B', r.status === 200 && r.json.item && r.json.item.name === 'BAUT FD', 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=' + encodeURIComponent('barb001'));
    check('lookup barb001 huruf kecil → 200 + barang B', r.status === 200 && r.json.item && r.json.item.name === 'BAUT FD', 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=' + encodeURIComponent('FD999999'));
    check('lookup FD999999 tidak dikenal → 404', r.status === 404, 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=');
    check('lookup kode kosong → 400', r.status === 400, 'status=' + r.status);
    r = await anon.req('/api/items/lookup?code=' + encodeURIComponent('FD013610'));
    check('lookup tanpa login → 401', r.status === 401, 'status=' + r.status);
    r = await user.req('/api/items/lookup?code=' + encodeURIComponent('FD013610'));
    check('lookup oleh User → 200 (lookup dipakai Ambil/SO)', r.status === 200 && r.json.item && r.json.item.id === idA, 'status=' + r.status);

    console.log('== 4. Server tetap izinkan FD sama via API (peringatan hanya di UI) ==');
    r = await admin.j('/api/items', { name: 'SHAFT DUPLIKAT', fd_code: 'FD013610', stock: 1, unit: 'PCS' });
    check('API buat barang FD013610 kedua → 200 (server tidak blokir; UI yg beri peringatan)', r.status === 200 && r.json.id, 'status=' + r.status + ' ' + JSON.stringify(r.json).slice(0, 120));

    console.log('== 5. Verifikasi level kode (client) ==');
    const appJs = fs.readFileSync(__dirname + '/public/app.js', 'utf8');
    const indexHtml = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
    const serverJs = fs.readFileSync(__dirname + '/server.js', 'utf8');
    const swJs = fs.readFileSync(__dirname + '/public/sw.js', 'utf8');
    const styleCss = fs.readFileSync(__dirname + '/public/style.css', 'utf8');
    check('server: lookup pakai UPPER(fd_code)/UPPER(barcode)', serverJs.includes('UPPER(fd_code) = UPPER(?)') && serverJs.includes('UPPER(barcode) = UPPER(?)'));
    check('index: elemen #add-fd-warning tepat di bawah #add-fd', indexHtml.indexOf('id="add-fd"') > -1 && indexHtml.indexOf('id="add-fd-warning"') > indexHtml.indexOf('id="add-fd"') && indexHtml.indexOf('id="add-fd-warning"') < indexHtml.indexOf('id="add-barcode"'));
    check('style: ada .warn-box', styleCss.includes('.warn-box'));
    check('app: ada fungsi checkFdDuplicate', appJs.includes('async function checkFdDuplicate()'));
    check('app: cek debounce 400ms saat mengetik', appJs.includes("setTimeout(() => { checkFdDuplicate(); }, 400)"));
    check('app: cek saat blur field Kode FD', appJs.includes("$('#add-fd').addEventListener('blur'"));
    check('app: teks peringatan duplikat lengkap', appJs.includes('Kode FD sudah dipakai:') && appJs.includes('impor Excel (mode update), jangan tambah baru.') && appJs.includes("Kalau ini barang yang sama, pakai"));
    check('app: peringatan tampilkan nama + stok + rak', appJs.includes("esc(item.name)") && appJs.includes("fmt(item.stock)") && appJs.includes("esc(item.rack"));
    check('app: ubah abaikan barang sendiri (editingId)', appJs.includes('item.id === parseInt(editingId, 10)'));
    check('app: confirm simpan saat duplikat (tambah)', appJs.includes('Tetap simpan sebagai barang baru?'));
    check('app: confirm simpan saat duplikat (ubah)', appJs.includes('Tetap simpan perubahan ini?'));
    check('app: submit menunggu cek segar sebelum simpan', appJs.includes('const dup = await checkFdDuplicate();'));
    check('app: reset form bersihkan peringatan + fdDupItem', appJs.includes("fdDupItem = null;") && appJs.includes("$('#add-fd-warning').classList.add('hidden')"));
    check('sw.js: CACHE v7', swJs.includes("gudang-sparepart-v7"));

    console.log('\n' + pass + ' lolos, ' + fail + ' gagal.');
    code = fail ? 1 : 0;
  } finally {
    server.kill();
  }
  process.exit(code);
})();
