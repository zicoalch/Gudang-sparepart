// Verifikasi hapus + edit per catatan pengambilan (menu Ambil) — server uji terpisah
// (DB /tmp/takes-test.db, port 3115). TIDAK menyentuh database utama.
// Jalankan: node test-takes.js
// Latar: user menghapus 1 dari 2 catatan pengambilan barang yang sama, KEDUANYA
// hilang — karena satu-satunya "Hapus" yang bisa dicapai dari baris pengambilan
// adalah hapus barang (DELETE /api/items/:id) yang menghapus barang beserta
// SEMUA riwayatnya. Perbaikan: DELETE/PUT /api/takes/:id bekerja per id moves
// (bukan per barang) + stok dikembalikan/disesuaikan.
// Bagian 9 memakai jsdom untuk simulasi DOM sungguhan (klik baris -> detail,
// Ubah -> form edit, Hapus -> confirm). Pasang sekali: npm install --no-save jsdom
// (node_modules di-gitignore, tidak ikut ter-push). Bila jsdom tidak ada,
// bagian 9 dilewati (SKIP) dan bagian lain tetap jalan.
const fs = require('fs');
const { spawn } = require('child_process');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* bagian 9 dilewati */ }

const BASE = 'http://localhost:3115';
const DB_PATH = '/tmp/takes-test.db';
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

async function stockOf(admin, id) {
  const r = await admin.req('/api/items/' + id);
  return r.json.item ? r.json.item.stock : null;
}

(async () => {
  for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  const server = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { PORT: '3115', DB_PATH }),
    stdio: 'ignore',
  });
  try {
    if (!(await waitUp())) { console.log('FAIL server uji tidak jalan'); process.exit(1); }

    console.log('== 1. Setup & login Admin + User ==');
    const anon = new Jar();
    let r = await anon.j('/api/setup', { password: 'admin123', confirm: 'admin123' });
    check('setup admin zico', r.status === 200 && r.json.ok, JSON.stringify(r.json));
    const admin = new Jar();
    r = await admin.j('/api/login', { username: 'zico', password: 'admin123' });
    check('login zico (admin)', r.status === 200 && r.json.role === 'admin');
    r = await admin.j('/api/accounts', { username: 'budi', password: 'user1234', role: 'user' });
    check('buat akun User budi', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 150));
    const user = new Jar();
    r = await user.j('/api/login', { username: 'budi', password: 'user1234' });
    check('login budi (user)', r.status === 200 && r.json.role === 'user');

    console.log('== 2. Skenario persis laporan user: 1 barang, 2 catatan identik ==');
    r = await admin.j('/api/items', { name: 'MASKER KAIN', fd_code: 'FD200001', barcode: '', stock: 20, unit: 'PCS', rack: 'RAK 1', shelf: 'A.1', jolly_box: '3', category: 'UMUM' });
    check('buat MASKER KAIN stok 20', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 150));
    const idMasker = r.json.id;
    r = await admin.j('/api/take', { itemId: idMasker, qty: 5, machine: 'BLOWMOULD', takenBy: 'Davin' });
    check('ambil #1: 5 pcs (stok 20->15)', r.status === 200 && r.json.balance === 15, JSON.stringify(r.json));
    r = await admin.j('/api/take', { itemId: idMasker, qty: 5, machine: 'BLOWMOULD', takenBy: 'Davin' });
    check('ambil #2: 5 pcs identik (stok 15->10)', r.status === 200 && r.json.balance === 10, JSON.stringify(r.json));
    r = await admin.req('/api/takes/recent');
    check('Pengambilan terakhir berisi 2 catatan', r.status === 200 && (r.json.takes || []).length === 2, 'dapat=' + (r.json.takes || []).length);
    const takeA = (r.json.takes || [])[1]; // yang lebih dulu (id lebih kecil)
    const takeB = (r.json.takes || [])[0]; // yang terbaru
    check('2 catatan punya id moves berbeda', !!takeA && !!takeB && takeA.id !== takeB.id, JSON.stringify({ a: takeA && takeA.id, b: takeB && takeB.id }));
    check('kedua catatan qty 5, barang sama', takeA.qty === 5 && takeB.qty === 5 && takeA.item_id === idMasker && takeB.item_id === idMasker);

    console.log('== 3. Hapus SATU catatan: yang lain tetap, barang tetap, stok kembali tepat ==');
    r = await admin.req('/api/takes/' + takeA.id);
    check('detail catatan #1 bisa dibuka (GET)', r.status === 200 && r.json.take && r.json.take.id === takeA.id && r.json.take.editable === true, 'status=' + r.status);
    check('detail memuat nama + Kode FD + mesin + pemakai + pencatat',
      r.json.take.item_name === 'MASKER KAIN' && r.json.take.fd_code === 'FD200001' && r.json.take.machine === 'BLOWMOULD' && r.json.take.taken_by === 'Davin' && r.json.take.created_by === 'zico',
      JSON.stringify(r.json.take));
    r = await admin.req('/api/takes/' + takeA.id, { method: 'DELETE' });
    check('hapus catatan #1 -> 200 + stok baru 15', r.status === 200 && r.json.balance === 15, JSON.stringify(r.json));
    check('stok barang kembali 15 setelah hapus #1', (await stockOf(admin, idMasker)) === 15);
    r = await admin.req('/api/takes/recent');
    check('Pengambilan terakhir tinggal 1 catatan (yang #2)', (r.json.takes || []).length === 1 && r.json.takes[0].id === takeB.id, 'dapat=' + (r.json.takes || []).length);
    r = await admin.req('/api/takes/' + takeA.id);
    check('catatan #1 yang dihapus tidak bisa dibuka lagi (404)', r.status === 404, 'status=' + r.status);
    r = await admin.req('/api/items/' + idMasker);
    check('barang TETAP ADA setelah hapus catatan (bukan hapus barang)',
      r.status === 200 && r.json.item && r.json.item.stock === 15, 'status=' + r.status);
    check('kartu stok: sisa catatan #2 saldonya bergeser 10->15 (konsisten)',
      r.json.card.length > 0 && JSON.stringify(r.json.card).includes('"balance":15'), JSON.stringify(r.json.card).slice(0, 400));
    r = await admin.req('/api/takes/' + takeB.id, { method: 'DELETE' });
    check('hapus catatan #2 -> 200 + stok kembali penuh 20', r.status === 200 && r.json.balance === 20, JSON.stringify(r.json));
    check('stok kembali 20 setelah kedua catatan dihapus', (await stockOf(admin, idMasker)) === 20);
    r = await admin.req('/api/takes/recent');
    check('Pengambilan terakhir kosong setelah keduanya dihapus', (r.json.takes || []).length === 0);

    console.log('== 4. Edit catatan: qty, nama, mesin + aturan stok ==');
    r = await admin.j('/api/items', { name: 'BAUT HEX M6', fd_code: 'FD200002', barcode: '', stock: 20, unit: 'PCS', rack: 'RAK 3', shelf: 'C.1', jolly_box: '9', category: 'BAUT' });
    check('buat BAUT HEX M6 stok 20', r.status === 200 && r.json.id);
    const idBaut = r.json.id;
    r = await admin.j('/api/take', { itemId: idBaut, qty: 5, machine: 'BLOWMOULD', takenBy: 'Davin' });
    check('ambil BAUT 5 pcs (stok 20->15)', r.status === 200 && r.json.balance === 15);
    r = await admin.req('/api/takes/recent');
    const takeBaut = (r.json.takes || [])[0];
    check('catatan BAUT ditemukan di recent', !!takeBaut && takeBaut.item_id === idBaut, JSON.stringify(takeBaut));
    r = await admin.j('/api/takes/' + takeBaut.id, { qty: 3, taken_by: 'Davin', machine: 'BLOWMOULD' }, 'PUT');
    check('edit qty 5->3 -> stok bertambah 2 (15->17)', r.status === 200 && r.json.balance === 17, JSON.stringify(r.json));
    r = await admin.req('/api/takes/' + takeBaut.id);
    check('detail setelah edit qty 3', r.json.take.qty === 3, JSON.stringify(r.json.take));
    r = await admin.j('/api/takes/' + takeBaut.id, { qty: 6, taken_by: 'Davin', machine: 'CONVEYOR' }, 'PUT');
    check('edit qty 3->6 -> stok berkurang 3 (17->14)', r.status === 200 && r.json.balance === 14, JSON.stringify(r.json));
    r = await admin.req('/api/takes/' + takeBaut.id);
    check('detail setelah edit qty 6 + mesin CONVEYOR', r.json.take.qty === 6 && r.json.take.machine === 'CONVEYOR', JSON.stringify(r.json.take));
    r = await admin.j('/api/takes/' + takeBaut.id, { qty: 6, taken_by: 'Eko', machine: 'LABEL' }, 'PUT');
    check('edit hanya nama+mesin -> stok tetap 14', r.status === 200 && r.json.balance === 14, JSON.stringify(r.json));
    r = await admin.req('/api/takes/' + takeBaut.id);
    check('detail setelah edit nama Eko + mesin LABEL', r.json.take.taken_by === 'Eko' && r.json.take.machine === 'LABEL' && r.json.take.qty === 6);
    check('stok tetap 14 setelah edit nama/mesin', (await stockOf(admin, idBaut)) === 14);
    r = await admin.j('/api/takes/' + takeBaut.id, { qty: 99, taken_by: 'Eko', machine: 'LABEL' }, 'PUT');
    check('edit qty 6->99 (tambahan 93 > stok 14) -> DITOLAK 400', r.status === 400, 'status=' + r.status + ' ' + JSON.stringify(r.json).slice(0, 150));
    check('stok tetap 14 setelah edit ditolak', (await stockOf(admin, idBaut)) === 14);
    r = await admin.req('/api/takes/' + takeBaut.id);
    check('catatan tetap qty 6 setelah edit ditolak', r.json.take.qty === 6);
    r = await admin.j('/api/takes/' + takeBaut.id, { qty: 0, taken_by: 'Eko', machine: '' }, 'PUT');
    check('edit qty 0 -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/takes/' + takeBaut.id, { qty: -2, taken_by: 'Eko', machine: '' }, 'PUT');
    check('edit qty -2 -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/takes/' + takeBaut.id, { qty: 'abc', taken_by: 'Eko', machine: '' }, 'PUT');
    check('edit qty "abc" -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/takes/' + takeBaut.id, { qty: 6, taken_by: '', machine: '' }, 'PUT');
    check('edit nama pemakai kosong -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.req('/api/items/' + idBaut);
    check('kartu stok BAUT: catatan qty 6 saldo 14 (konsisten setelah edit)',
      r.json.card.length > 0 && JSON.stringify(r.json.card).includes('"qty":6') && JSON.stringify(r.json.card).includes('"balance":14'),
      JSON.stringify(r.json.card).slice(0, 400));

    console.log('== 5. Saldo pergerakan sesudahnya bergeser saat hapus catatan tengah ==');
    r = await admin.j('/api/items', { name: 'SELANG AIR', fd_code: 'FD200003', barcode: '', stock: 20, unit: 'MTR', rack: 'RAK 2', shelf: 'B.1', jolly_box: '4', category: 'UMUM' });
    check('buat SELANG AIR stok 20', r.status === 200 && r.json.id);
    const idSelang = r.json.id;
    await admin.j('/api/take', { itemId: idSelang, qty: 5, machine: '', takenBy: 'A' });
    await admin.j('/api/take', { itemId: idSelang, qty: 2, machine: '', takenBy: 'B' });
    check('ambil 5 lalu 2 (stok 20->13)', (await stockOf(admin, idSelang)) === 13);
    r = await admin.req('/api/takes/recent');
    const selangLama = (r.json.takes || []).find((t) => t.item_id === idSelang && t.qty === 5);
    check('catatan lama (qty 5) ditemukan', !!selangLama, JSON.stringify((r.json.takes || []).map((t) => t.id)));
    r = await admin.req('/api/takes/' + selangLama.id, { method: 'DELETE' });
    check('hapus catatan lama qty 5 -> stok 18', r.status === 200 && r.json.balance === 18, JSON.stringify(r.json));
    r = await admin.req('/api/items/' + idSelang);
    check('kartu stok: catatan sisa qty 2 saldonya 18 (13+5, bukan 13)',
      r.json.card.length > 0 && JSON.stringify(r.json.card).includes('"qty":2') && JSON.stringify(r.json.card).includes('"balance":18'),
      JSON.stringify(r.json.card).slice(0, 400));

    console.log('== 6. Auth & 404: User 403, tanpa login 401, id tidak ada 404 ==');
    r = await admin.req('/api/takes/recent');
    const someTake = (r.json.takes || [])[0];
    check('ada catatan untuk uji auth', !!someTake, JSON.stringify(r.json.takes));
    r = await user.req('/api/takes/' + someTake.id);
    check('User boleh LIHAT detail catatan (GET 200)', r.status === 200, 'status=' + r.status);
    r = await user.j('/api/takes/' + someTake.id, { qty: 1, taken_by: 'X', machine: '' }, 'PUT');
    check('User edit catatan -> 403', r.status === 403, 'status=' + r.status);
    r = await user.req('/api/takes/' + someTake.id, { method: 'DELETE' });
    check('User hapus catatan -> 403', r.status === 403, 'status=' + r.status);
    r = await anon.j('/api/takes/' + someTake.id, { qty: 1, taken_by: 'X', machine: '' }, 'PUT');
    check('tanpa login edit -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.req('/api/takes/' + someTake.id, { method: 'DELETE' });
    check('tanpa login hapus -> 401', r.status === 401, 'status=' + r.status);
    r = await anon.req('/api/takes/' + someTake.id);
    check('tanpa login lihat detail -> 401', r.status === 401, 'status=' + r.status);
    r = await admin.j('/api/takes/999999', { qty: 1, taken_by: 'X', machine: '' }, 'PUT');
    check('edit id tidak ada -> 404', r.status === 404, 'status=' + r.status);
    r = await admin.req('/api/takes/999999', { method: 'DELETE' });
    check('hapus id tidak ada -> 404', r.status === 404, 'status=' + r.status);
    r = await admin.req('/api/takes/999999');
    check('lihat id tidak ada -> 404', r.status === 404, 'status=' + r.status);
    check('catatan uji auth masih utuh setelah percobaan User/anon',
      (await admin.req('/api/takes/' + someTake.id)).status === 200);

    console.log('== 7. Catatan bukan pengambilan: hanya bisa dilihat, tidak bisa diubah/dihapus ==');
    r = await admin.j('/api/items/' + idBaut + '/adjust', { qty: 2, kind: 'out', note: 'Stok keluar' });
    check('adjust keluar 2 (stok 14->12)', r.status === 200 && r.json.balance === 12, JSON.stringify(r.json));
    r = await admin.req('/api/takes/recent');
    const adjRow = (r.json.takes || []).find((t) => t.item_id === idBaut && t.qty === 2 && t.note === 'Stok keluar');
    check('adjust keluar muncul di Pengambilan terakhir', !!adjRow, JSON.stringify((r.json.takes || []).slice(0, 3)));
    r = await admin.req('/api/takes/' + adjRow.id);
    check('detail adjust keluar bisa dibuka, editable=false', r.status === 200 && r.json.take.editable === false, 'status=' + r.status + ' ' + JSON.stringify(r.json.take).slice(0, 200));
    r = await admin.req('/api/takes/' + adjRow.id, { method: 'DELETE' });
    check('hapus adjust keluar -> 400 (bukan catatan pengambilan)', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/takes/' + adjRow.id, { qty: 1, taken_by: 'X', machine: '' }, 'PUT');
    check('edit adjust keluar -> 400 (bukan catatan pengambilan)', r.status === 400, 'status=' + r.status);
    check('stok tetap 12 setelah percobaan hapus/edit adjust ditolak', (await stockOf(admin, idBaut)) === 12);

    console.log('== 8. Cek level kode: endpoint + UI detail/edit/hapus + SW v13 ==');
    r = await admin.req('/index.html');
    check('index.html memuat view-take-detail + take-detail-content', r.status === 200 && r.text.includes('view-take-detail') && r.text.includes('take-detail-content'));
    r = await admin.req('/app.js');
    check('app.js memuat openTakeDetail + endpoint /api/takes/', r.status === 200 && r.text.includes('openTakeDetail') && r.text.includes('/api/takes/'));
    check('app.js memuat tombol Hapus catatan + Ubah + Simpan perubahan', r.text.includes('btn-del-take') && r.text.includes('btn-edit-take') && r.text.includes('btn-save-take-edit'));
    check('app.js: baris recent memakai data-take (id moves, bukan id barang)', r.text.includes('data-take='));
    r = await admin.req('/sw.js');
    check('sw.js CACHE v13', r.status === 200 && r.text.includes('gudang-sparepart-v13'), r.text.slice(0, 200));
    const serverSrc = fs.readFileSync('server.js', 'utf8');
    check('server.js memuat DELETE /api/takes/:id + PUT /api/takes/:id', serverSrc.includes("app.delete('/api/takes/:id'") && serverSrc.includes("app.put('/api/takes/:id'"));
    check('server.js: hapus/edit memakai id moves (WHERE id = ?), bukan item_id', serverSrc.includes('DELETE FROM moves WHERE id = ?'));
    check('server.js: migrasi kolom created_by di moves', serverSrc.includes("ALTER TABLE moves ADD COLUMN created_by"));


    console.log('== 9. Simulasi DOM: klik baris -> detail -> Ubah/Hapus (jsdom) ==');
    if (!JSDOM) {
      console.log('  SKIP  jsdom belum terpasang — jalankan: npm install --no-save jsdom');
    } else {
      // siapkan 1 barang + 2 catatan identik untuk simulasi UI
      r = await admin.j('/api/items', { name: 'KUNCI PAS 17', fd_code: 'FD200009', barcode: '', stock: 10, unit: 'PCS', rack: 'RAK 1', shelf: 'A.3', jolly_box: '2', category: 'UMUM' });
      const idKunci = r.json.id;
      await admin.j('/api/take', { itemId: idKunci, qty: 2, machine: 'BLOWMOULD', takenBy: 'Davin' });
      await admin.j('/api/take', { itemId: idKunci, qty: 2, machine: 'BLOWMOULD', takenBy: 'Davin' });
      check('siapkan KUNCI PAS 17: 2x ambil 2 pcs (stok 10->6)', (await stockOf(admin, idKunci)) === 6);

      const htmlR = await admin.req('/index.html');
      const jsR = await admin.req('/app.js');
      check('index.html terambil untuk jsdom', htmlR.status === 200 && htmlR.text.includes('take-detail-content'));
      check('app.js terambil untuk jsdom', jsR.status === 200 && jsR.text.includes('openTakeDetail'));
      const nodeFetch = fetch;
      const dom = new JSDOM(htmlR.text, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
      dom.window.scrollTo = () => {};
      dom.window.confirm = () => true; // setujui semua dialog confirm
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
      const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      let booted = false;
      for (let i = 0; i < 20 && !booted; i++) {
        await sleep(250);
        booted = !isHidden(doc.querySelector('#app')) && isHidden(doc.querySelector('#view-login'));
      }
      check('boot jsdom: masuk aplikasi sebagai Admin', booted);
      doc.querySelector('#topnav button[data-view="take"]').click();
      await sleep(600);
      check('tab Ambil terbuka', !isHidden(doc.querySelector('#view-take')));
      const rows = () => [...doc.querySelectorAll('#take-recent [data-take]')];
      check('Pengambilan terakhir tampil (2 baris KUNCI PAS 17 terbaru di atas)',
        rows().length >= 2 && rows()[0].textContent.includes('KUNCI PAS 17'), 'baris=' + rows().length);

      // 9a. Klik baris -> detail catatan terbuka dengan tombol Ubah + Hapus
      const firstId = rows()[0].dataset.take;
      click(rows()[0]);
      await sleep(600);
      check('klik baris -> view take-detail terbuka', !isHidden(doc.querySelector('#view-take-detail')));
      const detailText = () => doc.querySelector('#take-detail-content').textContent;
      check('detail memuat nama barang + jumlah + mesin + pemakai',
        detailText().includes('KUNCI PAS 17') && detailText().includes('2') && detailText().includes('BLOWMOULD') && detailText().includes('Davin'),
        detailText().slice(0, 300));
      check('detail Admin memuat tombol Ubah + Hapus catatan',
        !!doc.querySelector('#btn-edit-take') && !!doc.querySelector('#btn-del-take'));

      // 9b. Lihat detail barang dari detail catatan, lalu kembali
      click(doc.querySelector('#btn-take-detail-item'));
      await sleep(600);
      check('tombol Lihat detail barang -> detail barang terbuka', !isHidden(doc.querySelector('#view-detail')) && doc.querySelector('#detail-content').textContent.includes('KUNCI PAS 17'));
      doc.querySelector('#btn-back-detail').click();
      await sleep(600);
      check('kembali dari detail barang -> kembali ke detail catatan', !isHidden(doc.querySelector('#view-take-detail')));

      // 9c. Ubah: qty 2 -> 1, nama Davin -> Eko, simpan -> stok 6 -> 7
      click(doc.querySelector('#btn-edit-take'));
      await sleep(200);
      check('klik Ubah -> form edit tampil terisi nilai lama',
        !isHidden(doc.querySelector('#take-edit-box')) && doc.querySelector('#take-edit-qty').value === '2' && doc.querySelector('#take-edit-by').value === 'Davin');
      doc.querySelector('#take-edit-qty').value = '1';
      doc.querySelector('#take-edit-by').value = 'Eko';
      doc.querySelector('#take-edit-machine').value = 'LABEL';
      click(doc.querySelector('#btn-save-take-edit'));
      await sleep(800);
      check('simpan edit qty 2->1 -> stok 6->7', (await stockOf(admin, idKunci)) === 7);
      check('detail sesudah edit memuat qty 1 + Eko + LABEL',
        detailText().includes('Eko') && detailText().includes('LABEL') && !detailText().includes('Davin'),
        detailText().slice(0, 300));

      // 9d. Hapus catatan yang baru diubah -> stok kembali 8, tinggal 1 catatan
      click(doc.querySelector('#btn-del-take'));
      await sleep(800);
      check('hapus catatan -> kembali ke tab Ambil', !isHidden(doc.querySelector('#view-take')));
      check('stok kembali 8 setelah hapus (7+1)', (await stockOf(admin, idKunci)) === 8);
      check('Pengambilan terakhir KUNCI PAS 17 tinggal 1 baris',
        rows().filter((b) => b.textContent.includes('KUNCI PAS 17')).length === 1, 'baris=' + rows().length);
      r = await admin.req('/api/items/' + idKunci);
      check('barang KUNCI PAS 17 TETAP ADA setelah hapus catatan', r.status === 200 && r.json.item.stock === 8);
    }
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  console.log('\nHASIL: ' + pass + ' lolos, ' + fail + ' gagal');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e); process.exit(1); });
