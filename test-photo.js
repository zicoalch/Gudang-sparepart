// Verifikasi "Cari pakai Foto" — server uji terpisah (DB /tmp/photo-test.db, port 3107).
// TIDAK menyentuh database utama. Jalankan: node test-photo.js
const fs = require('fs');
const { spawn } = require('child_process');
const Jimp = require('jimp');

const BASE = 'http://localhost:3107';
const DB_PATH = '/tmp/photo-test.db';
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

// Gambar sintetis yang berbeda jelas (seperti prototipe kalibrasi)
async function makePhoto(kind) {
  const img = new Jimp(400, 300, 0xffffffff);
  if (kind === 'A') {
    for (let y = 60; y < 240; y++) for (let x = 80; x < 320; x++) img.setPixelColor(Jimp.rgbaToInt(220, 40, 40, 255), x, y);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
      const dx = x - 200, dy = y - 150;
      if (dx * dx + dy * dy < 50 * 50) img.setPixelColor(Jimp.rgbaToInt(240, 210, 40, 255), x, y);
    }
  } else if (kind === 'B') {
    for (let y = 40; y < 260; y++) for (let x = 100; x < 300; x++) img.setPixelColor(Jimp.rgbaToInt(40, 80, 220, 255), x, y);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
      if (y > 200 - Math.abs(x - 200) * 0.7 && y < 240) img.setPixelColor(Jimp.rgbaToInt(40, 200, 90, 255), x, y);
    }
  } else if (kind === 'C') {
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) img.setPixelColor(Jimp.rgbaToInt(180, 180, 180, 255), x, y);
    for (let x = 0; x < 400; x++) for (let y = 140; y < 160; y++) img.setPixelColor(Jimp.rgbaToInt(20, 20, 20, 255), x, y);
  } else if (kind === 'U') { // tidak berhubungan: kuning polos + lingkaran ungu
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) img.setPixelColor(Jimp.rgbaToInt(240, 230, 60, 255), x, y);
    for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
      const dx = x - 120, dy = y - 90;
      if (dx * dx + dy * dy < 40 * 40) img.setPixelColor(Jimp.rgbaToInt(150, 60, 200, 255), x, y);
    }
  }
  const buf = await img.quality(85).getBufferAsync(Jimp.MIME_JPEG);
  return 'data:image/jpeg;base64,' + buf.toString('base64');
}
async function cropRotate(dataUri) {
  const buf = Buffer.from(dataUri.split(',')[1], 'base64');
  const img = await Jimp.read(buf);
  const out = await img.clone().crop(40, 30, 320, 240).rotate(10).quality(85).getBufferAsync(Jimp.MIME_JPEG);
  return 'data:image/jpeg;base64,' + out.toString('base64');
}

(async () => {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: '3107', DB_PATH }),
    stdio: 'ignore',
  });
  try {
    if (!(await waitUp())) { console.log('FAIL server uji tidak jalan'); process.exit(1); }
    const admin = new Jar();
    let r = await admin.j('/api/setup', { password: 'admin123', confirm: 'admin123' });
    check('setup admin', r.status === 200 && r.json.ok);
    r = await admin.j('/api/login', { username: 'zico', password: 'admin123' });
    check('login admin', r.status === 200 && r.json.role === 'admin');

    const photoA = await makePhoto('A');
    const photoB = await makePhoto('B');
    const photoC = await makePhoto('C');
    const photoU = await makePhoto('U');

    console.log('== 1. Buat 3 barang berfoto + 1 tanpa foto; sidik terhitung saat upload ==');
    r = await admin.j('/api/items', { name: 'BARANG MERAH', fd_code: 'FD-PHOTO-A', stock: 5, photo: photoA });
    check('buat barang A berfoto', r.status === 200 && r.json.id, JSON.stringify(r.json));
    const idA = r.json.id;
    r = await admin.j('/api/items', { name: 'BARANG BIRU', fd_code: 'FD-PHOTO-B', stock: 3, photo: photoB });
    const idB = r.json.id;
    check('buat barang B berfoto', r.status === 200 && r.json.id);
    r = await admin.j('/api/items', { name: 'BARANG ABU', fd_code: 'FD-PHOTO-C', stock: 2, photo: photoC });
    const idC = r.json.id;
    check('buat barang C berfoto', r.status === 200 && r.json.id);
    r = await admin.j('/api/items', { name: 'BARANG TANPA FOTO', fd_code: 'FD-PHOTO-D', stock: 7 });
    const idD = r.json.id;
    check('buat barang D tanpa foto', r.status === 200 && r.json.id);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    const hashes = db.prepare("SELECT fd_code, length(photo_hash) hl FROM items WHERE photo != ''").all();
    check('sidik tersimpan untuk 3 barang berfoto', hashes.length === 3 && hashes.every((x) => x.hl === 16), JSON.stringify(hashes));
    check('barang tanpa foto tidak punya sidik', db.prepare("SELECT photo_hash FROM items WHERE id = ?").get(idD).photo_hash === '');
    db.close();

    console.log('== 2. Cari dengan foto yang sama persis -> barang itu ranking 1, skor 1.0 ==');
    r = await admin.j('/api/search/photo', { photo: photoA });
    check('search exact status 200', r.status === 200 && r.json.ok, JSON.stringify(r.json).slice(0, 200));
    const top1 = r.json.results[0];
    console.log('     hasil exact-A:', JSON.stringify(r.json.results));
    check('exact: ranking 1 = A', top1 && top1.fd_code === 'FD-PHOTO-A', JSON.stringify(top1));
    check('exact: skor 1.0', top1 && top1.score === 1, 'skor=' + (top1 && top1.score));
    check('exact: hasMatch true', r.json.hasMatch === true);
    check('exact: D tanpa foto tidak muncul', !r.json.results.some((x) => x.fd_code === 'FD-PHOTO-D'));
    check('exact: withPhoto=3', r.json.withPhoto === 3, 'withPhoto=' + r.json.withPhoto);

    console.log('== 3. Cari dengan foto sama tapi di-crop/diputar -> barang itu tetap di 3 teratas ==');
    const photoCrop = await cropRotate(photoA);
    r = await admin.j('/api/search/photo', { photo: photoCrop });
    console.log('     hasil crop-A:', JSON.stringify(r.json.results));
    const rankA = r.json.results.findIndex((x) => x.fd_code === 'FD-PHOTO-A');
    check('crop: A di 3 teratas', rankA >= 0 && rankA < 3, 'rank=' + rankA);
    check('crop: A ranking 1', rankA === 0, 'rank=' + rankA);
    check('crop: hasMatch true', r.json.hasMatch === true);

    console.log('== 4. Cari dengan foto tak berhubungan -> tidak ada yang mirip ==');
    r = await admin.j('/api/search/photo', { photo: photoU });
    console.log('     hasil unrelated:', JSON.stringify(r.json.results));
    check('unrelated: hasMatch false', r.json.hasMatch === false);
    check('unrelated: skor terbaik < 0.6', r.json.results.length === 0 || r.json.results[0].score < 0.6, 'best=' + (r.json.results[0] && r.json.results[0].score));

    console.log('== 5. Backfill: barang berfoto lama tanpa sidik ikut ditemukan ==');
    const db2 = new DatabaseSync(DB_PATH);
    const ins = db2.prepare("INSERT INTO items (name, barcode, fd_code, stock, rack, unit, shelf, jolly_box, category, notes, photo, photo_hash, photo_hist, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const now = new Date().toISOString();
    const idE = ins.run('BARANG LAMA TANPA SIDIK', '', 'FD-PHOTO-E', 4, '', 'PCS', '', '', '', '', photoB, '', '', now, now).lastInsertRowid;
    db2.close();
    check('sisipkan barang E (foto B, tanpa sidik)', !!idE);
    r = await admin.j('/api/search/photo', { photo: photoB });
    console.log('     hasil exact-B:', JSON.stringify(r.json.results));
    const hitE = r.json.results.find((x) => x.fd_code === 'FD-PHOTO-E');
    check('backfill: E ditemukan saat cari foto B', !!hitE, JSON.stringify(r.json.results));
    check('backfill: pendingBackfill habis (0)', r.json.pendingBackfill === 0, 'pending=' + r.json.pendingBackfill);
    const db3 = new DatabaseSync(DB_PATH);
    check('backfill: sidik E tersimpan di DB', db3.prepare("SELECT length(photo_hash) hl FROM items WHERE id = ?").get(idE).hl === 16);
    db3.close();

    console.log('== 6. Endpoint foto + otorisasi ==');
    r = await admin.req('/api/items/' + idA + '/photo');
    check('GET foto A -> 200 image/jpeg', r.status === 200 && (r.headers.get('content-type') || '').includes('image/jpeg'), 'status=' + r.status + ' ct=' + r.headers.get('content-type'));
    check('GET foto A -> isi gambar (buffer > 1KB)', r.buf && r.buf.length > 1000, 'len=' + (r.buf && r.buf.length));
    r = await admin.req('/api/items/' + idD + '/photo');
    check('GET foto D (tanpa foto) -> 404', r.status === 404, 'status=' + r.status);
    const anon = new Jar();
    r = await anon.j('/api/search/photo', { photo: photoA });
    check('tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await admin.j('/api/accounts', { username: 'budi', password: 'user123', role: 'user' });
    check('buat akun User budi', r.status === 200, JSON.stringify(r.json));
    const user = new Jar();
    r = await user.j('/api/login', { username: 'budi', password: 'user123' });
    check('login User budi', r.status === 200 && r.json.role === 'user');
    r = await user.j('/api/search/photo', { photo: photoA });
    check('User boleh cari pakai foto (200)', r.status === 200 && r.json.results[0] && r.json.results[0].fd_code === 'FD-PHOTO-A', 'status=' + r.status);
    r = await admin.j('/api/search/photo', { photo: 'bukan-data-uri' });
    check('foto tidak valid -> 400', r.status === 400, 'status=' + r.status);

    console.log('== 7. Statistik + frontend ikut ter-serve ==');
    r = await admin.req('/api/stats');
    check('stats membawa withPhoto=4', r.json.withPhoto === 4, 'withPhoto=' + r.json.withPhoto);
    r = await admin.req('/index.html');
    check('index.html memuat view Cari pakai Foto', r.text.includes('view-photo-search') && r.text.includes('Cari pakai Foto'));
    r = await admin.req('/app.js');
    check('app.js memuat logika photo search', r.text.includes('/api/search/photo') && r.text.includes('btn-run-photo-search') && r.text.includes('Tidak ada barang yang mirip'));
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
