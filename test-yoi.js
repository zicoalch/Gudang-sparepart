// Verifikasi YOI / MOI — server uji terpisah (DB /tmp/yoi-test.db, port 3103).
// TIDAK menyentuh database utama. Jalankan: node test-yoi.js
const fs = require('fs');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BASE = 'http://localhost:3103';
const DB_PATH = '/tmp/yoi-test.db';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const approx = (a, b, tol) => a != null && Math.abs(a - b) <= (tol || 0.001);
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
    return { status: r.status, text: await r.text() };
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
    env: Object.assign({}, process.env, { PORT: '3103', DB_PATH }),
    stdio: 'ignore',
  });
  try {
    if (!(await waitUp())) { console.log('FAIL server uji tidak jalan'); process.exit(1); }
    const admin = new Jar();
    let r = await admin.j('/api/setup', { password: 'admin123', confirm: 'admin123' });
    check('setup admin', r.status === 200 && r.json.ok, JSON.stringify(r.json));
    r = await admin.j('/api/login', { username: 'zico', password: 'admin123' });
    check('login admin', r.status === 200 && r.json.role === 'admin');

    console.log('== 1. Kasus contoh tugas: stok 12, rata-rata 3/bln -> MOI 4,0 / YOI 0,33 ==');
    r = await admin.j('/api/items', { name: 'BARANG UJI MOI', fd_code: 'FD-TEST-1', stock: 15, unit: 'PCS' });
    check('buat barang A (stok 15)', r.status === 200 && r.json.id, JSON.stringify(r.json));
    const idA = r.json.id;
    r = await admin.j('/api/take', { itemId: idA, qty: 3, machine: 'BLOWMOULD', takenBy: 'Budi' });
    check('ambil 3 -> stok 12', r.status === 200 && r.json.balance === 12, JSON.stringify(r.json));
    r = await admin.req('/api/items/' + idA);
    const uA = r.json.item.usage;
    console.log('     usage A:', JSON.stringify(uA));
    check('A: ada history', uA.hasHistory === true);
    check('A: bulan terhitung 1', uA.months === 1, 'months=' + uA.months);
    check('A: rata-rata 3/bln', approx(uA.avgPerMonth, 3), 'avg=' + uA.avgPerMonth);
    check('A: MOI 4,0', approx(uA.moi, 4.0), 'moi=' + uA.moi);
    check('A: YOI 0,33', approx(uA.yoi, 1 / 3, 0.005), 'yoi=' + uA.yoi);

    console.log('== 2. Tanpa history -> "-" (moi null) ==');
    r = await admin.j('/api/items', { name: 'BARANG TANPA HISTORY', fd_code: 'FD-TEST-2', stock: 5, unit: 'PCS' });
    const idB = r.json.id;
    r = await admin.req('/api/items/' + idB);
    const uB = r.json.item.usage;
    check('B: tidak ada history', uB.hasHistory === false);
    check('B: moi null', uB.moi === null && uB.yoi === null, JSON.stringify(uB));

    console.log('== 3. Riwayat 3 bulan: 9 dipakai selama 3 bulan, stok 12 -> MOI 4,0 / YOI 0,33 ==');
    r = await admin.j('/api/items', { name: 'BARANG RIWAYAT 3 BULAN', fd_code: 'FD-TEST-3', stock: 12, unit: 'PCS' });
    const idC = r.json.id;
    const db = new DatabaseSync(DB_PATH);
    const ins = db.prepare("INSERT INTO moves (item_id, date, kind, qty, balance, machine, taken_by, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    ins.run(idC, isoDaysAgo(90), 'out', 3, 9, 'BLOWMOULD', 'Budi', 'Pengambilan', isoDaysAgo(90) + 'T08:00:00.000Z');
    ins.run(idC, isoDaysAgo(60), 'out', 3, 6, 'CONVEYOR', 'Siti', 'Pengambilan', isoDaysAgo(60) + 'T08:00:00.000Z');
    ins.run(idC, isoDaysAgo(30), 'out', 3, 3, 'LABEL', 'Budi', 'Pengambilan', isoDaysAgo(30) + 'T08:00:00.000Z');
    // koreksi opname (qty besar) TIDAK boleh mengubah rata-rata pemakaian
    ins.run(idC, isoDaysAgo(60), 'out', 100, 0, '', '', 'Opname impor Excel', isoDaysAgo(60) + 'T09:00:00.000Z');
    db.close();
    r = await admin.req('/api/items/' + idC);
    const uC = r.json.item.usage;
    console.log('     usage C:', JSON.stringify(uC));
    check('C: total keluar 9 (opname tidak dihitung)', uC.totalOut === 9, 'totalOut=' + uC.totalOut);
    check('C: bulan terhitung 3', uC.months === 3, 'months=' + uC.months);
    check('C: rata-rata 3/bln', approx(uC.avgPerMonth, 3), 'avg=' + uC.avgPerMonth);
    check('C: MOI 4,0', approx(uC.moi, 4.0), 'moi=' + uC.moi);
    check('C: YOI 0,33', approx(uC.yoi, 1 / 3, 0.005), 'yoi=' + uC.yoi);

    console.log('== 4. Stok habis -> MOI 0,0 ==');
    r = await admin.j('/api/items', { name: 'BARANG HABIS', fd_code: 'FD-TEST-4', stock: 3, unit: 'PCS' });
    const idD = r.json.id;
    r = await admin.j('/api/take', { itemId: idD, qty: 3, machine: '', takenBy: 'Budi' });
    check('ambil semua -> stok 0', r.status === 200 && r.json.balance === 0);
    r = await admin.req('/api/items/' + idD);
    const uD = r.json.item.usage;
    check('D: MOI 0', uD.moi === 0, 'moi=' + uD.moi);
    check('D: YOI 0', uD.yoi === 0, 'yoi=' + uD.yoi);

    console.log('== 5. Daftar Inventaris ikut membawa usage ==');
    r = await admin.req('/api/items?perPage=50');
    const rowA = r.json.items.find((x) => x.fd_code === 'FD-TEST-1');
    const rowB = r.json.items.find((x) => x.fd_code === 'FD-TEST-2');
    check('list: A punya usage MOI 4,0', rowA && approx(rowA.usage.moi, 4.0), JSON.stringify(rowA && rowA.usage));
    check('list: B tanpa history (moi null)', rowB && rowB.usage.moi === null, JSON.stringify(rowB && rowB.usage));

    console.log('== 6. Frontend baru ikut ter-serve ==');
    r = await admin.req('/app.js');
    check('app.js memuat fmtMoi + kartu YOI/MOI', r.text.includes('fmtMoi') && r.text.includes('Pemakaian — YOI / MOI') && r.text.includes('<dt>MOI</dt>'));
    r = await admin.req('/index.html');
    check('index.html memuat penjelasan MOI/YOI', r.text.includes('MOI = stok / rata-rata pakai per bulan'));
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
