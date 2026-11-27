// Verifikasi pembatasan peran: (1) Ganti password sendiri HANYA Admin —
// User tidak boleh (tombol disembunyikan + endpoint 403); bila lupa, Admin
// mereset dari menu Akun Admin. (2) Tambah Tools HANYA Admin — User boleh
// meminjam tapi tidak boleh menambah tools baru.
// Server uji terpisah (DB /tmp/password-test.db, port 3118).
// TIDAK menyentuh database utama. Jalankan: node test-password.js
const fs = require('fs');
const { spawn } = require('child_process');

const BASE = 'http://localhost:3118';
const DB_PATH = '/tmp/password-test.db';
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* bagian jsdom dilewati */ }

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
    env: Object.assign({}, process.env, { PORT: '3118', DB_PATH }),
    stdio: 'ignore',
  });
  let code = 0;
  try {
    if (!(await waitUp())) { console.log('FAIL server uji tidak jalan'); process.exit(1); }

    console.log('== 1. Setup & login (Admin + User) ==');
    const anon = new Jar();
    let r = await anon.j('/api/setup', { password: 'admin123', confirm: 'admin123' });
    check('setup admin zico', r.status === 200 && r.json.ok, JSON.stringify(r.json));
    const admin = new Jar();
    r = await admin.j('/api/login', { username: 'zico', password: 'admin123' });
    check('login zico/admin', r.status === 200 && r.json.role === 'admin');
    r = await admin.j('/api/accounts', { username: 'budi', password: 'budi1234', role: 'user' });
    check('admin buat akun user budi', r.status === 200 && r.json.username === 'budi', JSON.stringify(r.json));
    const budiId = r.json.id;
    const user = new Jar();
    r = await user.j('/api/login', { username: 'budi', password: 'budi1234' });
    check('login budi/user', r.status === 200 && r.json.role === 'user');

    console.log('== 2. Ganti password sendiri: hanya Admin ==');
    r = await anon.j('/api/change-password', { oldPassword: 'x', newPassword: 'baru1234' });
    check('tanpa login -> 401', r.status === 401, 'status=' + r.status);
    r = await user.j('/api/change-password', { oldPassword: 'budi1234', newPassword: 'coba1234' });
    check('User ganti password sendiri DITOLAK (403)', r.status === 403, 'status=' + r.status);
    const userStill = new Jar();
    r = await userStill.j('/api/login', { username: 'budi', password: 'budi1234' });
    check('password User TIDAK berubah (login lama masih jalan)', r.status === 200, 'status=' + r.status);
    const userHack = new Jar();
    r = await userHack.j('/api/login', { username: 'budi', password: 'coba1234' });
    check('password baru User yang ditolak TIDAK bisa dipakai login (401)', r.status === 401, 'status=' + r.status);
    r = await user.req('/api/me');
    check('sesi User tetap jalan setelah penolakan', r.status === 200 && r.json.username === 'budi');
    r = await admin.j('/api/change-password', { oldPassword: 'salah', newPassword: 'adminBaru1' });
    check('Admin password lama salah -> 400', r.status === 400, 'status=' + r.status);
    r = await admin.j('/api/change-password', { oldPassword: 'admin123', newPassword: 'adminBaru1' });
    check('Admin ganti password sendiri BERHASIL (200)', r.status === 200, JSON.stringify(r.json));
    const adminNew = new Jar();
    r = await adminNew.j('/api/login', { username: 'zico', password: 'adminBaru1' });
    check('login Admin dgn password baru', r.status === 200, 'status=' + r.status);
    const adminOld = new Jar();
    r = await adminOld.j('/api/login', { username: 'zico', password: 'admin123' });
    check('login Admin dgn password lama DITOLAK (401)', r.status === 401, 'status=' + r.status);
    r = await admin.req('/api/me');
    check('sesi Admin saat ini tetap jalan setelah ganti password', r.status === 200 && r.json.role === 'admin');
    r = await admin.j('/api/change-password', { oldPassword: 'adminBaru1', newPassword: 'admin123' });
    check('kembalikan password Admin ke admin123', r.status === 200, JSON.stringify(r.json));
    r = await adminNew.j('/api/login', { username: 'zico', password: 'admin123' });
    check('login Admin dgn admin123 lagi', r.status === 200, 'status=' + r.status);

    console.log('== 3. Lupa password User -> Admin reset dari menu Akun Admin ==');
    r = await user.j('/api/accounts/' + budiId + '/password', { password: 'nakal123' });
    check('User reset password akun lain DITOLAK (403)', r.status === 403, 'status=' + r.status);
    r = await admin.j('/api/accounts/' + budiId + '/password', { password: 'reset9999' });
    check('Admin reset password User BERHASIL (200)', r.status === 200, JSON.stringify(r.json));
    const userReset = new Jar();
    r = await userReset.j('/api/login', { username: 'budi', password: 'reset9999' });
    check('login User dgn password hasil reset', r.status === 200, 'status=' + r.status);
    const userOldPw = new Jar();
    r = await userOldPw.j('/api/login', { username: 'budi', password: 'budi1234' });
    check('password lama User sudah tidak berlaku (401)', r.status === 401, 'status=' + r.status);
    r = await admin.j('/api/accounts/' + budiId + '/password', { password: 'budi1234' });
    check('kembalikan password User ke budi1234 (untuk seksi jsdom)', r.status === 200, JSON.stringify(r.json));

    console.log('== 4. Tambah Tools: hanya Admin ==');
    // Catatan: reset password di §3 mencabut SEMUA sesi User (perilaku server
    // yang benar) — login ulang dulu sebelum memakai Jar user lagi.
    r = await user.j('/api/login', { username: 'budi', password: 'budi1234' });
    check('login ulang User setelah reset password (sesi lama dicabut)', r.status === 200, 'status=' + r.status);
    r = await admin.req('/api/tools');
    check('awal: 0 tools', r.status === 200 && r.json.tools.length === 0, 'n=' + (r.json.tools && r.json.tools.length));
    r = await user.j('/api/tools', { name: 'OBENG PLUS' });
    check('User tambah tools DITOLAK (403)', r.status === 403, 'status=' + r.status);
    r = await admin.req('/api/tools');
    check('tools TIDAK bertambah setelah penolakan (tetap 0)', r.status === 200 && r.json.tools.length === 0, 'n=' + (r.json.tools && r.json.tools.length));
    r = await anon.j('/api/tools', { name: 'OBENG PLUS' });
    check('tanpa login tambah tools -> 401', r.status === 401, 'status=' + r.status);
    r = await admin.j('/api/tools', { name: 'OBENG PLUS' });
    check('Admin tambah tools BERHASIL (200)', r.status === 200 && r.json.tool && r.json.tool.id, JSON.stringify(r.json).slice(0, 120));
    const toolId = r.json.tool.id;
    r = await admin.req('/api/tools');
    check('GET /api/tools: 1 tools (tetap bisa dibaca User)', r.status === 200 && r.json.tools.length === 1, 'n=' + (r.json.tools && r.json.tools.length));
    r = await user.req('/api/tools');
    check('User tetap bisa LIHAT daftar tools (untuk meminjam)', r.status === 200 && r.json.tools.length === 1, 'n=' + (r.json.tools && r.json.tools.length));
    r = await user.j('/api/loans', { toolId, qty: 1, borrower: 'Budi' });
    check('User tetap bisa MEMINJAM tools (200)', r.status === 200 && r.json.loan && r.json.loan.status === 'dipinjam', JSON.stringify(r.json).slice(0, 150));
    r = await user.req('/api/tools/' + toolId, { method: 'DELETE' });
    check('User hapus tools DITOLAK (403)', r.status === 403, 'status=' + r.status);
    r = await admin.req('/api/tools/' + toolId, { method: 'DELETE' });
    check('Admin hapus tools yg masih dipinjam DITOLAK (400)', r.status === 400, 'status=' + r.status);
    // kembalikan pinjaman dulu supaya tools bisa dihapus (DB uji bersih untuk jsdom)
    const loans = await admin.req('/api/loans?status=dipinjam');
    const loanId = loans.json.loans[0].id;
    r = await admin.j('/api/loans/' + loanId + '/return', { photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
    check('kembalikan pinjaman (untuk bersih-bersih)', r.status === 200, JSON.stringify(r.json).slice(0, 120));
    r = await admin.req('/api/tools/' + toolId, { method: 'DELETE' });
    check('Admin hapus tools setelah pinjaman kembali BERHASIL', r.status === 200, JSON.stringify(r.json));
    r = await admin.req('/api/tools');
    check('akhir: 0 tools lagi', r.status === 200 && r.json.tools.length === 0, 'n=' + (r.json.tools && r.json.tools.length));

    console.log('== 5. Simulasi DOM (jsdom): tombol ganti password + tambah tools hanya untuk Admin ==');
    if (!JSDOM) {
      console.log('  SKIP  jsdom belum terpasang — jalankan: npm install --no-save jsdom');
    } else {
      const nodeFetch = fetch;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const bootDom = async (jar) => {
        const htmlR = await jar.req('/index.html');
        const jsR = await jar.req('/app.js');
        const dom = new JSDOM(htmlR.text, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
        dom.window.scrollTo = () => {};
        dom.window.fetch = (url, opts = {}) => {
          const abs = String(url).startsWith('http') ? String(url) : BASE + url;
          const headers = Object.assign({}, opts.headers || {});
          if (jar.cookie) headers.Cookie = jar.cookie;
          return nodeFetch(abs, Object.assign({}, opts, { headers }));
        };
        dom.window.eval(jsR.text);
        const doc = dom.window.document;
        let booted = false;
        for (let i = 0; i < 20 && !booted; i++) {
          await sleep(250);
          booted = !doc.querySelector('#app').classList.contains('hidden') && doc.querySelector('#view-login').classList.contains('hidden');
        }
        return { dom, doc, booted };
      };
      // --- Admin ---
      const a = await bootDom(admin);
      check('boot jsdom sebagai Admin', a.booted);
      check('Admin: tombol "Ganti password saya" tampil',
        a.doc.querySelector('#btn-change-pw').style.display !== 'none');
      check('Admin: petunjuk lupa password tersembunyi',
        a.doc.querySelector('#acc-pw-hint').classList.contains('hidden'));
      check('Admin: baris tambah tools tampil',
        a.doc.querySelector('#tool-add-row').style.display !== 'none');
      a.doc.querySelector('#topnav button[data-view="account"]').click();
      await sleep(300);
      check('Admin di halaman Akun: tombol ganti password tetap tampil + hint tersembunyi',
        a.doc.querySelector('#btn-change-pw').style.display !== 'none'
        && a.doc.querySelector('#acc-pw-hint').classList.contains('hidden'));
      a.doc.querySelector('#topnav button[data-view="loan"]').click();
      await sleep(800);
      check('Admin di menu Pinjam: baris tambah tools tampil + kolom nama tools ada',
        a.doc.querySelector('#tool-add-row').style.display !== 'none' && !!a.doc.querySelector('#tool-name'));
      // --- User ---
      const userFresh = new Jar();
      r = await userFresh.j('/api/login', { username: 'budi', password: 'budi1234' });
      check('login ulang budi untuk jsdom', r.status === 200);
      const u = await bootDom(userFresh);
      check('boot jsdom sebagai User', u.booted);
      check('User: tombol "Ganti password saya" DISEMBUNYIKAN',
        u.doc.querySelector('#btn-change-pw').style.display === 'none');
      check('User: petunjuk "Lupa password? Minta Admin" tampil',
        !u.doc.querySelector('#acc-pw-hint').classList.contains('hidden')
        && u.doc.querySelector('#acc-pw-hint').textContent.includes('Minta Admin'));
      check('User: baris tambah tools DISEMBUNYIKAN',
        u.doc.querySelector('#tool-add-row').style.display === 'none');
      check('User: tombol Logout tetap tampil',
        u.doc.querySelector('#btn-logout').style.display !== 'none');
      u.doc.querySelector('#topnav button[data-view="account"]').click();
      await sleep(300);
      check('User di halaman Akun: tombol ganti password tetap tersembunyi, hint tampil',
        u.doc.querySelector('#btn-change-pw').style.display === 'none'
        && !u.doc.querySelector('#acc-pw-hint').classList.contains('hidden'));
      u.doc.querySelector('#topnav button[data-view="loan"]').click();
      await sleep(800);
      check('User di menu Pinjam: baris tambah tools tetap tersembunyi',
        u.doc.querySelector('#tool-add-row').style.display === 'none');
      check('User di menu Pinjam: pencarian tools + daftar tetap bisa dipakai',
        !!u.doc.querySelector('#loan-tool-search')
        && u.doc.querySelector('#tool-list').textContent.includes('Minta Admin untuk menambahkan tools'));
    }

    console.log('\n' + pass + ' lolos, ' + fail + ' gagal.');
    code = fail ? 1 : 0;
  } finally {
    server.kill();
  }
  process.exit(code);
})().catch((e) => { console.error('ERROR:', e); process.exit(2); });
