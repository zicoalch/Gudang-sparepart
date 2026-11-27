// Verifikasi perbaikan scanner barcode/QR + thumbnail daftar — server uji terpisah (DB /tmp/scan-test.db, port 3108).
// TIDAK menyentuh database utama. Jalankan: node test-scan.js
const fs = require('fs');
const { spawn } = require('child_process');
const Jimp = require('jimp');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const { MultiFormatReader, DecodeHintType, RGBLuminanceSource, BinaryBitmap, HybridBinarizer } = require('@zxing/library');

const BASE = 'http://localhost:3108';
const DB_PATH = '/tmp/scan-test.db';
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

// Decode gambar barcode/QR lewat mesin ZXing (sama seperti fallback browser)
async function decodeImage(buf) {
  const img = await Jimp.read(buf);
  const { data, width, height } = img.bitmap;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = (data[i * 4] * 306 + data[i * 4 + 1] * 601 + data[i * 4 + 2] * 117) >> 10;
  }
  const source = new RGBLuminanceSource(gray, width, height);
  const bitmap = new BinaryBitmap(new HybridBinarizer(source));
  const reader = new MultiFormatReader();
  reader.setHints(new Map([[DecodeHintType.TRY_HARDER, true]]));
  return reader.decode(bitmap).getText();
}

(async () => {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: '3108', DB_PATH }),
    stdio: 'ignore',
  });
  try {
    if (!(await waitUp())) { console.log('FAIL server uji tidak jalan'); process.exit(1); }

    console.log('== 1. Setup & login Admin ==');
    const anon = new Jar();
    let r = await anon.j('/api/setup', { password: 'admin123', confirm: 'admin123' });
    check('setup admin zico', r.status === 200 && r.json.ok, JSON.stringify(r.json));
    const admin = new Jar();
    r = await admin.j('/api/login', { username: 'zico', password: 'admin123' });
    check('login zico', r.status === 200 && r.json.role === 'admin');

    console.log('== 2. Barang uji (A tanpa foto, B dengan foto) ==');
    r = await admin.j('/api/items', { name: 'SHAFT UJI', fd_code: 'FD013610', barcode: '', stock: 5, unit: 'PCS', rack: 'RAK 2', shelf: 'F.1', jolly_box: '18', category: 'BLOWMOULD' });
    check('buat barang A FD013610', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 150));
    const idA = r.json.id;
    const red = await new Jimp(64, 64, 0xdd2222ff).getBase64Async(Jimp.MIME_JPEG);
    r = await admin.j('/api/items', { name: 'BAUT UJI', fd_code: 'FD013611', barcode: '', stock: 2, unit: 'PCS', rack: 'RAK 3', shelf: 'G.1', jolly_box: '7', category: 'BAUT', photo: red });
    check('buat barang B dengan foto', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 150));
    const idB = r.json.id;

    console.log('== 3. Daftar + endpoint foto (untuk thumbnail) ==');
    r = await admin.req('/api/items?search=&filter=all&page=1&perPage=50');
    const items = r.json.items || [];
    const a = items.find((x) => x.id === idA), b = items.find((x) => x.id === idB);
    check('daftar memuat hasPhoto barang B', !!b && b.hasPhoto === true, 'hasPhoto=' + (b && b.hasPhoto));
    check('daftar barang A tanpa foto', !!a && a.hasPhoto === false);
    r = await admin.req('/api/items/' + idB + '/photo');
    check('endpoint foto B -> 200 image', r.status === 200 && (r.headers.get('content-type') || '').includes('image'), 'status=' + r.status);
    r = await admin.req('/api/items/' + idA + '/photo');
    check('endpoint foto A tanpa foto -> 404', r.status === 404, 'status=' + r.status);

    console.log('== 4. Decode QR + Code128 lewat mesin ZXing (fallback) ==');
    const qrBuf = await QRCode.toBuffer('FD013610', { width: 300, margin: 2 });
    let decoded = '';
    try { decoded = await decodeImage(qrBuf); } catch (e) { decoded = 'ERROR: ' + e.message; }
    check('QR FD013610 ter-decode ZXing', decoded === 'FD013610', 'hasil=' + decoded);
    const bcBuf = await bwipjs.toBuffer({ bcid: 'code128', text: 'FD013610', scale: 3, height: 12, includetext: false });
    // Barcode sintetis tanpa quiet zone gagal di-decode ZXing 1D (dunia nyata selalu
    // punya ruang kosong di sekitar barcode) — beri border putih dulu seperti frame kamera.
    const bcImg = await Jimp.read(bcBuf);
    const bcBordered = new Jimp(bcImg.bitmap.width + 60, bcImg.bitmap.height + 40, 0xffffffff);
    bcBordered.composite(bcImg, 30, 20);
    const bcBorderedBuf = await bcBordered.getBufferAsync(Jimp.MIME_PNG);
    try { decoded = await decodeImage(bcBorderedBuf); } catch (e) { decoded = 'ERROR: ' + e.message; }
    check('Code128 FD013610 ter-decode ZXing', decoded === 'FD013610', 'hasil=' + decoded);

    console.log('== 5. Lookup kode hasil scan ==');
    r = await admin.req('/api/items/lookup?code=FD013610');
    check('lookup FD013610 menemukan barang A', r.status === 200 && r.json.item && r.json.item.id === idA, 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=TIDAKADA');
    check('lookup kode tidak dikenal -> 404', r.status === 404, 'status=' + r.status);

    console.log('== 6. Frontend ter-serve ==');
    r = await admin.req('/index.html');
    check('index.html: tombol scan Inventaris', r.text.includes('btn-scan-inv'));
    check('index.html: bundle ZXing dimuat', r.text.includes('vendor/zxing-browser.min.js'));
    check('index.html: panel error scanner', r.text.includes('scanner-error') && r.text.includes('btn-scan-manual'));
    check('index.html: frame pemindai', r.text.includes('scan-frame'));
    r = await admin.req('/vendor/zxing-browser.min.js');
    check('bundle ZXing ter-serve (200)', r.status === 200 && r.text.includes('BrowserMultiFormatReader'), 'status=' + r.status);
    check('bundle ZXing mengekspos global + API decode', r.text.includes('ZXingBrowser') && r.text.includes('decodeFromStream') && r.text.includes('BrowserMultiFormatReader'));
    // Catatan: require() bundle UMD di Node gagal ("window is not defined") karena
    // bundle memang dibuat untuk browser; pemuatan di browser diverifikasi lewat
    // tag <script> di index.html + isi bundle di atas. Kamera sungguhan tidak bisa
    // dites headless — lihat laporan.
    r = await admin.req('/app.js');
    check('app.js: memakai ZXing fallback', r.text.includes('ZXingBrowser') && r.text.includes('decodeFromStream'));
    check('app.js: pesan error kamera jelas', r.text.includes('Izin kamera ditolak') && r.text.includes('Tidak ada kamera yang ditemukan'));
    check('app.js: thumbnail + placeholder di daftar', r.text.includes('thumb-empty') && r.text.includes('Belum ada foto'));
    check('app.js: MOI/YOI tidak lagi di daftar', !r.text.includes('usageLine('));
    check('app.js: scan Inventaris membuka detail', r.text.includes("openScanner('inv')") && r.text.includes('Barang dengan kode'));
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
