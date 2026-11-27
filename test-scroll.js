// Verifikasi infinite scroll (muat saat scroll) — server uji terpisah
// (DB /tmp/scroll-test.db, port 3116). TIDAK menyentuh database utama.
// Jalankan: node test-scroll.js
// Latar: user minta tombol halaman "‹ Sebelumnya | Hal X / Y | Berikutnya ›"
// di Inventaris diganti scroll sampai bawah, dan pola yang sama diterapkan
// ke semua daftar lain yang terpotong. Yang diubah:
// - Inventaris: tombol halaman dihapus -> infinite scroll (50/halaman).
// - Pengambilan terakhir: /api/takes/recent tadinya LIMIT 20 tanpa paginasi
//   -> page/perPage + infinite scroll (20/halaman).
// - Riwayat mode terbaru: /api/history tadinya LIMIT 60 tanpa paginasi
//   -> page/perPage + infinite scroll (60/halaman). Mode harian tetap.
// Bagian 5-6 memakai jsdom untuk simulasi DOM sungguhan. jsdom TIDAK punya
// IntersectionObserver, jadi bagian 5 menguji jalur cadangan (tombol
// "Muat lebih") dan bagian 6 memakai stub IntersectionObserver untuk
// menguji jalur otomatis (pemicu manual = simulasi scroll sampai bawah).
// Pasang sekali: npm install --no-save jsdom (node_modules di-gitignore,
// tidak ikut ter-push). Bila jsdom tidak ada, bagian 5-6 dilewati (SKIP)
// dan bagian lain tetap jalan.
const fs = require('fs');
const { spawn } = require('child_process');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* bagian 5-6 dilewati */ }

const BASE = 'http://localhost:3116';
const DB_PATH = '/tmp/scroll-test.db';
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
    env: Object.assign({}, process.env, { PORT: '3116', DB_PATH }),
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
    check('login zico (admin)', r.status === 200 && r.json.role === 'admin');

    console.log('== 2. API /api/items: 120 barang, halaman 1+2+3 tanpa duplikat ==');
    for (let i = 1; i <= 110; i++) {
      const n = 'SCROLL A' + String(i).padStart(3, '0');
      r = await admin.j('/api/items', { name: n, fd_code: 'FDS' + String(i).padStart(3, '0'), barcode: '', stock: 5, unit: 'PCS', rack: 'RAK 1', shelf: 'A.1', jolly_box: '1', category: 'UMUM' });
      if (r.status !== 200) { check('buat 110 barang stok 5', false, JSON.stringify(r.json).slice(0, 200)); break; }
    }
    for (let i = 1; i <= 10; i++) {
      const n = 'SCROLL B' + String(i).padStart(3, '0');
      r = await admin.j('/api/items', { name: n, fd_code: 'FDSB' + String(i).padStart(2, '0'), barcode: '', stock: 0, unit: 'PCS', rack: 'RAK 1', shelf: 'A.1', jolly_box: '1', category: 'UMUM' });
      if (r.status !== 200) { check('buat 10 barang stok 0', false, JSON.stringify(r.json).slice(0, 200)); break; }
    }
    const ids = (rows) => rows.map((x) => x.id);
    r = await admin.req('/api/items?page=1&perPage=50');
    check('items hal 1: 50 barang, total 120, pages 3', r.json.items.length === 50 && r.json.total === 120 && r.json.pages === 3, JSON.stringify({ n: r.json.items.length, total: r.json.total, pages: r.json.pages }));
    const p1 = ids(r.json.items);
    r = await admin.req('/api/items?page=2&perPage=50');
    check('items hal 2: 50 barang', r.json.items.length === 50);
    const p2 = ids(r.json.items);
    r = await admin.req('/api/items?page=3&perPage=50');
    check('items hal 3: 20 barang (sisa)', r.json.items.length === 20);
    const p3 = ids(r.json.items);
    const allIds = [...p1, ...p2, ...p3];
    check('hal 1+2+3: 120 id unik, tanpa duplikat', new Set(allIds).size === 120, 'unik=' + new Set(allIds).size);
    r = await admin.req('/api/items');
    check('items tanpa param: default perPage 50', r.json.items.length === 50 && r.json.total === 120);
    r = await admin.req('/api/items?search=' + encodeURIComponent('SCROLL A001'));
    check('cari SCROLL A001: 1 hasil dari halaman 1', r.json.items.length === 1 && r.json.total === 1 && r.json.items[0].name === 'SCROLL A001');
    r = await admin.req('/api/items?filter=out&perPage=50');
    check('filter stok habis: 10 barang', r.json.items.length === 10 && r.json.total === 10);
    r = await admin.req('/api/items?filter=low&perPage=50');
    check('filter stok menipis: 110 barang (stok 5)', r.json.items.length === 50 && r.json.total === 110);

    console.log('== 3. API /api/takes/recent + /api/history: 70 pengambilan ==');
    r = await admin.j('/api/items', { name: 'SCROLL BULK', fd_code: 'FDSBULK', barcode: '', stock: 500, unit: 'PCS', rack: 'RAK 1', shelf: 'A.1', jolly_box: '1', category: 'UMUM' });
    const idBulk = r.json.id;
    check('buat SCROLL BULK stok 500', !!idBulk);
    for (let i = 0; i < 70; i++) {
      r = await admin.j('/api/take', { itemId: idBulk, qty: 1, machine: 'BLOWMOULD', takenBy: 'Davin' });
      if (r.status !== 200) { check('70x ambil 1 pcs', false, JSON.stringify(r.json).slice(0, 200)); break; }
    }
    check('70x ambil 1 pcs (stok 500->430)', (await admin.req('/api/items/' + idBulk)).json.item.stock === 430);
    r = await admin.req('/api/takes/recent');
    check('takes/recent tanpa param: 20 pertama (kompatibel lama)', r.json.takes.length === 20 && r.json.total === 70, JSON.stringify({ n: r.json.takes.length, total: r.json.total }));
    const t1 = ids(r.json.takes);
    r = await admin.req('/api/takes/recent?page=2&perPage=20');
    check('takes/recent hal 2: 20 baris', r.json.takes.length === 20);
    const t2 = ids(r.json.takes);
    r = await admin.req('/api/takes/recent?page=4&perPage=20');
    check('takes/recent hal 4: 10 baris (sisa)', r.json.takes.length === 10);
    const t4 = ids(r.json.takes);
    r = await admin.req('/api/takes/recent?page=3&perPage=20');
    const t3 = ids(r.json.takes);
    check('takes/recent hal 1-4: 70 id unik, tanpa duplikat', new Set([...t1, ...t2, ...t3, ...t4]).size === 70);
    // total moves: 110 (stok awal 110 barang stok 5) + 1 (stok awal BULK)
    // + 70 pengambilan = 181 (10 barang stok 0 tidak membuat move)
    r = await admin.req('/api/history');
    check('history tanpa param: 60 pertama, total 181, pages 4', r.json.rows.length === 60 && r.json.total === 181 && r.json.pages === 4, JSON.stringify({ n: r.json.rows.length, total: r.json.total, pages: r.json.pages }));
    const h1 = ids(r.json.rows);
    const today = r.json.rows[0].date;
    r = await admin.req('/api/history?page=2&perPage=60');
    check('history hal 2: 60 baris', r.json.rows.length === 60);
    const h2 = ids(r.json.rows);
    r = await admin.req('/api/history?page=3&perPage=60');
    check('history hal 3: 60 baris', r.json.rows.length === 60);
    const h3 = ids(r.json.rows);
    r = await admin.req('/api/history?page=4&perPage=60');
    check('history hal 4: 1 baris (sisa)', r.json.rows.length === 1);
    const h4 = ids(r.json.rows);
    check('history hal 1-4: 181 id unik, tanpa duplikat', new Set([...h1, ...h2, ...h3, ...h4]).size === 181);
    r = await admin.req('/api/history?date=' + today);
    const bulkDay = r.json.rows.find((x) => x.item_name === 'SCROLL BULK');
    check('history mode harian tetap jalan (mode day, BULK keluar 70, totalKeluar 70)',
      r.json.mode === 'day' && bulkDay && bulkDay.keluar === 70 && r.json.totalKeluar === 70, JSON.stringify(r.json).slice(0, 300));

    console.log('== 4. Cek level kode: shell v14 + sentinel ada, pager hilang ==');
    const serverSrc = fs.readFileSync(__dirname + '/server.js', 'utf8');
    const appSrc = fs.readFileSync(__dirname + '/public/app.js', 'utf8');
    const htmlSrc = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
    const swSrc = fs.readFileSync(__dirname + '/public/sw.js', 'utf8');
    check('sw.js CACHE v16', swSrc.includes('gudang-sparepart-v16'));
    check('index.html: tidak ada lagi inv-prev / inv-next / inv-page-info',
      !htmlSrc.includes('inv-prev') && !htmlSrc.includes('inv-next') && !htmlSrc.includes('inv-page-info'));
    check('index.html: sentinel + status + tombol Muat lebih ada (inv/take/hist)',
      htmlSrc.includes('inv-sentinel') && htmlSrc.includes('take-sentinel') && htmlSrc.includes('hist-sentinel')
      && htmlSrc.includes('inv-status') && htmlSrc.includes('take-status') && htmlSrc.includes('hist-status')
      && htmlSrc.includes('inv-more') && htmlSrc.includes('take-more') && htmlSrc.includes('hist-more'));
    check('index.html: footnote MOI/YOI tetap ada', htmlSrc.includes('MOI = stok / rata-rata pakai per bulan'));
    check('index.html: label "60 terakhir" sudah diganti', !htmlSrc.includes('60 terakhir'));
    check('app.js: factory createInfiniteList + teks akhir daftar ada',
      appSrc.includes('createInfiniteList') && appSrc.includes('Semua barang sudah ditampilkan.'));
    check('app.js: tidak ada lagi referensi invPage', !appSrc.includes('invPage'));
    check('server.js: takes/recent + history pakai LIMIT/OFFSET + total',
      serverSrc.includes("LIMIT ? OFFSET ?") && serverSrc.includes('pages: Math.max(1, Math.ceil(total / perPage))'));

    console.log('== 5. Simulasi DOM (jsdom, tanpa IntersectionObserver): tombol Muat lebih ==');
    if (!JSDOM) {
      console.log('  SKIP  jsdom belum terpasang — jalankan: npm install --no-save jsdom');
    } else {
      const htmlR = await admin.req('/index.html');
      const jsR = await admin.req('/app.js');
      check('index.html terambil untuk jsdom', htmlR.status === 200 && htmlR.text.includes('inv-sentinel'));
      check('app.js terambil untuk jsdom', jsR.status === 200 && jsR.text.includes('createInfiniteList'));
      const nodeFetch = fetch;
      const dom = new JSDOM(htmlR.text, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
      dom.window.scrollTo = () => {};
      dom.window.fetch = (url, opts = {}) => {
        const abs = String(url).startsWith('http') ? String(url) : BASE + url;
        const headers = Object.assign({}, opts.headers || {});
        if (admin.cookie) headers.Cookie = admin.cookie;
        return nodeFetch(abs, Object.assign({}, opts, { headers }));
      };
      dom.window.eval(jsR.text);
      const doc = dom.window.document;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const isHidden = (el) => !el || el.classList.contains('hidden');
      let booted = false;
      for (let i = 0; i < 20 && !booted; i++) {
        await sleep(250);
        booted = !isHidden(doc.querySelector('#app')) && isHidden(doc.querySelector('#view-login'));
      }
      check('boot jsdom: masuk aplikasi sebagai Admin', booted);
      // 5a. Inventaris: halaman 1 = 50 baris, tombol Muat lebih tampil
      doc.querySelector('#topnav button[data-view="inventory"]').click();
      await sleep(800);
      const invRows = () => [...doc.querySelectorAll('#inv-list [data-item]')];
      check('Inventaris hal 1: 50 baris', invRows().length === 50, 'baris=' + invRows().length);
      check('jumlah total tampil: "121 barang"', doc.querySelector('#inv-count').textContent.includes('121'), doc.querySelector('#inv-count').textContent);
      check('tanpa IntersectionObserver: tombol Muat lebih tampil', !isHidden(doc.querySelector('#inv-more')));
      doc.querySelector('#inv-more').click();
      await sleep(800);
      check('klik Muat lebih: 100 baris', invRows().length === 100, 'baris=' + invRows().length);
      doc.querySelector('#inv-more').click();
      await sleep(800);
      check('klik Muat lebih lagi: 121 baris (semua)', invRows().length === 121, 'baris=' + invRows().length);
      check('ujung daftar: "Semua barang sudah ditampilkan."', doc.querySelector('#inv-status').textContent.includes('Semua barang sudah ditampilkan'), doc.querySelector('#inv-status').textContent);
      check('ujung daftar: tombol Muat lebih hilang', isHidden(doc.querySelector('#inv-more')));
      const invIds = invRows().map((b) => b.dataset.item);
      check('121 baris Inventaris: id unik, tanpa duplikat', new Set(invIds).size === 121, 'unik=' + new Set(invIds).size);
      // 5b. Ganti pencarian -> reset ke halaman 1, hanya yang cocok
      const search = doc.querySelector('#inv-search');
      search.value = 'SCROLL A001';
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await sleep(1000);
      check('cari SCROLL A001: reset ke 1 baris yang cocok', invRows().length === 1 && invRows()[0].textContent.includes('SCROLL A001'), 'baris=' + invRows().length);
      check('cari: penanda akhir tampil (hasil < 1 halaman)', doc.querySelector('#inv-status').textContent.includes('Semua barang sudah ditampilkan'));
      search.value = '';
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await sleep(1000);
      check('hapus pencarian: kembali 50 baris halaman 1', invRows().length === 50, 'baris=' + invRows().length);
      // 5c. Ambil: 20 -> 40 -> 60 -> 70 + penanda akhir
      doc.querySelector('#topnav button[data-view="take"]').click();
      await sleep(800);
      const takeRows = () => [...doc.querySelectorAll('#take-recent [data-take]')];
      check('Pengambilan terakhir hal 1: 20 baris', takeRows().length === 20, 'baris=' + takeRows().length);
      doc.querySelector('#take-more').click(); await sleep(800);
      check('Pengambilan terakhir: 40 baris', takeRows().length === 40, 'baris=' + takeRows().length);
      doc.querySelector('#take-more').click(); await sleep(800);
      check('Pengambilan terakhir: 60 baris', takeRows().length === 60, 'baris=' + takeRows().length);
      doc.querySelector('#take-more').click(); await sleep(800);
      check('Pengambilan terakhir: 70 baris (semua)', takeRows().length === 70, 'baris=' + takeRows().length);
      check('Pengambilan terakhir: penanda akhir tampil', doc.querySelector('#take-status').textContent.includes('Semua pengambilan sudah ditampilkan'));
      const takeIds = takeRows().map((b) => b.dataset.take);
      check('70 baris Ambil: id unik, tanpa duplikat', new Set(takeIds).size === 70, 'unik=' + new Set(takeIds).size);
      // 5d. Riwayat mode terbaru: 60 -> 120 -> 180 -> 181 + penanda akhir
      doc.querySelector('#topnav button[data-view="history"]').click();
      await sleep(800);
      const histRows = () => [...doc.querySelectorAll('#hist-list [data-item]')];
      check('Riwayat terbaru hal 1: 60 baris', histRows().length === 60, 'baris=' + histRows().length);
      doc.querySelector('#hist-more').click(); await sleep(800);
      check('Riwayat terbaru: 120 baris', histRows().length === 120, 'baris=' + histRows().length);
      doc.querySelector('#hist-more').click(); await sleep(800);
      check('Riwayat terbaru: 180 baris', histRows().length === 180, 'baris=' + histRows().length);
      doc.querySelector('#hist-more').click(); await sleep(800);
      check('Riwayat terbaru: 181 baris (semua)', histRows().length === 181, 'baris=' + histRows().length);
      check('Riwayat terbaru: penanda akhir tampil', doc.querySelector('#hist-status').textContent.includes('Semua riwayat sudah ditampilkan'));
      doc.querySelector('#hist-date').value = today;
      doc.querySelector('#hist-date').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await sleep(800);
      check('Riwayat mode harian: ringkasan per barang (SCROLL BULK, keluar 70)',
        doc.querySelector('#hist-content').textContent.includes('SCROLL BULK') && doc.querySelector('#hist-content').textContent.includes('70'),
        doc.querySelector('#hist-content').textContent.slice(0, 200));
      check('Riwayat mode harian: sentinel/status disembunyikan',
        isHidden(doc.querySelector('#hist-sentinel')) && isHidden(doc.querySelector('#hist-status')));
    }

    console.log('== 6. Simulasi DOM (jsdom + stub IntersectionObserver): muat otomatis saat scroll ==');
    if (!JSDOM) {
      console.log('  SKIP  jsdom belum terpasang — jalankan: npm install --no-save jsdom');
    } else {
      const htmlR = await admin.req('/index.html');
      const jsR = await admin.req('/app.js');
      const nodeFetch = fetch;
      const dom = new JSDOM(htmlR.text, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
      dom.window.scrollTo = () => {};
      // stub IntersectionObserver: catat semua instance; pemicu manual
      // cb([{isIntersecting:true}]) = simulasi "scroll sudah sampai bawah"
      const observers = [];
      dom.window.IntersectionObserver = class {
        constructor(cb) { this.cb = cb; observers.push(this); }
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      dom.window.fetch = (url, opts = {}) => {
        const abs = String(url).startsWith('http') ? String(url) : BASE + url;
        const headers = Object.assign({}, opts.headers || {});
        if (admin.cookie) headers.Cookie = admin.cookie;
        return nodeFetch(abs, Object.assign({}, opts, { headers }));
      };
      dom.window.eval(jsR.text);
      const doc = dom.window.document;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const isHidden = (el) => !el || el.classList.contains('hidden');
      const fireLastObserver = () => {
        const o = observers[observers.length - 1];
        if (o) o.cb([{ isIntersecting: true }]);
      };
      let booted = false;
      for (let i = 0; i < 20 && !booted; i++) {
        await sleep(250);
        booted = !isHidden(doc.querySelector('#app')) && isHidden(doc.querySelector('#view-login'));
      }
      check('boot jsdom (stub IO): masuk aplikasi sebagai Admin', booted);
      doc.querySelector('#topnav button[data-view="inventory"]').click();
      await sleep(800);
      const invRows = () => [...doc.querySelectorAll('#inv-list [data-item]')];
      check('Inventaris hal 1: 50 baris', invRows().length === 50, 'baris=' + invRows().length);
      check('dengan IntersectionObserver: tombol Muat lebih tetap tersembunyi', isHidden(doc.querySelector('#inv-more')));
      fireLastObserver(); await sleep(800);
      check('scroll ke bawah (pemicu observer): 100 baris', invRows().length === 100, 'baris=' + invRows().length);
      fireLastObserver(); await sleep(800);
      check('scroll ke bawah lagi: 121 baris (semua)', invRows().length === 121, 'baris=' + invRows().length);
      check('ujung daftar: penanda akhir tampil', doc.querySelector('#inv-status').textContent.includes('Semua barang sudah ditampilkan'));
      const invIds = invRows().map((b) => b.dataset.item);
      check('121 baris: id unik, tanpa duplikat', new Set(invIds).size === 121, 'unik=' + new Set(invIds).size);
      // pencarian reset di jalur observer
      const search = doc.querySelector('#inv-search');
      search.value = 'SCROLL B005';
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await sleep(1000);
      check('cari SCROLL B005 (jalur observer): reset ke 1 baris', invRows().length === 1 && invRows()[0].textContent.includes('SCROLL B005'), 'baris=' + invRows().length);
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
