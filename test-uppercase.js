// Verifikasi semua penginputan teks otomatis HURUF KAPITAL — server uji terpisah
// (DB /tmp/uppercase-test.db, port 3117). TIDAK menyentuh database utama.
// Jalankan: node test-uppercase.js
// Latar: permintaan user 27 Nov 2026 ~21:11 WIB — "Terapkan semua penginputan
// jadi huruf Kapital semua yaa". Nama barang sudah kapital dari dulu; kini
// diperluas ke semua input teks (form + pencarian + edit dinamis) di client
// (listener input global, fase capture) dan normalisasi toUpperCase di server
// (helper upperName yang sudah ada) untuk semua field teks yang disimpan.
// DIKECUALIKAN: password (sensitif huruf besar-kecil) dan username (identifier,
// server sudah menormalkan ke huruf kecil). Data lama yang masih huruf kecil
// TIDAK dimigrasi — hanya input baru yang otomatis kapital.
// Bagian 6 memakai jsdom untuk simulasi DOM sungguhan. Pasang sekali:
// npm install --no-save jsdom (node_modules di-gitignore, tidak ikut
// ter-push). Bila jsdom tidak ada, bagian 6 dilewati (SKIP) dan bagian lain
// tetap jalan.
const fs = require('fs');
const { spawn } = require('child_process');
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* bagian 6 dilewati */ }

const BASE = 'http://localhost:3117';
const DB_PATH = '/tmp/uppercase-test.db';
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
    env: Object.assign({}, process.env, { PORT: '3117', DB_PATH }),
    stdio: 'ignore',
  });
  let code = 1;
  try {
    if (!(await waitUp())) { console.log('FAIL server uji tidak jalan'); process.exit(1); }

    console.log('== 1. Setup & login Admin ==');
    const anon = new Jar();
    let r = await anon.j('/api/setup', { password: 'admin123', confirm: 'admin123' });
    check('setup admin zico', r.status === 200 && r.json.ok, JSON.stringify(r.json));
    const admin = new Jar();
    r = await admin.j('/api/login', { username: 'zico', password: 'admin123' });
    check('login zico (admin)', r.status === 200 && r.json.role === 'admin');

    console.log('== 2. Server: barang baru huruf kecil -> tersimpan kapital ==');
    r = await admin.j('/api/items', { name: 'masker kain', fd_code: 'fd200001', barcode: 'bar123', stock: 20, unit: 'pcs', rack: 'rak dalam', shelf: 'c.3', jolly_box: 'box 8', category: 'kain', notes: 'kode fusion x1' });
    check('buat barang huruf kecil -> 200', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 200));
    const idMasker = r.json.id;
    r = await admin.req('/api/items/' + idMasker);
    const it = r.json.item || {};
    check('nama tersimpan MASKER KAIN', it.name === 'MASKER KAIN', JSON.stringify(it));
    check('fd_code tersimpan FD200001', it.fd_code === 'FD200001', JSON.stringify(it));
    check('barcode tersimpan BAR123', it.barcode === 'BAR123', JSON.stringify(it));
    check('rak tersimpan RAK DALAM', it.rack === 'RAK DALAM', JSON.stringify(it));
    check('shaf tersimpan C.3', it.shelf === 'C.3', JSON.stringify(it));
    check('box tersimpan BOX 8', it.jolly_box === 'BOX 8', JSON.stringify(it));
    check('kategori tersimpan KAIN', it.category === 'KAIN', JSON.stringify(it));
    check('satuan tersimpan PCS', it.unit === 'PCS', JSON.stringify(it));
    check('keterangan tersimpan KODE FUSION X1', it.notes === 'KODE FUSION X1', JSON.stringify(it));
    // Ubah (PUT) dengan huruf kecil -> kapital juga
    r = await admin.j('/api/items/' + idMasker, { name: 'masker kain baru', fd_code: 'fd200001', barcode: 'bar123', stock: 20, unit: 'pcs', rack: 'rak luar', shelf: 'd.1', jolly_box: 'box 9', category: 'kain', notes: 'catatan baru' }, 'PUT');
    check('ubah barang huruf kecil -> 200', r.status === 200, JSON.stringify(r.json).slice(0, 200));
    r = await admin.req('/api/items/' + idMasker);
    check('setelah ubah: nama MASKER KAIN BARU + rak RAK LUAR', r.json.item.name === 'MASKER KAIN BARU' && r.json.item.rack === 'RAK LUAR', JSON.stringify(r.json.item));

    console.log('== 3. Server: Ambil + edit catatan huruf kecil -> kapital; pencarian tetap jalan ==');
    r = await admin.j('/api/take', { itemId: idMasker, qty: 2, machine: 'blowmould', takenBy: 'zaenal' });
    check('ambil 2 pcs (mesin + pemakai huruf kecil) -> 200', r.status === 200 && r.json.balance === 18, JSON.stringify(r.json));
    r = await admin.req('/api/takes/recent');
    const take1 = (r.json.takes || [])[0];
    check('catatan tersimpan: mesin BLOWMOULD + pemakai ZAENAL', !!take1 && take1.machine === 'BLOWMOULD' && take1.taken_by === 'ZAENAL', JSON.stringify(take1));
    r = await admin.j('/api/takes/' + take1.id, { qty: 2, taken_by: 'eko', machine: 'label' }, 'PUT');
    check('edit catatan huruf kecil -> 200', r.status === 200, JSON.stringify(r.json).slice(0, 200));
    r = await admin.req('/api/takes/' + take1.id);
    check('setelah edit: pemakai EKO + mesin LABEL', r.json.take.taken_by === 'EKO' && r.json.take.machine === 'LABEL', JSON.stringify(r.json.take));
    // pencarian case-insensitive tetap jalan (huruf kecil maupun besar)
    r = await admin.req('/api/items?search=' + encodeURIComponent('masker kain baru') + '&filter=all&page=1&perPage=50');
    check('cari huruf kecil "masker kain baru" -> ketemu', r.status === 200 && (r.json.items || []).some((x) => x.id === idMasker), 'dapat=' + (r.json.items || []).length);
    r = await admin.req('/api/items?search=' + encodeURIComponent('MASKER KAIN BARU') + '&filter=all&page=1&perPage=50');
    check('cari huruf besar "MASKER KAIN BARU" -> ketemu', r.status === 200 && (r.json.items || []).some((x) => x.id === idMasker), 'dapat=' + (r.json.items || []).length);
    r = await admin.req('/api/items/lookup?code=' + encodeURIComponent('fd200001'));
    check('lookup kode huruf kecil fd200001 -> 200', r.status === 200 && r.json.item && r.json.item.id === idMasker, 'status=' + r.status);

    console.log('== 4. Server: tools, pinjam, supplier, SO, adjust huruf kecil -> kapital ==');
    r = await admin.j('/api/tools', { name: 'kunci kombinasi 13' });
    check('tambah tools huruf kecil -> 200', r.status === 200 && r.json.tool && r.json.tool.id, JSON.stringify(r.json).slice(0, 200));
    const toolId = r.json.tool.id;
    check('nama tools tersimpan KUNCI KOMBINASI 13', r.json.tool.name === 'KUNCI KOMBINASI 13', JSON.stringify(r.json.tool));
    r = await admin.j('/api/loans', { toolId, qty: 1, borrower: 'budi', machine: 'conveyor' });
    check('pinjam (peminjam + mesin huruf kecil) -> 200', r.status === 200 && r.json.loan, JSON.stringify(r.json).slice(0, 200));
    check('pinjaman tersimpan: peminjam BUDI + mesin CONVEYOR', r.json.loan.borrower === 'BUDI' && r.json.loan.machine === 'CONVEYOR', JSON.stringify(r.json.loan));
    r = await admin.j('/api/loans', { tool: 'kunci kombinasi 13', qty: 1, borrower: 'siti' });
    check('pinjam via nama tools huruf kecil -> ketemu + 200', r.status === 200 && r.json.loan.tool_name === 'KUNCI KOMBINASI 13', JSON.stringify(r.json).slice(0, 200));
    r = await admin.j('/api/supplier-loans', { code: 'fd200001', qty: 1, supplier: 'bangun sarana', purpose: 'service' });
    check('supplier stok (nama huruf kecil) -> 200', r.status === 200 && r.json.loan, JSON.stringify(r.json).slice(0, 200));
    check('supplier tersimpan BANGUN SARANA', r.json.loan.supplier === 'BANGUN SARANA', JSON.stringify(r.json.loan));
    r = await admin.j('/api/supplier-loans', { code: 'fd999999', qty: 1, supplier: 'toko abc', purpose: 'contoh', manualName: 'base mold' });
    check('supplier non-stok (nama part huruf kecil) -> 200', r.status === 200 && r.json.loan, JSON.stringify(r.json).slice(0, 200));
    check('non-stok tersimpan: manual BASE MOLD + kode FD999999 + supplier TOKO ABC',
      r.json.loan.manual_name === 'BASE MOLD' && r.json.loan.manual_code === 'FD999999' && r.json.loan.supplier === 'TOKO ABC', JSON.stringify(r.json.loan));
    r = await admin.j('/api/so', { code: 'fd200001', counted: 17 });
    check('SO dengan kode huruf kecil fd200001 -> 200 (lookup SO kini tidak sensitif huruf)', r.status === 200 && r.json.record, JSON.stringify(r.json).slice(0, 200));
    r = await admin.j('/api/items/' + idMasker + '/adjust', { qty: 1, kind: 'in', note: 'opname pagi' });
    check('adjust stok + keterangan huruf kecil -> 200', r.status === 200, JSON.stringify(r.json).slice(0, 200));
    r = await admin.req('/api/items/' + idMasker);
    const adjMove = (r.json.card || []).flatMap((d) => d.rows).find((m) => m.note === 'OPNAME PAGI');
    check('keterangan adjust tersimpan OPNAME PAGI di kartu stok', !!adjMove, JSON.stringify((r.json.card || []).flatMap((d) => d.rows).map((m) => m.note)));

    console.log('== 5. Server: password TIDAK berubah (login tetap sensitif huruf) ==');
    r = await admin.j('/api/accounts', { username: 'budi', password: 'AbC1234x', role: 'user' });
    check('buat akun user budi (password campuran) -> 200', r.status === 200 && r.json.id, JSON.stringify(r.json).slice(0, 200));
    const userOk = new Jar();
    r = await userOk.j('/api/login', { username: 'budi', password: 'AbC1234x' });
    check('login password persis "AbC1234x" -> 200', r.status === 200 && r.json.role === 'user', 'status=' + r.status);
    const userBad = new Jar();
    r = await userBad.j('/api/login', { username: 'budi', password: 'abc1234x' });
    check('login password huruf kecil semua "abc1234x" -> DITOLAK 401', r.status === 401, 'status=' + r.status);
    const userBad2 = new Jar();
    r = await userBad2.j('/api/login', { username: 'budi', password: 'ABC1234X' });
    check('login password huruf besar semua "ABC1234X" -> DITOLAK 401', r.status === 401, 'status=' + r.status);

    console.log('== 6. Simulasi DOM (jsdom): ketik huruf kecil -> jadi kapital di semua form; password + username tidak ==');
    if (!JSDOM) {
      console.log('  SKIP  jsdom belum terpasang — jalankan: npm install --no-save jsdom');
    } else {
      const htmlR = await admin.req('/index.html');
      const jsR = await admin.req('/app.js');
      check('index.html terambil untuk jsdom', htmlR.status === 200 && htmlR.text.includes('id="take-code"'));
      check('app.js terambil untuk jsdom', jsR.status === 200 && jsR.text.includes("document.addEventListener('input'"));
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
      const typeInto = (el, val) => {
        el.value = val;
        try { el.setSelectionRange(val.length, val.length); } catch (_) {}
        el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        return el.value;
      };
      // semua input teks statis: ketik huruf kecil -> langsung kapital
      const textFields = ['inv-search', 'add-name', 'add-fd', 'add-barcode', 'add-unit', 'add-rack', 'add-shelf', 'add-box', 'add-category', 'add-notes', 'take-code', 'take-machine', 'take-by', 'tool-name', 'loan-tool-search', 'loan-borrower', 'loan-machine', 'supplier-code', 'supplier-manual-name', 'supplier-name', 'so-code'];
      let allCaps = true, badField = '';
      for (const id of textFields) {
        const el = doc.querySelector('#' + id);
        if (!el) { allCaps = false; badField = id + ' (tidak ada)'; break; }
        const out = typeInto(el, 'abc xyz-123');
        if (out !== 'ABC XYZ-123') { allCaps = false; badField = id + ' -> ' + out; break; }
      }
      check('21 input teks statis: ketik kecil -> jadi kapital', allCaps, badField);
      // posisi kursor tetap (tidak lompat ke akhir saat mengetik di tengah)
      const caretEl = doc.querySelector('#add-name');
      caretEl.value = 'ab';
      caretEl.setSelectionRange(1, 1);
      caretEl.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      check('kursor tetap di posisi 1 setelah kapitalisasi', caretEl.value === 'AB' && caretEl.selectionStart === 1, 'value=' + caretEl.value + ' pos=' + caretEl.selectionStart);
      // password + username DIKECUALIKAN
      check('password login TIDAK berubah', typeInto(doc.querySelector('#login-password'), 'aBc123') === 'aBc123');
      check('password setup TIDAK berubah', typeInto(doc.querySelector('#setup-password'), 'aBc123') === 'aBc123');
      check('password baru (ganti pw) TIDAK berubah', typeInto(doc.querySelector('#pw-new'), 'aBc123') === 'aBc123');
      check('username login TIDAK berubah', typeInto(doc.querySelector('#login-username'), 'budi') === 'budi');
      check('username baru TIDAK berubah', typeInto(doc.querySelector('#new-user-name'), 'budi') === 'budi');
      // input dinamis (dibuat saat runtime) ikut tercakup listener global
      const dyn = doc.createElement('input');
      dyn.id = 'take-edit-machine';
      doc.body.appendChild(dyn);
      check('input dinamis take-edit-machine ikut kapital', typeInto(dyn, 'blowmould') === 'BLOWMOULD');
      const dynPw = doc.createElement('input');
      dynPw.type = 'password';
      doc.body.appendChild(dynPw);
      check('input dinamis type=password tetap tidak berubah', typeInto(dynPw, 'aBc123') === 'aBc123');
      const dynNum = doc.createElement('input');
      dynNum.type = 'number';
      doc.body.appendChild(dynNum);
      check('input dinamis type=number tetap tidak berubah', typeInto(dynNum, '12') === '12');
      // live search tetap jalan walau diketik huruf kecil (kapitalisasi jalan
      // SEBELUM handler pencarian karena fase capture)
      const search = doc.querySelector('#inv-search');
      doc.querySelector('#topnav button[data-view="inventory"]').click();
      await sleep(800);
      search.value = 'masker kain baru';
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await sleep(1000);
      check('cari huruf kecil di Inventaris -> kotak jadi MASKER... + barang ketemu',
        search.value === 'MASKER KAIN BARU' && doc.querySelector('#inv-list').textContent.includes('MASKER KAIN BARU'),
        'kotak=' + search.value);
      // cek duplikat Kode FD tetap jalan walau diketik huruf kecil
      dom.window.eval('openAddForm()');
      await sleep(500);
      const fdEl = doc.querySelector('#add-fd');
      fdEl.value = 'fd200001';
      fdEl.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await sleep(800);
      check('ketik fd200001 kecil -> kotak jadi FD200001 + peringatan duplikat muncul',
        fdEl.value === 'FD200001' && !isHidden(doc.querySelector('#add-fd-warning')) && doc.querySelector('#add-fd-warning').textContent.includes('MASKER KAIN BARU'),
        'kotak=' + fdEl.value + ' warn=' + (doc.querySelector('#add-fd-warning') || {}).textContent);
    }

    console.log('\n' + pass + ' lolos, ' + fail + ' gagal.');
    code = fail ? 1 : 0;
  } finally {
    server.kill();
  }
  process.exit(code);
})();
