// Verifikasi pencarian nama di form Ambil — server uji terpisah (DB /tmp/take-search-test.db, port 3114).
// TIDAK menyentuh database utama. Jalankan: node test-take-search.js
// Latar: user mengetik "Masker kain" (nama barang) di kolom Ambil dan mendapat
// "Barang dengan kode ... tidak ditemukan" karena lookup hanya cocok Kode FD/barcode persis.
// Bagian 8 memakai jsdom untuk simulasi DOM sungguhan (event input, mousedown,
// Enter, klik Simpan). Pasang sekali: npm install --no-save jsdom
// (node_modules di-gitignore, tidak ikut ter-push). Bila jsdom tidak ada,
// bagian 8 dilewati (SKIP) dan bagian lain tetap jalan.
const fs = require('fs');
const { spawn } = require('child_process');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* bagian 8 dilewati */ }

const BASE = 'http://localhost:3114';
const DB_PATH = '/tmp/take-search-test.db';
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

(async () => {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: '3114', DB_PATH }),
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

    console.log('== 2. Barang uji (dua nama sama persis) ==');
    r = await admin.j('/api/items', { name: 'MASKER KAIN', fd_code: 'FD100001', barcode: '', stock: 10, unit: 'PCS', rack: 'RAK 1', shelf: 'A.1', jolly_box: '3', category: 'UMUM' });
    check('buat MASKER KAIN FD100001 stok 10', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 150));
    const idMasker1 = r.json.id;
    r = await admin.j('/api/items', { name: 'MASKER KAIN', fd_code: 'FD100002', barcode: '', stock: 3, unit: 'PCS', rack: 'RAK 2', shelf: 'B.2', jolly_box: '5', category: 'UMUM' });
    check('buat MASKER KAIN kedua FD100002 stok 3', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 150));
    const idMasker2 = r.json.id;
    r = await admin.j('/api/items', { name: 'SARUNG TANGAN KARET', fd_code: 'FD100003', barcode: '', stock: 7, unit: 'PCS', rack: 'RAK 1', shelf: 'A.2', jolly_box: '3', category: 'UMUM' });
    check('buat SARUNG TANGAN KARET FD100003', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 150));
    const idSarung = r.json.id;
    r = await admin.j('/api/items', { name: 'BAUT HEX M6', fd_code: 'FD100004', barcode: '', stock: 20, unit: 'PCS', rack: 'RAK 3', shelf: 'C.1', jolly_box: '9', category: 'BAUT' });
    check('buat BAUT HEX M6 FD100004', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 150));

    console.log('== 3. Pencarian nama (mekanisme saran Ambil) ==');
    r = await admin.req('/api/items?search=masker&filter=all&page=1&perPage=8');
    check('cari "masker" (huruf kecil) menemukan 2 barang', r.status === 200 && r.json.items.length === 2, 'dapat=' + (r.json.items || []).length);
    check('hasil "masker" keduanya bernama MASKER KAIN', (r.json.items || []).every((x) => x.name === 'MASKER KAIN'));
    r = await admin.req('/api/items?search=MASKER%20KAIN&filter=all&page=1&perPage=8');
    check('cari "MASKER KAIN" lengkap menemukan 2 barang', r.status === 200 && r.json.items.length === 2, 'dapat=' + (r.json.items || []).length);
    r = await admin.req('/api/items?search=sarung&filter=all&page=1&perPage=8');
    check('cari "sarung" menemukan SARUNG TANGAN KARET', r.status === 200 && r.json.items.length === 1 && r.json.items[0].id === idSarung, 'dapat=' + (r.json.items || []).length);
    r = await admin.req('/api/items?search=FD100001&filter=all&page=1&perPage=8');
    check('cari "FD100001" (kode sebagian) menemukan 1 barang', r.status === 200 && r.json.items.length === 1 && r.json.items[0].id === idMasker1, 'dapat=' + (r.json.items || []).length);
    r = await admin.req('/api/items?search=tidakada&filter=all&page=1&perPage=8');
    check('cari nama yang tidak ada -> 0 hasil', r.status === 200 && r.json.items.length === 0, 'dapat=' + (r.json.items || []).length);
    r = await admin.req('/api/items?search=masker&filter=all&page=1&perPage=1');
    check('perPage di-clamp server min 10 (perPage=1 tetap kembalikan semua yang cocok)', r.status === 200 && r.json.items.length === 2, 'dapat=' + (r.json.items || []).length);

    console.log('== 4. Dua barang nama sama bisa dibedakan lewat saran ==');
    r = await admin.req('/api/items?search=masker&filter=all&page=1&perPage=8');
    const m1 = (r.json.items || []).find((x) => x.id === idMasker1);
    const m2 = (r.json.items || []).find((x) => x.id === idMasker2);
    check('saran memuat Kode FD berbeda untuk nama sama', !!m1 && !!m2 && m1.fd_code === 'FD100001' && m2.fd_code === 'FD100002');
    check('saran memuat rak/shaf/box berbeda untuk nama sama',
      !!m1 && !!m2 && m1.rack === 'RAK 1' && m1.shelf === 'A.1' && m2.rack === 'RAK 2' && m2.shelf === 'B.2',
      JSON.stringify({ m1, m2 }).slice(0, 300));
    check('saran memuat stok tiap barang', !!m1 && !!m2 && m1.stock === 10 && m2.stock === 3);

    console.log('== 5. Jalur cepat Kode FD persis tetap jalan ==');
    r = await admin.req('/api/items/lookup?code=FD100001');
    check('lookup FD100001 -> 200 barang benar', r.status === 200 && r.json.item && r.json.item.id === idMasker1, 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=fd100002');
    check('lookup fd100002 huruf kecil -> 200 (case-insensitive)', r.status === 200 && r.json.item && r.json.item.id === idMasker2, 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=masker');
    check('lookup "masker" (nama saja) -> 404, pemicu jalur saran', r.status === 404, 'status=' + r.status);
    r = await admin.req('/api/items/lookup?code=Masker%20kain');
    check('lookup "Masker kain" persis kasus user -> 404', r.status === 404, 'status=' + r.status);

    console.log('== 6. Pengambilan lewat barang hasil pencarian nama ==');
    r = await admin.j('/api/take', { itemId: idMasker1, qty: 2, machine: 'BLOWMOULD', takenBy: 'Davin' });
    check('ambil 2 dari MASKER KAIN FD100001 (stok 10->8)', r.status === 200 && r.json.balance === 8, JSON.stringify(r.json));
    r = await admin.req('/api/items/' + idMasker1);
    check('kartu stok mencatat pengambilan + mesin + pengambil',
      r.json.card.length > 0 && JSON.stringify(r.json.card).includes('Davin') && JSON.stringify(r.json.card).includes('BLOWMOULD'));
    r = await admin.j('/api/take', { itemId: idMasker2, qty: 99, machine: 'X', takenBy: 'Davin' });
    check('ambil melebihi stok (FD100002 sisa 3) tetap ditolak', r.status === 400 && /Stok tidak cukup/.test(r.json.error || ''), JSON.stringify(r.json));

    console.log('== 7. Frontend ter-serve (kode saran Ambil) ==');
    r = await admin.req('/index.html');
    check('index.html: wadah saran Ambil', r.text.includes('take-suggestions'));
    check('index.html: label menyebut Nama', r.text.includes('Kode FD / Barcode / Nama'));
    check('index.html: placeholder menyebut nama barang', r.text.includes('atau nama barang'));
    r = await admin.req('/app.js');
    check('app.js: fungsi saran Ambil', r.text.includes('renderTakeSuggestions') && r.text.includes('take-suggestions'));
    check('app.js: pilih saran -> selectTakeItem', r.text.includes('selectTakeItem') && r.text.includes('data-take-suggest'));
    check('app.js: saran memakai pencarian nama yang sama dengan Inventaris', r.text.includes("/api/items?search=") && r.text.includes('perPage=8'));
    check('app.js: saran dibatasi maks 8 hasil (slice)', r.text.includes('slice(0, 8)'));
    check('app.js: saran dipilih lewat mousedown (anti hilang saat blur)', r.text.includes('mousedown') && r.text.includes('data-take-suggest'));
    check('app.js: pesan tidak ditemukan menyebut kode dan nama', r.text.includes('kode atau nama'));
    check('app.js: jalur cepat lookup kode persis tetap ada', r.text.includes("/api/items/lookup?code="));
    check('app.js: saran tampilkan Kode FD + stok + rak/shaf/box', r.text.includes('fd_code') && r.text.includes('Rak ') && r.text.includes('Shaf '));
    check('app.js: pencarian live saat mengetik (debounce 250 ms)', r.text.includes('liveTakeSearch') && r.text.includes('setTimeout(liveTakeSearch, 250)'));
    check('app.js: tidak ada lagi handler yang menyembunyikan saran saat mengetik', !r.text.includes("addEventListener('input', () => { $('#take-suggestions').classList.add('hidden'); })"));
    check('app.js: respons pencarian kedaluwarsa diabaikan (seq)', r.text.includes('takeLiveSeq'));
    check('app.js: barang terpilih dicatat (lastTakeQuery) supaya blur tidak me-render ulang', r.text.includes("lastTakeQuery = $('#take-code').value.trim()"));
    r = await admin.req('/sw.js');
    check('sw.js: CACHE v10', r.text.includes('gudang-sparepart-v10'));

    console.log('== 8. Simulasi DOM: pencarian LIVE saat mengetik (jsdom) ==');
    if (!JSDOM) {
      console.log('  SKIP  jsdom belum terpasang — jalankan: npm install --no-save jsdom');
    } else {
      const htmlR = await admin.req('/index.html');
      const jsR = await admin.req('/app.js');
      check('index.html terambil untuk jsdom', htmlR.status === 200 && htmlR.text.includes('take-code'));
      check('app.js terambil untuk jsdom', jsR.status === 200 && jsR.text.includes('liveTakeSearch'));
      let searchReqs = 0;
      const nodeFetch = fetch;
      const dom = new JSDOM(htmlR.text, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
      dom.window.scrollTo = () => {};
      dom.window.fetch = (url, opts = {}) => {
        const abs = String(url).startsWith('http') ? String(url) : BASE + url;
        if (abs.includes('/api/items?search=')) searchReqs++;
        const headers = Object.assign({}, opts.headers || {});
        if (admin.cookie) headers.Cookie = admin.cookie;
        return nodeFetch(abs, Object.assign({}, opts, { headers }));
      };
      dom.window.eval(jsR.text);
      const doc = dom.window.document;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const sugBox = () => doc.querySelector('#take-suggestions');
      const sugCount = () => sugBox().querySelectorAll('[data-take-suggest]').length;
      const isHidden = (el) => el.classList.contains('hidden');
      const type = async (text) => {
        const inp = doc.querySelector('#take-code');
        inp.value = text;
        inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      };
      // tunggu boot(): status -> me -> enterApp -> dashboard
      let booted = false;
      for (let i = 0; i < 20 && !booted; i++) {
        await sleep(250);
        booted = !isHidden(doc.querySelector('#app')) && isHidden(doc.querySelector('#view-login'));
      }
      check('boot jsdom: masuk aplikasi sebagai Admin', booted);
      // buka tab Ambil
      doc.querySelector('#topnav button[data-view="take"]').click();
      await sleep(300);
      check('tab Ambil terbuka', !isHidden(doc.querySelector('#view-take')));
      const input = doc.querySelector('#take-code');

      // 8a. Debounce: ketik cepat 6 huruf -> hanya 1 request pencarian
      searchReqs = 0;
      for (const t of ['m', 'ma', 'mas', 'mask', 'maske', 'masker']) { await type(t); await sleep(30); }
      await sleep(600);
      check('debounce: ketik cepat 6 huruf -> hanya 1 request pencarian', searchReqs === 1, 'requests=' + searchReqs);
      check('ketik "masker" TANPA Enter -> saran live muncul (2)', sugCount() === 2 && !isHidden(sugBox()), 'saran=' + sugCount());

      // 8b. Menyempit saat mengetik lebih panjang
      await type('m'); await sleep(500);
      check('ketik "m" -> 3 saran', sugCount() === 3, 'saran=' + sugCount());
      await type('ma'); await sleep(500);
      check('ketik "ma" -> saran menyempit jadi 2', sugCount() === 2, 'saran=' + sugCount());

      // 8c. Hapus isi -> saran hilang
      await type(''); await sleep(500);
      check('hapus isi input -> saran hilang', isHidden(sugBox()), 'saran=' + sugCount());

      // 8d. Pilih saran (mousedown) -> preview + field Jumlah/Mesin/Nama pemakai tampil
      await type('masker'); await sleep(500);
      check('ketik "masker" lagi -> 2 saran', sugCount() === 2, 'saran=' + sugCount());
      const btn2 = [...sugBox().querySelectorAll('[data-take-suggest]')].find((b) => b.textContent.includes('FD100002'));
      check('saran FD100002 ditemukan', !!btn2);
      btn2.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await sleep(200);
      check('pilih saran -> #take-item tampil berisi MASKER KAIN FD100002',
        !isHidden(doc.querySelector('#take-item')) && doc.querySelector('#take-item').textContent.includes('MASKER KAIN') && doc.querySelector('#take-item').textContent.includes('FD100002'));
      check('pilih saran -> #take-fields tampil (Jumlah, Mesin, Nama pemakai, Simpan)',
        !isHidden(doc.querySelector('#take-fields')) && !!doc.querySelector('#take-qty') && !!doc.querySelector('#take-by') && !!doc.querySelector('#btn-save-take'));
      // 8e. Simpan dengan Jumlah + Nama pemakai terisi -> stok berkurang
      const stockBefore = (await admin.req('/api/items/' + idMasker2)).json.item.stock;
      doc.querySelector('#take-qty').value = '1';
      doc.querySelector('#take-machine').value = 'BLOWMOULD';
      doc.querySelector('#take-by').value = 'Davin';
      doc.querySelector('#btn-save-take').click();
      await sleep(600);
      const stockAfter = (await admin.req('/api/items/' + idMasker2)).json.item.stock;
      check('simpan pengambilan via form (qty 1, Davin) -> stok berkurang', stockAfter === stockBefore - 1, 'sebelum=' + stockBefore + ' sesudah=' + stockAfter);

      // 8f. Query berubah setelah terpilih -> field hilang, pilih saran baru -> field tampil lagi
      await type('masker'); await sleep(500);
      const btnA = [...sugBox().querySelectorAll('[data-take-suggest]')].find((b) => b.textContent.includes('FD100002'));
      btnA.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await sleep(200);
      check('pilih saran lagi -> #take-fields tampil', !isHidden(doc.querySelector('#take-fields')));
      await type('sarung'); await sleep(500);
      check('ganti query ke "sarung" -> pilihan lama dibersihkan, #take-fields hilang', isHidden(doc.querySelector('#take-fields')) && isHidden(doc.querySelector('#take-item')));
      check('ganti query ke "sarung" -> saran baru muncul (1)', sugCount() === 1 && sugBox().textContent.includes('SARUNG TANGAN KARET'), 'saran=' + sugCount());
      const btnS = sugBox().querySelector('[data-take-suggest]');
      btnS.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await sleep(200);
      check('pilih saran baru -> #take-fields tampil lagi + preview SARUNG',
        !isHidden(doc.querySelector('#take-fields')) && doc.querySelector('#take-item').textContent.includes('SARUNG TANGAN KARET'));

      // 8g. Enter dengan Kode FD persis -> tetap langsung terpilih
      input.value = 'FD100001';
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(500);
      check('Enter "FD100001" -> langsung terpilih (preview tampil)',
        !isHidden(doc.querySelector('#take-item')) && doc.querySelector('#take-item').textContent.includes('FD100001'));

      // 8h. Nama tidak ada -> pesan tidak ditemukan
      await type('tidakada'); await sleep(500);
      check('ketik nama tidak ada -> saran tetap tersembunyi', isHidden(sugBox()));
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(500);
      check('Enter nama tidak ada -> pesan tidak ditemukan tampil',
        !isHidden(doc.querySelector('#take-error')) && doc.querySelector('#take-error').textContent.includes('tidak ditemukan'));
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
