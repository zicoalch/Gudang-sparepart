// Gudang Sparepart — frontend SPA
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let ME = null;            // {username, role}
let IS_ADMIN = false;
let currentView = 'dashboard';
let invPage = 1, invSearch = '', invFilter = 'all';
let importJobId = null, importSheet = null;
let takeItem = null;
let soItem = null;
let detailId = null, detailBack = 'dashboard';
let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), 3500);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt(n) { return Number(n || 0).toLocaleString('id-ID'); }
function localDate(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDateID(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d + '/' + m + '/' + y;
}
// YOI / MOI — MOI 1 desimal (4,0 bln), YOI 2 desimal (0,33 thn)
function fmtMoi(v) { return v == null ? '–' : v.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' bln'; }
function fmtYoi(v) { return v == null ? '–' : v.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' thn'; }
function timeOf(iso) { return iso ? iso.slice(11, 16) : ''; }

// Thumbnail daftar yang gagal dimuat (mis. foto rusak) diganti placeholder
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.matches && t.matches('img.thumb')) {
    const ph = document.createElement('span');
    ph.className = 'thumb thumb-empty';
    ph.innerHTML = '📦<span>Belum ada foto</span>';
    t.replaceWith(ph);
  }
}, true);

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}));
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Terjadi kesalahan.');
    return j;
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}
function apiJSON(path, body, method) {
  return api(path, {
    method: method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------- navigasi ----------
function showView(name) {
  if ((name === 'so' || name === 'history') && !IS_ADMIN) {
    toast(name === 'so' ? 'Menu SO hanya untuk Admin.' : 'Menu Riwayat hanya untuk Admin.');
    if (currentView !== 'dashboard') showView('dashboard');
    return;
  }
  currentView = name;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $('#view-' + name);
  if (el) el.classList.remove('hidden');
  $$('#topnav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name || (name === 'detail' && b.dataset.view === 'inventory') || (name === 'add' && b.dataset.view === 'inventory')));
  window.scrollTo(0, 0);
  if (name === 'dashboard') loadDashboard();
  if (name === 'inventory') loadInventory();
  if (name === 'take') loadTakeRecent();
  if (name === 'loan') loadLoans();
  if (name === 'so') loadSo();
  if (name === 'history') loadHistory();
  if (name === 'account') loadAccount();
  if (name === 'photo-search') loadPhotoSearchNote();
}
$('#topnav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) showView(b.dataset.view);
});
$$('.menu-card[data-goto]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.goto === 'add') openAddForm();
  else showView(b.dataset.goto);
}));

// ---------- auth ----------
async function boot() {
  try {
    const st = await api('/api/status');
    if (st.setupNeeded) {
      $('#view-login').classList.remove('hidden');
      $('#setup-box').classList.remove('hidden');
      return;
    }
    const me = await api('/api/me').catch(() => null);
    if (me) { enterApp(me); return; }
    $('#view-login').classList.remove('hidden');
    $('#login-box').classList.remove('hidden');
  } catch (e) {
    $('#view-login').classList.remove('hidden');
    $('#login-box').classList.remove('hidden');
    showLoginError('Tidak bisa terhubung ke server. Coba lagi.');
  }
}
function showLoginError(msg) {
  const el = $('#login-error');
  el.textContent = msg; el.classList.remove('hidden');
}
$('#btn-setup').addEventListener('click', async () => {
  const pw = $('#setup-password').value, cf = $('#setup-confirm').value;
  try {
    await apiJSON('/api/setup', { password: pw, confirm: cf });
    toast('Akun Admin zico dibuat. Silakan login.');
    $('#setup-box').classList.add('hidden');
    $('#login-box').classList.remove('hidden');
    $('#login-username').value = 'zico';
  } catch (e) { showLoginError(e.message); }
});
async function doLogin() {
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  try {
    const r = await apiJSON('/api/login', { username, password });
    enterApp(r);
  } catch (e) { showLoginError(e.message); }
}
$('#btn-login').addEventListener('click', doLogin);
$('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

function enterApp(me) {
  ME = me; IS_ADMIN = me.role === 'admin';
  $('#view-login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#role-chip').textContent = me.username + ' · ' + (IS_ADMIN ? 'Admin' : 'User');
  $('#menu-add').style.display = IS_ADMIN ? '' : 'none';
  $('#btn-add-from-inv').style.display = IS_ADMIN ? '' : 'none';
  $('#btn-open-import').style.display = IS_ADMIN ? '' : 'none';
  $$('#topnav button[data-view="so"]').forEach((b) => { b.style.display = IS_ADMIN ? '' : 'none'; });
  $$('#topnav button[data-view="history"]').forEach((b) => { b.style.display = IS_ADMIN ? '' : 'none'; });
  $('#btn-print-qr').style.display = IS_ADMIN ? '' : 'none';
  $('#dash-out-section').style.display = IS_ADMIN ? '' : 'none';
  $('#dash-date-row').style.display = IS_ADMIN ? '' : 'none';
  $('#dash-date').value = localDate();
  $('#so-date').value = localDate();
  showView('dashboard');
}
$('#btn-logout').addEventListener('click', async () => {
  await apiJSON('/api/logout', {});
  location.reload();
});
$('#btn-change-pw').addEventListener('click', () => $('#pw-box').classList.toggle('hidden'));
$('#btn-pw-save').addEventListener('click', async () => {
  try {
    await apiJSON('/api/change-password', { oldPassword: $('#pw-old').value, newPassword: $('#pw-new').value });
    toast('Password berhasil diganti.');
    $('#pw-box').classList.add('hidden');
    $('#pw-old').value = ''; $('#pw-new').value = '';
  } catch (e) { toast(e.message); }
});

// ---------- dashboard ----------
async function loadDashboard() {
  try {
    const s = await api('/api/stats');
    $('#st-items').textContent = fmt(s.items);
    $('#st-units').textContent = fmt(s.units);
    $('#st-low').textContent = fmt(s.low);
    $('#st-out').textContent = fmt(s.out);
    $('#st-racks').textContent = fmt(s.racks);
    $('#st-boxes').textContent = fmt(s.boxes);
  } catch (e) { /* diam */ }
  loadLoanAlert();
  if (IS_ADMIN) loadOutHistory();
}
// Kartu peringatan peminjaman terlambat — terlihat untuk Admin DAN User
async function loadLoanAlert() {
  const box = $('#dash-loan-alert');
  box.classList.add('hidden');
  try {
    const r = await api('/api/loans?status=terlambat');
    if (!r.overdueCount) return;
    const lines = r.loans.slice(0, 3).map((l) => esc(l.item_name) + ' — ' + esc(l.borrower) + ' (terlambat ' + fmt(l.overdue_days) + ' hari)').join('<br>');
    const more = r.overdueCount > 3 ? '<br>+' + fmt(r.overdueCount - 3) + ' lagi…' : '';
    box.innerHTML = '⚠️ Ada <b>' + fmt(r.overdueCount) + ' peminjaman</b> sudah lewat 2 hari belum dikembalikan.<br>' + lines + more + '<br><span class="muted small">Ketuk untuk melihat →</span>';
    box.classList.remove('hidden');
  } catch (e) { /* diam */ }
}
$('#dash-loan-alert').addEventListener('click', () => showView('loan'));
async function loadOutHistory() {
  const date = $('#dash-date').value || localDate();
  $('#out-date-label').textContent = fmtDateID(date);
  try {
    const r = await api('/api/out-history?date=' + date);
    $('#out-total').textContent = fmt(r.total);
    const list = $('#out-list');
    if (!r.rows.length) { list.innerHTML = '<p class="muted">Belum ada sparepart keluar pada tanggal ini.</p>'; return; }
    list.innerHTML = r.rows.map((m) => `
      <button class="row" data-item="${m.item_id}">
        <span class="r-stock">−${fmt(m.qty)}</span>
        <span class="r-name">${esc(m.item_name)}</span>
        <div class="r-sub">${esc(m.fd_code || '')} • ${esc(m.machine || '-')} • ${esc(m.taken_by || '-')} • ${timeOf(m.created_at)} WIB</div>
      </button>`).join('');
    list.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => openDetail(+b.dataset.item, 'dashboard')));
  } catch (e) { $('#out-list').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}
$('#dash-date').addEventListener('change', loadOutHistory);
function downloadHistoryExport(date) {
  const url = '/api/history/export' + (date ? '?date=' + encodeURIComponent(date) : '');
  const a = document.createElement('a');
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
$('#btn-export-out').addEventListener('click', () => {
  downloadHistoryExport($('#dash-date').value || localDate());
});

// ---------- inventaris ----------
let invTimer = null;
$('#inv-search').addEventListener('input', (e) => {
  clearTimeout(invTimer);
  invTimer = setTimeout(() => { invSearch = e.target.value.trim(); invPage = 1; loadInventory(); }, 350);
});
$('#inv-filter').addEventListener('change', (e) => { invFilter = e.target.value; invPage = 1; loadInventory(); });
$('#inv-prev').addEventListener('click', () => { if (invPage > 1) { invPage--; loadInventory(); } });
$('#inv-next').addEventListener('click', () => { invPage++; loadInventory(); });

async function loadInventory() {
  try {
    const r = await api('/api/items?search=' + encodeURIComponent(invSearch) + '&filter=' + invFilter + '&page=' + invPage + '&perPage=50');
    if (r.page > r.pages) { invPage = r.pages; return loadInventory(); }
    $('#inv-count').textContent = fmt(r.total) + ' barang';
    $('#inv-page-info').textContent = 'Hal ' + r.page + ' / ' + r.pages;
    const list = $('#inv-list');
    if (!r.items.length) { list.innerHTML = '<p class="muted">Tidak ada barang yang cocok.</p>'; return; }
    list.innerHTML = r.items.map((it) => {
      const thumb = it.hasPhoto
        ? '<img class="thumb" src="/api/items/' + it.id + '/photo" alt="Foto ' + esc(it.name) + '" loading="lazy">'
        : '<span class="thumb thumb-empty">📦<span>Belum ada foto</span></span>';
      const sub = (it.fd_code ? esc(it.fd_code) + ' • ' : '') + 'Rak ' + esc(it.rack || '-') + ' • Shaf ' + esc(it.shelf || '-') + ' • Box ' + esc(it.jolly_box || '-');
      return '<button class="row" data-item="' + it.id + '">'
        + thumb
        + '<span class="r-stock ' + (it.stock <= 0 ? 'low' : '') + '">' + fmt(it.stock) + ' <small>' + esc(it.unit) + '</small></span>'
        + '<span class="r-name">' + esc(it.name) + '</span>'
        + '<div class="r-sub">' + sub + '</div>'
        + '</button>';
    }).join('');
    list.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => openDetail(+b.dataset.item, 'inventory')));
  } catch (e) { $('#inv-list').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}
// ---------- cetak QR ----------
function printQrCodes(items, title) {
  const area = $('#print-area');
  const cards = items.map((it) => {
    const code = it.fd_code || it.barcode || '';
    return '<div class="qr-print-card">'
      + '<img src="/api/items/' + it.id + '/qr" alt="QR ' + esc(code) + '">'
      + '<b>' + esc(it.name) + '</b>'
      + '<span>' + esc(code) + '</span>'
      + '</div>';
  }).join('');
  area.innerHTML = '<h1 class="qr-print-title">' + esc(title || 'QR Code Sparepart') + '</h1>'
    + '<div class="qr-print-grid">' + cards + '</div>';
  area.classList.remove('hidden');
  // tunggu semua gambar QR termuat dulu supaya tidak tercetak kosong
  const imgs = Array.from(area.querySelectorAll('img'));
  let done = 0, fired = false;
  const finish = () => { if (!fired) { fired = true; window.print(); } };
  if (!imgs.length) { finish(); return; }
  const fallback = setTimeout(finish, 5000);
  imgs.forEach((img) => {
    const step = () => { if (++done >= imgs.length) { clearTimeout(fallback); finish(); } };
    if (img.complete) step();
    else { img.onload = step; img.onerror = step; }
  });
}
window.addEventListener('afterprint', () => { $('#print-area').classList.add('hidden'); });

async function fetchAllFilteredItems() {
  const all = [];
  let page = 1;
  for (;;) {
    const r = await api('/api/items?search=' + encodeURIComponent(invSearch) + '&filter=' + invFilter + '&page=' + page + '&perPage=100');
    all.push(...r.items);
    if (page >= r.pages) break;
    page++;
  }
  return all;
}
$('#btn-print-qr').addEventListener('click', async () => {
  try {
    toast('Menyiapkan lembar QR…');
    const all = await fetchAllFilteredItems();
    const withCode = all.filter((it) => it.fd_code || it.barcode);
    const skipped = all.length - withCode.length;
    if (!withCode.length) { toast('Tidak ada barang dengan Kode FD / barcode pada filter ini.'); return; }
    const label = invFilter === 'low' ? 'Stok menipis' : invFilter === 'out' ? 'Stok habis' : 'Semua barang';
    printQrCodes(withCode, 'QR Code Sparepart — ' + label + (invSearch ? ' — cari: ' + invSearch : ''));
    if (skipped) toast('Mencetak ' + withCode.length + ' QR. ' + skipped + ' barang dilewati (tanpa Kode FD / barcode).');
  } catch (e) { toast(e.message); }
});

$('#btn-add-from-inv').addEventListener('click', openAddForm);

// ---------- tambah / ubah ----------
let addPhotoData = ''; // base64 data URI (sudah dikecilkan)
let fdDupItem = null; // barang lain yang Kode FD-nya sama (peringatan duplikat)
let fdCheckSeq = 0;   // penanda urutan cek, supaya hasil basi tidak menimpa hasil baru
let fdCheckTimer = null;
function openAddForm() {
  if (!IS_ADMIN) { toast('Hanya Admin yang boleh menambah sparepart.'); return; }
  resetAddForm();
  $('#add-title').textContent = 'Tambah Sparepart';
  showView('add');
}
function resetAddForm() {
  $('#form-add').reset();
  $('#add-id').value = '';
  addPhotoData = '';
  $('#add-photo-preview').classList.add('hidden');
  $('#add-photo-preview').src = '';
  $('#btn-photo-remove').classList.add('hidden');
  $('#photo-error').classList.add('hidden');
  fdDupItem = null;
  $('#add-fd-warning').classList.add('hidden');
  $('#add-fd-warning').innerHTML = '';
  $('#add-stock').value = '0';
  $('#add-unit').value = 'PCS';
}
// Peringatan Kode FD duplikat: cek apakah ada barang LAIN dengan Kode FD yang sama
// (abaikan huruf besar/kecil + spasi ujung). Mengembalikan barang yang cocok, atau null.
// Di form Ubah, kode milik barang yang sedang diedit sendiri tidak dihitung duplikat.
async function checkFdDuplicate() {
  const code = $('#add-fd').value.trim();
  const warnEl = $('#add-fd-warning');
  const seq = ++fdCheckSeq;
  fdDupItem = null;
  warnEl.classList.add('hidden');
  warnEl.innerHTML = '';
  if (!code) return null;
  let item = null;
  try {
    const r = await api('/api/items/lookup?code=' + encodeURIComponent(code));
    item = r.item;
  } catch (e) { return null; } // 404 = kode belum dipakai
  if (seq !== fdCheckSeq) return null; // hasil basi (user sudah mengetik kode lain)
  const editingId = $('#add-id').value;
  if (editingId && item.id === parseInt(editingId, 10)) return null; // kode milik sendiri
  fdDupItem = item;
  warnEl.innerHTML = '⚠️ Kode FD sudah dipakai: <b>' + esc(item.name) + '</b> — stok ' + fmt(item.stock) + ', rak ' + esc(item.rack || '-') + '. Kalau ini barang yang sama, pakai \'Ubah data\' atau impor Excel (mode update), jangan tambah baru.';
  warnEl.classList.remove('hidden');
  return item;
}
$('#add-fd').addEventListener('input', () => {
  clearTimeout(fdCheckTimer);
  fdCheckTimer = setTimeout(() => { checkFdDuplicate(); }, 400);
});
$('#add-fd').addEventListener('blur', () => {
  clearTimeout(fdCheckTimer);
  checkFdDuplicate();
});
$('#add-name').addEventListener('input', (e) => {
  const pos = e.target.selectionStart;
  e.target.value = e.target.value.toUpperCase();
  try { e.target.setSelectionRange(pos, pos); } catch (_) {}
});
$('#btn-cancel-add').addEventListener('click', () => showView(detailBack === 'detail' ? 'inventory' : (detailId ? 'detail' : 'inventory')));
$('#btn-photo-remove').addEventListener('click', () => {
  addPhotoData = '';
  $('#add-photo-preview').classList.add('hidden');
  $('#add-photo-preview').src = '';
  $('#btn-photo-remove').classList.add('hidden');
});

async function handlePhotoFile(file) {
  const errEl = $('#photo-error');
  errEl.classList.add('hidden');
  if (!file) return;
  if (!file.type.startsWith('image/')) { errEl.textContent = 'File harus berupa gambar.'; errEl.classList.remove('hidden'); return; }
  try {
    const dataUrl = await downscaleImage(file);
    addPhotoData = dataUrl;
    const img = $('#add-photo-preview');
    img.src = dataUrl; img.classList.remove('hidden');
    $('#btn-photo-remove').classList.remove('hidden');
  } catch (e) {
    errEl.textContent = 'Foto gagal diproses (' + e.message + '). Coba foto langsung dari kamera, bukan dari galeri.';
    errEl.classList.remove('hidden');
  }
}
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 1024;
        let w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, MAX / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        let q = 0.82, out = canvas.toDataURL('image/jpeg', q);
        while (out.length > 650000 && q > 0.4) { q -= 0.12; out = canvas.toDataURL('image/jpeg', q); }
        if (out.length > 1500000) { reject(new Error('foto terlalu besar setelah dikompres')); return; }
        resolve(out);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('file gambar tidak bisa dibaca')); };
    img.src = url;
  });
}
$('#add-photo-camera').addEventListener('change', (e) => handlePhotoFile(e.target.files[0]));
$('#add-photo-gallery').addEventListener('change', (e) => handlePhotoFile(e.target.files[0]));

$('#form-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  // cek duplikat segar sebelum simpan (jaga-jaga bila user mengetik lalu langsung Simpan)
  const dup = await checkFdDuplicate();
  if (dup) {
    const code = $('#add-fd').value.trim();
    const msg = $('#add-id').value
      ? 'Kode FD ' + code + ' sudah dipakai oleh ' + dup.name + '. Tetap simpan perubahan ini?'
      : 'Kode FD ' + code + ' sudah dipakai oleh ' + dup.name + '. Tetap simpan sebagai barang baru?';
    if (!confirm(msg)) return;
  }
  const btn = $('#btn-save-item');
  btn.disabled = true; btn.textContent = 'Menyimpan…';
  const id = $('#add-id').value;
  const body = {
    name: $('#add-name').value, fd_code: $('#add-fd').value, barcode: $('#add-barcode').value,
    stock: $('#add-stock').value, unit: $('#add-unit').value, rack: $('#add-rack').value,
    shelf: $('#add-shelf').value, jolly_box: $('#add-box').value,
    category: $('#add-category').value, notes: $('#add-notes').value,
    photo: addPhotoData || undefined,
  };
  try {
    if (id) { await apiJSON('/api/items/' + id, body, 'PUT'); toast('Perubahan tersimpan.'); }
    else { await apiJSON('/api/items', body); toast('Sparepart berhasil ditambahkan.'); }
    resetAddForm();
    showView('inventory');
  } catch (err) { toast(err.message); }
  btn.disabled = false; btn.textContent = '💾 Simpan sparepart';
});

// ---------- detail barang / kartu stok ----------
async function openDetail(id, back) {
  detailId = id; detailBack = back || 'inventory';
  showView('detail');
  const box = $('#detail-content');
  box.innerHTML = '<p class="muted">Memuat…</p>';
  try {
    const r = await api('/api/items/' + id);
    const it = r.item;
    let html = '<div class="card">';
    if (it.photo) html += '<img class="detail-photo" src="' + it.photo + '" alt="Foto ' + esc(it.name) + '">';
    html += '<h2 style="margin-top:0">' + esc(it.name) + '</h2>'
      + '<dl class="kv">'
      + '<dt>Kode FD</dt><dd>' + esc(it.fd_code || '-') + '</dd>'
      + '<dt>Barcode</dt><dd>' + esc(it.barcode || '-') + '</dd>'
      + '<dt>Stok</dt><dd><b>' + fmt(it.stock) + ' ' + esc(it.unit) + '</b>' + (it.stock <= 0 ? ' <span class="badge red">Habis</span>' : it.stock <= 5 ? ' <span class="badge">Menipis</span>' : '') + '</dd>'
      + '<dt>No rak</dt><dd>' + esc(it.rack || '-') + '</dd>'
      + '<dt>Shaf</dt><dd>' + esc(it.shelf || '-') + '</dd>'
      + '<dt>Jolly box</dt><dd>' + esc(it.jolly_box || '-') + '</dd>'
      + '<dt>Kategori</dt><dd>' + esc(it.category || '-') + '</dd>'
      + '<dt>Catatan</dt><dd>' + esc(it.notes || '-') + '</dd>'
      + '</dl>'
      + '<p><a class="btn" href="/api/items/' + it.id + '/export">⬇ Ekspor Excel kartu stok</a> '
      + '<button class="btn" id="btn-take-this">📤 Ambil barang ini</button></p>';
    // QR code barang — isinya Kode FD (atau barcode bila tanpa Kode FD); scan di tab Ambil langsung memilih barang ini
    const qrCode = it.fd_code || it.barcode || '';
    if (qrCode) {
      html += '<div class="card qr-box"><h3>QR Code</h3>'
        + '<img class="qr-img" src="/api/items/' + it.id + '/qr" alt="QR ' + esc(qrCode) + '">'
        + '<p><b>' + esc(it.name) + '</b><br><span class="muted">' + esc(qrCode) + '</span></p>'
        + '<p><a class="btn" href="/api/items/' + it.id + '/qr" download="qr-' + esc(qrCode) + '.png">⬇ Unduh PNG</a> '
        + (IS_ADMIN ? '<button class="btn" id="btn-print-qr-one">🖨 Cetak</button>' : '') + '</p>'
        + '<p class="muted small">Scan QR ini di tab Ambil untuk langsung memilih barang.</p></div>';
    } else {
      html += '<div class="card qr-box"><h3>QR Code</h3>'
        + '<p class="error small">Barang ini belum punya Kode FD / barcode, jadi QR belum bisa dibuat. Tambahkan Kode FD dulu lewat "Ubah data".</p></div>';
    }
    if (IS_ADMIN) {
      html += '<p><button class="btn" id="btn-edit-item">✏️ Ubah data</button> '
        + '<button class="btn" id="btn-adjust-item">🔧 Atur stok</button> '
        + '<button class="btn btn-danger" id="btn-del-item">🗑 Hapus</button></p>'
        + '<div id="adjust-box" class="hidden"><div class="grid2">'
        + '<label>Jumlah <input type="number" id="adj-qty" min="1" value="1"></label>'
        + '<label>Jenis <select id="adj-kind"><option value="in">Masuk</option><option value="out">Keluar</option></select></label>'
        + '</div><label>Keterangan <input id="adj-note" placeholder="cth: Opname"></label>'
        + '<button class="btn btn-primary" id="btn-adjust-save">Simpan penyesuaian</button></div>';
    }
    html += '</div>';
    // Kartu YOI / MOI — rata-rata pemakaian dari history pengambilan
    const u = it.usage;
    html += '<div class="card"><h3>📊 Pemakaian — YOI / MOI</h3>';
    if (!u || !u.hasHistory) {
      html += '<p class="muted">Belum ada data pemakaian — MOI dan YOI belum bisa dihitung. Catat pengambilan dulu lewat menu Ambil.</p>';
    } else {
      html += '<dl class="kv">'
        + '<dt>MOI</dt><dd><b>' + fmtMoi(u.moi) + '</b></dd>'
        + '<dt>YOI</dt><dd><b>' + fmtYoi(u.yoi) + '</b></dd>'
        + '<dt>Rata-rata pakai</dt><dd>' + fmt(u.avgPerMonth) + ' / bulan — total ' + fmt(u.totalOut) + ' dipakai sejak ' + fmtDateID(u.firstDate) + ' (' + fmt(u.months) + ' bulan)</dd>'
        + '</dl>';
    }
    html += '<p class="muted small">MOI = stok / rata-rata pakai per bulan (berapa bulan stok akan habis); YOI = stok / rata-rata pakai per tahun. Rata-rata dihitung dari total pengambilan dibagi jumlah bulan sejak pertama kali dipakai (1 bulan = 30 hari, minimal 1 bulan).</p></div>';
    html += '<h3>Kartu Stok</h3>';
    if (!r.card.length) html += '<p class="muted">Belum ada pergerakan.</p>';
    for (const day of r.card) {
      html += '<div class="day-group card"><h4>' + fmtDateID(day.date) + ' — Sisa akhir hari: <b>' + fmt(day.endBalance) + '</b></h4>'
        + '<table><thead><tr><th>Keterangan</th><th class="num">Masuk</th><th class="num">Keluar</th><th class="num">Sisa</th></tr></thead><tbody>';
      for (const m of day.rows) {
        const ket = esc(m.note || (m.kind === 'in' ? 'Stok masuk' : 'Pengambilan'))
          + (m.machine ? ' • ' + esc(m.machine) : '') + (m.taken_by ? ' • ' + esc(m.taken_by) : '');
        html += '<tr><td>' + ket + '</td><td class="num">' + (m.kind === 'in' ? fmt(m.qty) : '') + '</td>'
          + '<td class="num">' + (m.kind === 'out' ? fmt(m.qty) : '') + '</td><td class="num">' + fmt(m.balance) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    box.innerHTML = html;
    $('#btn-take-this').addEventListener('click', () => {
      $('#take-code').value = it.fd_code || it.barcode || '';
      showView('take');
      lookupTake();
    });
    const btnQrOne = $('#btn-print-qr-one');
    if (btnQrOne) btnQrOne.addEventListener('click', () => printQrCodes(
      [{ id: it.id, name: it.name, fd_code: it.fd_code, barcode: it.barcode }], 'QR Code — ' + it.name));
    if (IS_ADMIN) {
      $('#btn-edit-item').addEventListener('click', () => fillEditForm(it));
      $('#btn-del-item').addEventListener('click', async () => {
        if (!confirm('Hapus "' + it.name + '" beserta seluruh riwayatnya?')) return;
        try { await apiJSON('/api/items/' + it.id, undefined, 'DELETE'); toast('Barang dihapus.'); showView('inventory'); }
        catch (err) { toast(err.message); }
      });
      $('#btn-adjust-item').addEventListener('click', () => $('#adjust-box').classList.toggle('hidden'));
      $('#btn-adjust-save').addEventListener('click', async () => {
        try {
          const res = await apiJSON('/api/items/' + it.id + '/adjust', { qty: $('#adj-qty').value, kind: $('#adj-kind').value, note: $('#adj-note').value });
          toast('Stok sekarang: ' + fmt(res.balance));
          openDetail(it.id, detailBack);
        } catch (err) { toast(err.message); }
      });
    }
  } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}
$('#btn-back-detail').addEventListener('click', () => {
  const back = ['dashboard', 'inventory', 'take', 'loan', 'history', 'photo-search'].includes(detailBack) ? detailBack : 'inventory';
  showView(back);
});
function fillEditForm(it) {
  resetAddForm();
  $('#add-title').textContent = 'Ubah Sparepart';
  $('#add-id').value = it.id;
  $('#add-name').value = it.name;
  $('#add-fd').value = it.fd_code || '';
  $('#add-barcode').value = it.barcode || '';
  $('#add-stock').value = it.stock;
  $('#add-unit').value = it.unit || 'PCS';
  $('#add-rack').value = it.rack || '';
  $('#add-shelf').value = it.shelf || '';
  $('#add-box').value = it.jolly_box || '';
  $('#add-category').value = it.category || '';
  $('#add-notes').value = it.notes || '';
  if (it.photo) {
    addPhotoData = it.photo;
    const img = $('#add-photo-preview');
    img.src = it.photo; img.classList.remove('hidden');
    $('#btn-photo-remove').classList.remove('hidden');
  }
  showView('add');
}

// ---------- cari pakai foto ----------
let queryPhotoData = '';
async function loadPhotoSearchNote() {
  try {
    const s = await api('/api/stats');
    $('#photo-search-note').textContent = s.withPhoto > 0
      ? '📷 ' + fmt(s.withPhoto) + ' dari ' + fmt(s.items) + ' barang punya foto dan bisa ditemukan lewat cara ini.'
      : 'Belum ada barang yang punya foto — tambahkan foto pada barang dulu supaya bisa dicari lewat cara ini.';
  } catch (e) { /* diam */ }
}
$('#btn-photo-search-inv').addEventListener('click', () => showView('photo-search'));
$('#btn-back-photo-search').addEventListener('click', () => showView('dashboard'));

async function handleQueryPhotoFile(file) {
  const errEl = $('#query-photo-error');
  errEl.classList.add('hidden');
  $('#btn-run-photo-search').disabled = true;
  queryPhotoData = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { errEl.textContent = 'File harus berupa gambar.'; errEl.classList.remove('hidden'); return; }
  try {
    const dataUrl = await downscaleImage(file);
    queryPhotoData = dataUrl;
    const img = $('#query-photo-preview');
    img.src = dataUrl; img.classList.remove('hidden');
    $('#btn-run-photo-search').disabled = false;
  } catch (e) {
    errEl.textContent = 'Foto gagal diproses (' + e.message + '). Coba foto langsung dari kamera, bukan dari galeri.';
    errEl.classList.remove('hidden');
  }
}
$('#query-photo-camera').addEventListener('change', (e) => handleQueryPhotoFile(e.target.files[0]));
$('#query-photo-gallery').addEventListener('change', (e) => handleQueryPhotoFile(e.target.files[0]));

$('#btn-run-photo-search').addEventListener('click', async () => {
  if (!queryPhotoData) { toast('Foto barangnya dulu.'); return; }
  const box = $('#photo-results');
  const btn = $('#btn-run-photo-search');
  btn.disabled = true; btn.textContent = 'Mencari…';
  box.innerHTML = '<p class="muted">Membandingkan foto dengan barang yang tersimpan…</p>';
  try {
    const r = await apiJSON('/api/search/photo', { photo: queryPhotoData });
    if (!r.results.length) {
      box.innerHTML = r.withPhoto === 0
        ? '<p class="error">Belum ada barang yang punya foto, jadi belum ada yang bisa dicari lewat foto. Tambahkan foto pada barang dulu lewat "Ubah data".</p>'
        : '<p class="error">Tidak ada barang yang mirip — coba foto lebih dekat dengan cahaya yang terang.</p>';
      return;
    }
    const pct = (s) => Math.round(s * 100) + '%';
    const simClass = (s) => (s >= 0.8 ? 'sim-high' : s >= 0.6 ? 'sim-mid' : 'sim-low');
    let html = '';
    if (!r.hasMatch) {
      html += '<p class="error">Tidak ada barang yang mirip — coba foto lebih dekat dengan cahaya yang terang. Di bawah ini 3 yang paling mendekati:</p>';
    } else {
      html += '<p>Barang yang paling mirip, diurutkan dari yang paling cocok:</p>';
    }
    const shown = r.hasMatch ? r.results : r.results.slice(0, 3);
    html += '<div class="list">' + shown.map((it) => `
      <button class="row" data-item="${it.id}">
        <img class="thumb" src="/api/items/${it.id}/photo" alt="Foto ${esc(it.name)}" onerror="this.style.display='none'">
        <span class="r-stock">${fmt(it.stock)} <small>${esc(it.unit)}</small></span>
        <span class="r-name">${esc(it.name)}</span>
        <div class="r-sub">${esc(it.fd_code || '')} • Kemiripan <span class="sim-badge ${simClass(it.score)}">${pct(it.score)} — ${esc(it.label)}</span></div>
      </button>`).join('') + '</div>';
    if (r.pendingBackfill > 0) html += '<p class="muted small">Catatan: ' + fmt(r.pendingBackfill) + ' foto lama masih dihitung sidiknya — cari sekali lagi bila barang yang dicari belum muncul.</p>';
    box.innerHTML = html;
    box.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => openDetail(+b.dataset.item, 'photo-search')));
  } catch (e) {
    box.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
  btn.disabled = false; btn.textContent = '🔍 Cari barang yang mirip';
});

// ---------- ambil ----------
async function lookupTake() {
  const code = $('#take-code').value.trim();
  const errEl = $('#take-error');
  errEl.classList.add('hidden');
  $('#take-item').classList.add('hidden');
  $('#take-fields').classList.add('hidden');
  takeItem = null;
  if (!code) return;
  try {
    const r = await api('/api/items/lookup?code=' + encodeURIComponent(code));
    takeItem = r.item;
    $('#take-item').innerHTML = '<div class="row"><span class="r-stock">' + fmt(r.item.stock) + ' <small>' + esc(r.item.unit) + '</small></span>'
      + '<span class="r-name">' + esc(r.item.name) + '</span>'
      + '<div class="r-sub">' + esc(r.item.fd_code || '') + ' • Rak ' + esc(r.item.rack || '-') + ' • Shaf ' + esc(r.item.shelf || '-') + ' • Box ' + esc(r.item.jolly_box || '-') + '</div></div>';
    $('#take-item').classList.remove('hidden');
    $('#take-fields').classList.remove('hidden');
    $('#take-qty').focus();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}
$('#take-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookupTake(); } });
$('#take-code').addEventListener('change', lookupTake);
$('#btn-save-take').addEventListener('click', async () => {
  if (!takeItem) { toast('Pilih barang dulu (ketik Kode FD / barcode).'); return; }
  const btn = $('#btn-save-take');
  btn.disabled = true;
  try {
    const r = await apiJSON('/api/take', { itemId: takeItem.id, qty: $('#take-qty').value, machine: $('#take-machine').value, takenBy: $('#take-by').value });
    toast('Pengambilan tersimpan. Stok "' + r.name + '" sisa ' + fmt(r.balance) + '.');
    $('#take-code').value = ''; $('#take-qty').value = '1'; $('#take-machine').value = ''; $('#take-by').value = '';
    $('#take-item').classList.add('hidden'); $('#take-fields').classList.add('hidden');
    takeItem = null;
    loadTakeRecent();
  } catch (e) { toast(e.message); }
  btn.disabled = false;
});
async function loadTakeRecent() {
  try {
    const r = await api('/api/takes/recent');
    const list = $('#take-recent');
    if (!r.takes.length) { list.innerHTML = '<p class="muted">Belum ada pengambilan.</p>'; return; }
    list.innerHTML = r.takes.map((m) => `
      <button class="row" data-item="${m.item_id}">
        <span class="r-stock">−${fmt(m.qty)}</span>
        <span class="r-name">${esc(m.item_name)}</span>
        <div class="r-sub">${esc(m.fd_code || '')} • ${esc(m.machine || '-')} • ${esc(m.taken_by || '-')} • ${fmtDateID(m.date)} ${timeOf(m.created_at)}</div>
      </button>`).join('');
    list.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => openDetail(+b.dataset.item, 'take')));
  } catch (e) { /* diam */ }
}

// tanggal+jam ISO (UTC) -> tanggal lokal id-ID, cth: 27/11/2026 14:05
function fmtDateTimeLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return fmtDateID(localDate(d)) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ---------- peminjaman tools ----------
let loanItem = null;
let loanFilter = 'all';
let returnLoanId = null;
let returnPhotoData = '';

function loanBadge(l) {
  if (l.status === 'dikembalikan') return '<span class="badge green">✅ Dikembalikan</span>';
  if (l.overdue) return '<span class="badge red">⚠️ Terlambat' + (l.overdue_days >= 1 ? ' ' + fmt(l.overdue_days) + ' hari' : '') + '</span>';
  return '<span class="badge">Dipinjam</span>';
}
function loanRowHtml(l, withReturnBtn) {
  let sub = esc(l.fd_code || '') + ' • Dipinjam ' + fmtDateTimeLocal(l.borrowed_at) + ' • Jatuh tempo ' + fmtDateTimeLocal(l.due_at) + ' • Oleh ' + esc(l.borrowed_by || '-');
  if (l.status === 'dikembalikan') {
    sub += '<br>Dikembalikan ' + fmtDateTimeLocal(l.returned_at) + ' • Oleh ' + esc(l.returned_by || '-');
  }
  let photoHtml = '';
  if (l.status === 'dikembalikan' && l.hasReturnPhoto) {
    photoHtml = '<a href="/api/loans/' + l.id + '/return-photo" target="_blank" rel="noopener"><img class="thumb" src="/api/loans/' + l.id + '/return-photo" alt="Bukti pengembalian" loading="lazy"></a>';
  }
  const btn = withReturnBtn && l.status === 'dipinjam'
    ? ' <button class="btn btn-small btn-primary" data-return="' + l.id + '" data-name="' + esc(l.item_name) + '">✅ Kembalikan</button>' : '';
  return '<div class="row" data-item="' + l.item_id + '">' + photoHtml
    + '<span class="r-stock">−' + fmt(l.qty) + '</span>'
    + '<span class="r-name">' + esc(l.item_name) + ' ' + loanBadge(l) + '</span>'
    + '<div class="r-sub">' + esc(l.borrower) + ' • ' + sub + btn + '</div></div>';
}
function bindLoanRows(box) {
  box.querySelectorAll('[data-item]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('[data-return]') || e.target.closest('a')) return;
    openDetail(+el.dataset.item, 'loan');
  }));
  box.querySelectorAll('[data-return]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openReturn(+b.dataset.return, b.dataset.name);
  }));
}

async function lookupLoan() {
  const code = $('#loan-code').value.trim();
  const errEl = $('#loan-error');
  errEl.classList.add('hidden');
  $('#loan-item').classList.add('hidden');
  $('#loan-fields').classList.add('hidden');
  loanItem = null;
  if (!code) return;
  try {
    const r = await api('/api/items/lookup?code=' + encodeURIComponent(code));
    loanItem = r.item;
    $('#loan-item').innerHTML = '<div class="row"><span class="r-stock">' + fmt(r.item.stock) + ' <small>' + esc(r.item.unit) + '</small></span>'
      + '<span class="r-name">' + esc(r.item.name) + '</span>'
      + '<div class="r-sub">' + esc(r.item.fd_code || '') + ' • Rak ' + esc(r.item.rack || '-') + ' • Shaf ' + esc(r.item.shelf || '-') + ' • Box ' + esc(r.item.jolly_box || '-') + '</div></div>';
    $('#loan-item').classList.remove('hidden');
    $('#loan-fields').classList.remove('hidden');
    $('#loan-qty').focus();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}
$('#loan-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookupLoan(); } });
$('#loan-code').addEventListener('change', lookupLoan);
$('#btn-save-loan').addEventListener('click', async () => {
  if (!loanItem) { toast('Pilih barang dulu (ketik Kode FD / barcode).'); return; }
  const btn = $('#btn-save-loan');
  btn.disabled = true;
  try {
    const r = await apiJSON('/api/loans', { itemId: loanItem.id, qty: $('#loan-qty').value, borrower: $('#loan-borrower').value });
    toast('Peminjaman tersimpan. Stok "' + r.loan.item_name + '" sisa ' + fmt(r.balance) + '. Jatuh tempo ' + fmtDateTimeLocal(r.loan.due_at) + '.');
    $('#loan-code').value = ''; $('#loan-qty').value = '1'; $('#loan-borrower').value = '';
    $('#loan-item').classList.add('hidden'); $('#loan-fields').classList.add('hidden');
    loanItem = null;
    loadLoans();
    loadLoanAlert();
  } catch (e) { toast(e.message); }
  btn.disabled = false;
});

async function loadLoans() {
  const alertBox = $('#loan-alert');
  alertBox.classList.add('hidden');
  try {
    const r = await api('/api/loans?status=terlambat');
    if (r.overdueCount) {
      const lines = r.loans.map((l) => esc(l.item_name) + ' — ' + esc(l.borrower) + ' • terlambat ' + fmt(l.overdue_days) + ' hari (jatuh tempo ' + fmtDateTimeLocal(l.due_at) + ')').join('<br>');
      alertBox.innerHTML = '⚠️ Ada <b>' + fmt(r.overdueCount) + ' peminjaman</b> sudah lewat 2 hari belum dikembalikan:<br>' + lines;
      alertBox.classList.remove('hidden');
    }
  } catch (e) { /* diam */ }
  const activeBox = $('#loan-active');
  activeBox.innerHTML = '<p class="muted">Memuat…</p>';
  try {
    const r = await api('/api/loans?status=dipinjam');
    if (!r.loans.length) { activeBox.innerHTML = '<p class="muted">Tidak ada pinjaman aktif.</p>'; }
    else {
      activeBox.innerHTML = r.loans.map((l) => loanRowHtml(l, true)).join('');
      bindLoanRows(activeBox);
    }
  } catch (e) { activeBox.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
  loadLoanHistory();
}
async function loadLoanHistory() {
  const box = $('#loan-list');
  box.innerHTML = '<p class="muted">Memuat…</p>';
  try {
    const r = await api('/api/loans?status=' + loanFilter);
    if (!r.loans.length) { box.innerHTML = '<p class="muted">Belum ada peminjaman.</p>'; return; }
    box.innerHTML = r.loans.map((l) => loanRowHtml(l, false)).join('');
    bindLoanRows(box);
  } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}
$('#loan-filter').addEventListener('change', (e) => { loanFilter = e.target.value; loadLoanHistory(); });

function openReturn(loanId, name) {
  returnLoanId = loanId;
  returnPhotoData = '';
  $('#return-loan-name').textContent = name;
  $('#return-photo-preview').classList.add('hidden');
  $('#return-photo-preview').src = '';
  $('#btn-return-photo-remove').classList.add('hidden');
  $('#return-photo-error').classList.add('hidden');
  $('#btn-save-return').disabled = true;
  $('#return-box').classList.remove('hidden');
  $('#return-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#btn-cancel-return').addEventListener('click', () => {
  returnLoanId = null; returnPhotoData = '';
  $('#return-box').classList.add('hidden');
});
async function handleReturnPhotoFile(file) {
  const errEl = $('#return-photo-error');
  errEl.classList.add('hidden');
  $('#btn-save-return').disabled = true;
  returnPhotoData = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { errEl.textContent = 'File harus berupa gambar.'; errEl.classList.remove('hidden'); return; }
  try {
    const dataUrl = await downscaleImage(file);
    returnPhotoData = dataUrl;
    const img = $('#return-photo-preview');
    img.src = dataUrl; img.classList.remove('hidden');
    $('#btn-return-photo-remove').classList.remove('hidden');
    $('#btn-save-return').disabled = false;
  } catch (e) {
    errEl.textContent = 'Foto gagal diproses (' + e.message + '). Coba foto langsung dari kamera, bukan dari galeri.';
    errEl.classList.remove('hidden');
  }
}
$('#return-photo-camera').addEventListener('change', (e) => handleReturnPhotoFile(e.target.files[0]));
$('#return-photo-gallery').addEventListener('change', (e) => handleReturnPhotoFile(e.target.files[0]));
$('#btn-return-photo-remove').addEventListener('click', () => {
  returnPhotoData = '';
  $('#return-photo-preview').classList.add('hidden');
  $('#return-photo-preview').src = '';
  $('#btn-return-photo-remove').classList.add('hidden');
  $('#btn-save-return').disabled = true;
});
$('#btn-save-return').addEventListener('click', async () => {
  if (!returnLoanId) return;
  if (!returnPhotoData) { toast('Foto bukti pengembalian wajib diisi.'); return; }
  const btn = $('#btn-save-return');
  btn.disabled = true;
  try {
    const r = await apiJSON('/api/loans/' + returnLoanId + '/return', { photo: returnPhotoData });
    toast('Pengembalian tersimpan. Stok "' + r.loan.item_name + '" kembali menjadi ' + fmt(r.balance) + '.');
    $('#return-box').classList.add('hidden');
    returnLoanId = null; returnPhotoData = '';
    loadLoans();
    loadLoanAlert();
  } catch (e) { toast(e.message); }
  btn.disabled = false;
});

// ---------- stock opname (SO) ----------
async function lookupSo() {
  const code = $('#so-code').value.trim();
  const errEl = $('#so-error');
  errEl.classList.add('hidden');
  $('#so-item').classList.add('hidden');
  $('#so-fields').classList.add('hidden');
  soItem = null;
  if (!code) return;
  try {
    const r = await api('/api/items/lookup?code=' + encodeURIComponent(code));
    soItem = r.item;
    $('#so-item').innerHTML = '<div class="row"><span class="r-stock">' + fmt(r.item.stock) + ' <small>' + esc(r.item.unit) + '</small></span>'
      + '<span class="r-name">' + esc(r.item.name) + '</span>'
      + '<div class="r-sub">' + esc(r.item.fd_code || '') + ' • Rak ' + esc(r.item.rack || '-') + ' • Shaf ' + esc(r.item.shelf || '-') + ' • Box ' + esc(r.item.jolly_box || '-') + ' • Stok sistem: ' + fmt(r.item.stock) + '</div></div>';
    $('#so-item').classList.remove('hidden');
    $('#so-fields').classList.remove('hidden');
    $('#so-counted').focus();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}
$('#so-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookupSo(); } });
$('#so-code').addEventListener('change', lookupSo);
$('#btn-lookup-so').addEventListener('click', lookupSo);
$('#btn-scan-so').addEventListener('click', () => openScanner('so'));
$('#btn-save-so').addEventListener('click', async () => {
  if (!soItem) { toast('Pilih barang dulu (ketik Kode FD / barcode).'); return; }
  const btn = $('#btn-save-so');
  btn.disabled = true;
  try {
    const r = await apiJSON('/api/so', { itemId: soItem.id, counted: $('#so-counted').value });
    if (r.record.status === 'Sesuai') toast('SO tersimpan — jumlah sesuai dengan stok sistem.');
    else toast('SO tersimpan — selisih ' + (r.record.diff > 0 ? '+' : '') + fmt(r.record.diff) + ' dari stok sistem.');
    $('#so-code').value = ''; $('#so-counted').value = '0';
    $('#so-item').classList.add('hidden'); $('#so-fields').classList.add('hidden');
    soItem = null;
    loadSo();
  } catch (e) { toast(e.message); }
  btn.disabled = false;
});
$('#so-date').addEventListener('change', loadSo);
$('#btn-export-so').addEventListener('click', () => {
  const date = $('#so-date').value || localDate();
  const a = document.createElement('a');
  a.href = '/api/so/export?date=' + encodeURIComponent(date);
  document.body.appendChild(a);
  a.click();
  a.remove();
});
async function loadSo() {
  const date = $('#so-date').value || localDate();
  $('#so-date-label').textContent = fmtDateID(date);
  const box = $('#so-list');
  box.innerHTML = '<p class="muted">Memuat…</p>';
  try {
    const r = await api('/api/so?date=' + date);
    if (!r.records.length) { box.innerHTML = '<p class="muted">Belum ada catatan SO pada tanggal ini.</p>'; return; }
    box.innerHTML = r.records.map((rec) => {
      const diffTxt = (rec.diff > 0 ? '+' : '') + fmt(rec.diff);
      const badge = rec.status === 'Sesuai'
        ? '<span class="badge green">✅ Sesuai</span>'
        : '<span class="badge red">⚠️ Selisih</span>';
      const adjustBtn = (rec.diff !== 0 && !rec.adjusted && IS_ADMIN)
        ? ' <button class="btn btn-small" data-adjust="' + rec.id + '" data-name="' + esc(rec.item_name) + '" data-counted="' + rec.counted + '">Sesuaikan stok</button>' : '';
      const adjustedTag = rec.adjusted ? ' <span class="muted small">• Sudah disesuaikan</span>' : '';
      return '<div class="row"><span class="r-stock">' + fmt(rec.counted) + '</span>'
        + '<span class="r-name">' + esc(rec.item_name) + ' ' + badge + '</span>'
        + '<div class="r-sub">' + esc(rec.fd_code || '') + ' • Sistem ' + fmt(rec.system_stock) + ' • SO ' + fmt(rec.counted) + ' • Selisih ' + diffTxt + adjustedTag + '<br>'
        + esc(rec.username || '-') + ' • ' + timeOf(rec.created_at) + ' WIB' + adjustBtn + '</div></div>';
    }).join('');
    box.querySelectorAll('[data-adjust]').forEach((b) => b.addEventListener('click', async () => {
      const name = b.dataset.name, counted = b.dataset.counted;
      if (!confirm('Sesuaikan stok "' + name + '" menjadi ' + counted + ' sesuai hasil SO?')) return;
      try {
        const res = await apiJSON('/api/so/' + b.dataset.adjust + '/adjust', {});
        toast('Stok "' + name + '" disesuaikan menjadi ' + fmt(res.balance) + '.');
        loadSo();
      } catch (e) { toast(e.message); }
    }));
  } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}

// ---------- riwayat ----------
$('#btn-hist-clear').addEventListener('click', () => { $('#hist-date').value = ''; loadHistory(); });
$('#btn-export-history').addEventListener('click', () => {
  downloadHistoryExport($('#hist-date').value || '');
});
$('#hist-date').addEventListener('change', loadHistory);
async function loadHistory() {
  const date = $('#hist-date').value;
  const box = $('#hist-content');
  box.innerHTML = '<p class="muted">Memuat…</p>';
  try {
    const r = await api('/api/history' + (date ? '?date=' + date : ''));
    if (r.mode === 'day') {
      if (!r.rows.length) { box.innerHTML = '<p class="muted">Tidak ada pergerakan pada ' + fmtDateID(date) + '.</p>'; return; }
      let html = '<p>Total masuk: <b>' + fmt(r.totalMasuk) + '</b> • Total keluar: <b>' + fmt(r.totalKeluar) + '</b></p>';
      html += '<div class="list">' + r.rows.map((x) => `
        <button class="row" data-item="${x.item_id}">
          <span class="r-stock">${fmt(x.stok_akhir)}</span>
          <span class="r-name">${esc(x.item_name)}</span>
          <div class="r-sub">Masuk ${fmt(x.masuk)} • Keluar ${fmt(x.keluar)} • Stok akhir hari ${fmt(x.stok_akhir)}</div>
        </button>`).join('') + '</div>';
      box.innerHTML = html;
      box.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => openDetail(+b.dataset.item, 'history')));
    } else {
      if (!r.rows.length) { box.innerHTML = '<p class="muted">Belum ada pergerakan.</p>'; return; }
      box.innerHTML = '<div class="list">' + r.rows.map((m) => `
        <button class="row" data-item="${m.item_id}">
          <span class="r-stock">${m.kind === 'in' ? '+' : '−'}${fmt(m.qty)}</span>
          <span class="r-name">${esc(m.item_name)}</span>
          <div class="r-sub">${esc(m.note || (m.kind === 'in' ? 'Stok masuk' : 'Pengambilan'))} • ${esc(m.machine || '')} ${esc(m.taken_by || '')} • ${fmtDateID(m.date)} ${timeOf(m.created_at)} • Sisa ${fmt(m.balance)}</div>
        </button>`).join('') + '</div>';
      box.querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => openDetail(+b.dataset.item, 'history')));
    }
  } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}

// ---------- impor Excel ----------
$('#btn-open-import').addEventListener('click', () => {
  if (!IS_ADMIN) { toast('Hanya Admin yang boleh mengimpor Excel.'); return; }
  $('#import-panel').classList.toggle('hidden');
});
$('#btn-import-cancel').addEventListener('click', () => $('#import-panel').classList.add('hidden'));
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#import-sheets').classList.add('hidden');
  $('#import-preview').classList.add('hidden');
  $('#import-progress').classList.add('hidden');
  $('#import-report').classList.add('hidden');
  try {
    const buf = await file.arrayBuffer();
    const r = await fetch('/api/import/upload?filename=' + encodeURIComponent(file.name), {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    importJobId = j.jobId;
    const sel = $('#import-sheet');
    sel.innerHTML = j.sheets.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (${s.rows} baris)</option>`).join('');
    importSheet = j.sheets[0].name;
    $('#import-sheets').classList.remove('hidden');
  } catch (err) { toast(err.message); }
});
$('#import-sheet').addEventListener('change', (e) => { importSheet = e.target.value; });
$('#btn-import-preview').addEventListener('click', async () => {
  try {
    const r = await apiJSON('/api/import/preview', { jobId: importJobId, sheet: importSheet });
    const p = $('#import-preview');
    p.innerHTML = '<h4>Preview — ' + esc(importSheet) + '</h4>'
      + '<p>Total baris: <b>' + fmt(r.total) + '</b> • Valid: <b>' + fmt(r.valid) + '</b> • Tidak valid: <b>' + fmt(r.invalid) + '</b> • Kosong: <b>' + fmt(r.empty) + '</b> • Duplikat Kode FD sudah ada: <b>' + fmt(r.duplicates) + '</b></p>'
      + (r.invalidSample.length ? '<p class="error">Contoh baris tidak valid: ' + r.invalidSample.map((x) => esc(x.error || 'tanpa nama')).join(', ') + '</p>' : '')
      + '<p>Duplikat Kode FD: <label><input type="radio" name="dup-mode" value="skip" checked> Lewati (dengan laporan)</label> '
      + '<label><input type="radio" name="dup-mode" value="update"> Update stok (mode opname, tercatat di history)</label></p>'
      + '<button class="btn btn-primary" id="btn-import-run">▶ Mulai impor ' + fmt(r.valid) + ' baris</button>';
    p.classList.remove('hidden');
    $('#btn-import-run').addEventListener('click', runImport);
  } catch (err) { toast(err.message); }
});
async function runImport() {
  const mode = (document.querySelector('input[name="dup-mode"]:checked') || {}).value || 'skip';
  $('#import-progress').classList.remove('hidden');
  $('#import-report').classList.add('hidden');
  let offset = 0, total = 0, ins = 0, upd = 0, skip = 0;
  try {
    for (;;) {
      const r = await apiJSON('/api/import/batch', { jobId: importJobId, mode, offset });
      total = r.total; ins += r.inserted; upd += r.updated; skip += r.skipped;
      offset = r.processed;
      const pct = total ? Math.round((offset / total) * 100) : 100;
      $('#import-bar').style.width = pct + '%';
      $('#import-status').textContent = 'Memproses ' + fmt(offset) + ' / ' + fmt(total) + ' baris…';
      if (r.done) break;
    }
    $('#import-status').textContent = 'Selesai.';
    const rep = $('#import-report');
    rep.innerHTML = '<p><b>Impor selesai.</b> Baru ditambahkan: <b>' + fmt(ins) + '</b> • Stok di-update: <b>' + fmt(upd) + '</b> • Dilewati: <b>' + fmt(skip) + '</b> (duplikat/tidak valid).</p>';
    rep.classList.remove('hidden');
    toast('Impor selesai: ' + fmt(ins) + ' baru, ' + fmt(upd) + ' update.');
    loadInventory();
  } catch (err) { toast(err.message); }
}

// ---------- akun ----------
async function loadAccount() {
  $('#acc-name').textContent = ME.username;
  $('#acc-role').textContent = IS_ADMIN ? 'Admin' : 'User';
  $('#acc-desc').textContent = IS_ADMIN
    ? 'Akses penuh — tambah, ubah & hapus sparepart, atur stok, impor Excel, kelola peminjaman tools, dan kelola akun User.'
    : 'Hanya melihat stok, mencari, mencatat pengambilan, dan meminjam tools. Tidak bisa tambah, ubah, hapus, atau impor.';
  $('#admin-users-card').classList.toggle('hidden', !IS_ADMIN);
  if (IS_ADMIN) loadUsers();
  if (!deferredPrompt) $('#install-guide').classList.remove('hidden');
}
async function loadUsers() {
  try {
    const r = await api('/api/accounts');
    $('#user-list').innerHTML = r.accounts.map((a) => `
      <div class="row"><b>${esc(a.username)}</b> — ${a.role === 'admin' ? 'Admin' : 'User'}
        <span style="float:right">${a.role === 'admin' ? '' : `<button class="btn btn-small" data-reset="${a.id}">Ganti password</button> <button class="btn btn-small btn-danger" data-del="${a.id}">Hapus</button>`}</span>
      </div>`).join('');
    $$('#user-list [data-reset]').forEach((b) => b.addEventListener('click', async () => {
      const pw = prompt('Password baru untuk akun ini (minimal 4 karakter):');
      if (!pw) return;
      try { await apiJSON('/api/accounts/' + b.dataset.reset + '/password', { password: pw }); toast('Password diganti.'); }
      catch (e) { toast(e.message); }
    }));
    $$('#user-list [data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Hapus akun ini?')) return;
      try { await apiJSON('/api/accounts/' + b.dataset.del, undefined, 'DELETE'); toast('Akun dihapus.'); loadUsers(); }
      catch (e) { toast(e.message); }
    }));
  } catch (e) { $('#user-list').innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}
$('#btn-create-user').addEventListener('click', async () => {
  const username = $('#new-user-name').value.trim();
  const password = $('#new-user-pw').value;
  try {
    await apiJSON('/api/accounts', { username, password, role: 'user' });
    toast('Akun User "' + username + '" dibuat.');
    $('#new-user-name').value = ''; $('#new-user-pw').value = '';
    loadUsers();
  } catch (e) { toast(e.message); }
});
$('#btn-install').addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === 'accepted') toast('Aplikasi dipasang.');
    deferredPrompt = null;
  } else {
    $('#install-guide').classList.remove('hidden');
    toast('Ikuti panduan di bawah ini.');
  }
});

// ---------- scanner barcode ----------
// Mesin pemindai: utamakan BarcodeDetector (Chrome Android), fallback ke
// ZXing (@zxing/browser, JavaScript murni) bila BarcodeDetector tidak ada.
// Bila kamera tidak bisa dibuka, tampilkan panel error yang jelas — jangan
// hanya toast yang hilang dalam beberapa detik.
let scanStream = null, scanTarget = 'take', scanZxingControls = null;
function scannerError(title, msg) {
  $('#scanner-error-title').textContent = title;
  $('#scanner-error-msg').textContent = msg;
  $('#scanner-view').classList.add('hidden');
  $('#scanner-status').classList.add('hidden');
  $('#scanner-error').classList.remove('hidden');
  $('#scanner').classList.remove('hidden');
}
function scannerErrorForCamera(e) {
  const name = (e && e.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Izin kamera ditolak atau diblokir. Ketuk ikon gembok di address bar, ubah Kamera menjadi "Izinkan", lalu coba scan lagi.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'Tidak ada kamera yang ditemukan di perangkat ini. Coba di HP lain, atau ketik kodenya manual.';
  if (name === 'NotReadableError')
    return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi lain yang memakai kamera, lalu coba lagi.';
  return 'Kamera tidak bisa dibuka (' + (e && e.message ? e.message : 'kesalahan tidak diketahui') + '). Pastikan memakai Chrome terbaru dan halaman dibuka lewat HTTPS atau localhost.';
}
async function openScanner(target) {
  scanTarget = target;
  $('#scanner-error').classList.add('hidden');
  $('#scanner-view').classList.remove('hidden');
  $('#scanner-status').classList.remove('hidden');
  $('#scanner-status').textContent = 'Membuka kamera…';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    scannerError('Kamera tidak tersedia', 'Browser ini tidak bisa mengakses kamera. Pakai Chrome terbaru di Android, atau ketik kodenya manual.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    scannerError('Kamera tidak bisa dibuka', scannerErrorForCamera(e));
    return;
  }
  scanStream = stream;
  const useBarcodeDetector = ('BarcodeDetector' in window);
  const useZxing = !useBarcodeDetector && window.ZXingBrowser && window.ZXingBrowser.BrowserMultiFormatReader;
  if (!useBarcodeDetector && !useZxing) {
    closeScanner();
    scannerError('Scanner tidak didukung', 'Browser ini tidak mendukung pemindai barcode bawaan maupun cadangan. Pakai Chrome terbaru di Android, atau ketik kodenya manual.');
    return;
  }
  $('#scanner').classList.remove('hidden');
  $('#scanner-status').textContent = 'Memindai… arahkan kamera ke barcode / QR code';
  const video = $('#scanner-video');
  if (useBarcodeDetector) {
    try {
      video.srcObject = scanStream;
      await video.play();
    } catch (e) { closeScanner(); scannerError('Kamera tidak bisa dibuka', scannerErrorForCamera(e)); return; }
    const detector = new BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code', 'upc_a', 'upc_e'] });
    const loop = async () => {
      if (!scanStream) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) { const code = codes[0].rawValue; closeScanner(); applyScan(code); return; }
      } catch (_) {}
      requestAnimationFrame(loop);
    };
    loop();
  } else {
    // Fallback ZXing: decode dari stream kamera yang sama
    try {
      const reader = new ZXingBrowser.BrowserMultiFormatReader();
      scanZxingControls = await reader.decodeFromStream(scanStream, video, (result) => {
        if (result) { const code = result.getText(); closeScanner(); applyScan(code); }
      });
    } catch (e) {
      closeScanner();
      scannerError('Scanner gagal dimulai', 'Pemindai cadangan gagal dimulai (' + (e && e.message ? e.message : 'kesalahan tidak diketahui') + '). Coba tutup lalu scan lagi, atau ketik kodenya manual.');
    }
  }
}
function closeScanner() {
  if (scanZxingControls) { try { const c = scanZxingControls; scanZxingControls = null; c.stop(); } catch (_) {} }
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  $('#scanner').classList.add('hidden');
}
async function applyScan(code) {
  if (scanTarget === 'take') { $('#take-code').value = code; showView('take'); lookupTake(); }
  else if (scanTarget === 'loan') { $('#loan-code').value = code; showView('loan'); lookupLoan(); }
  else if (scanTarget === 'so') { $('#so-code').value = code; showView('so'); lookupSo(); }
  else if (scanTarget === 'add') { $('#add-barcode').value = code; }
  else if (scanTarget === 'inv') {
    try {
      const r = await api('/api/items/lookup?code=' + encodeURIComponent(code));
      openDetail(r.item.id, 'inventory');
    } catch (e) {
      invSearch = code; invPage = 1; $('#inv-search').value = code; showView('inventory'); loadInventory();
      toast('Barang dengan kode ' + code + ' tidak ditemukan.');
    }
  }
  toast('Kode terbaca: ' + code);
}
$('#btn-scan-take').addEventListener('click', () => openScanner('take'));
$('#btn-scan-loan').addEventListener('click', () => openScanner('loan'));
$('#btn-scan-add').addEventListener('click', () => openScanner('add'));
$('#btn-scan-inv').addEventListener('click', () => openScanner('inv'));
$('#btn-scan-close').addEventListener('click', closeScanner);
$('#btn-scan-manual').addEventListener('click', () => {
  closeScanner();
  if (scanTarget === 'take') { showView('take'); $('#take-code').focus(); }
  else if (scanTarget === 'loan') { showView('loan'); $('#loan-code').focus(); }
  else if (scanTarget === 'so') { showView('so'); $('#so-code').focus(); }
  else if (scanTarget === 'add') { $('#add-barcode').focus(); }
  else { showView('inventory'); $('#inv-search').focus(); }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
boot();
