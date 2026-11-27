# Gudang Sparepart — Standalone (di luar Muse)

Rebuild mandiri aplikasi inventaris sparepart gudang sebagai web app Node.js +
SQLite. Satu file database, tanpa dependensi ke Muse. Mobile-first, UI Bahasa
Indonesia.

## Menjalankan

```bash
cd ~/workspace/gudang-sparepart-standalone
npm install          # sekali saja (express + xlsx + jimp + qrcode)
PORT=3000 node server.js
# buka http://localhost:3000
```

- `PORT` — port server (default `3000`).
- `DB_PATH` — lokasi file database (default `./data/gudang.db`).
- Database utama sudah berisi **10 barang awal** (10 baris pertama Sheet2 file
  Excel user). Akun belum ada: saat pertama kali dibuka, aplikasi meminta
  membuat password Admin untuk username **zico**.

## Struktur

```
server.js            — API + auth + impor/ekspor Excel (Express + node:sqlite)
public/
  index.html         — SPA (dashboard, inventaris, tambah, ambil, riwayat, akun, detail)
  app.js             — logika frontend
  style.css          — tema amber, navigasi atas menempel
  manifest.webmanifest + icons/ + sw.js  — PWA (install, fullscreen)
data/
  gudang.db          — database utama (10 barang awal, 0 akun)
test-suite.js        — suite uji otomatis (44 cek, melawan DB uji terpisah)
seed-main.js         — script seed DB utama (dipakai sekali, 12 cek lolos)
```

## Fitur

- **Dashboard**: ringkasan (jenis barang, total unit, stok menipis/habis, rak &
  jolly box), tanggal bisa diganti, menu Stok Sparepart All / Tambah Sparepart /
  Pemakaian, history keluar per tanggal (nama, kode FD, jumlah, mesin,
  pengambil, jam, total hari itu; ketuk baris → detail barang).
- **Navigasi atas menempel**: Dashboard, Inventaris, Ambil, Riwayat, Akun —
  selalu terlihat dari halaman mana pun.
- **Inventaris**: pagination (50/halaman), cari nama/barcode/kode FD/rak/box,
  tombol Scan di samping kolom pencarian, filter menipis (stok 1–5) / habis,
  tampilkan satuan & shaf, foto thumbnail tiap baris (placeholder
  "Belum ada foto" bila belum ada foto). MOI/YOI tidak tampil di daftar.
- **Tambah Sparepart**: foto (kamera/galeri, downscale client-side maks 1024px,
  ~500 KB, error jelas bila gagal), nama dipaksa HURUF KAPITAL, Kode FD,
  barcode + scan, stok, rak, satuan, shaf, jolly box, kategori, catatan.
- **Impor Excel (.xlsx/.csv)**: pilih sheet, deteksi header otomatis, preview
  (valid/tidak valid/kosong/duplikat), duplikat Kode FD bisa dilewati atau
  update-stok mode opname (tercatat di history), impor batch 200 baris dengan
  progress bar + laporan akhir, template kosong bisa diunduh. **Impor ulang
  tidak pernah menghapus foto.**
- **Kartu stok per barang**: pergerakan per tanggal (Keterangan, Masuk, Keluar,
  Sisa + saldo akhir hari), tombol Ekspor Excel (kolom Mesin & Diambil oleh).
- **YOI / MOI per barang**: MOI = stok / rata-rata pakai per bulan, YOI = MOI / 12.
  Rata-rata = total pengambilan dibagi jumlah bulan sejak pertama kali dipakai
  (1 bulan = 30 hari, minimal 1 bulan; koreksi opname tidak dihitung). Tampil di
  kartu detail barang (tidak lagi di daftar Inventaris); tanpa history
  pengambilan tampil "–".
- **Riwayat**: ringkasan harian per barang (masuk/keluar/stok akhir hari) atau
  60 pergerakan terakhir.
- **Ambil**: cari Kode FD/barcode (+ scan kamera), jumlah/mesin/nama pemakai,
  stok berkurang + tercatat di kartu stok, stok kurang ditolak
  ("Stok tidak cukup… sisa X, diminta Y"), daftar pengambilan terakhir.
  Scan kamera memakai BarcodeDetector bila tersedia, fallback ke ZXing
  (@zxing/browser, JavaScript murni) bila tidak; bila kamera ditolak/tidak
  tersedia tampil panel error berbahasa Indonesia dengan panduannya, bukan
  sekadar toast. Scan juga ada di kolom pencarian Inventaris (hasil scan
  langsung membuka detail barang) dan di form Tambah.
- **Cari pakai Foto**: tidak tahu nama barang? Foto barangnya lewat kamera/galeri
  — aplikasi menampilkan 5 barang paling mirip (nama, Kode FD, stok, foto,
  persen kemiripan), ketuk hasil untuk buka detail. Cara kerja: perceptual hash
  (dHash 64-bit) + histogram warna, dihitung dengan Jimp (JS murni, tanpa binary
  native); sidik dihitung sekali saat foto diunggah dan disimpan di database,
  foto lama di-backfill bertahap saat pencarian pertama dipakai (maks 25 per
  pencarian). Skor = 0,4·(1−hamming/64) + 0,6·irisan histogram; ambang "mirip"
  0,60 (foto sama persis = 1,00; foto sama di-crop/diputar ≈ 0,64; foto tak
  berhubungan ≈ 0,31–0,46). Bila tidak ada yang cukup mirip tampil pesan
  "Tidak ada barang yang mirip — coba foto lebih dekat dengan cahaya yang
  terang" plus 3 yang paling mendekati. Barang tanpa foto tidak bisa ditemukan
  lewat cara ini (diberi keterangan di layar pencarian). Semua peran yang login
  boleh mencari; tanpa login ditolak (401).
- **Login server**: PBKDF2 + sesi cookie. Admin (`zico`) membuat akun User,
  ganti/hapus password User, ganti password sendiri. User hanya boleh
  lihat/cari/ambil — tambah/ubah/hapus/atur stok/impor ditolak server (403).
  Semua akun melihat data stok yang sama.
- **PWA**: manifest (display standalone, tema amber), ikon, service worker,
  bagian "Pasang sebagai aplikasi" di menu Akun.

## Pengujian (sudah dijalankan)

- `node test-suite.js` melawan database uji terpisah (`data/test.db`):
  **44 cek lolos, 0 gagal** — login/setup, penolakan peran User (tambah/hapus/
  ubah/impor/akun → 403), impor penuh file Excel asli **1.461 baris masuk**
  (nama kapital semua, Kode FD terisi, mapping rak/shaf/box/kategori benar),
  impor ulang mode skip (0 baru), pengambilan mengurangi stok + tercatat di
  kartu stok, ambil melebihi stok ditolak, ekspor Excel kartu stok (kolom Mesin
  & Diambil oleh terisi), ubah tanpa foto tidak menghapus foto.
- Seed DB utama (`node seed-main.js`): **12 cek lolos** — 10 barang awal
  identik dengan 10 baris pertama impor penuh (satu-satunya selisih: stok
  FD013610 di DB uji = 1 karena dipakai uji pengambilan, di DB utama = 2
  sesuai file). Akun admin sementara sudah dihapus; `setupNeeded=true` lagi.
- `node test-photo.js` (server uji port 3107, DB `/tmp/photo-test.db`):
  **34 cek lolos, 0 gagal** — foto sama persis → ranking 1 skor 1,00; foto sama
  di-crop/diputar → tetap ranking 1 skor 0,644; foto tak berhubungan → hasMatch
  false (skor terbaik 0,369); backfill barang berfoto lama tanpa sidik
  (ditemukan + sidik tersimpan, pending 0); endpoint foto (200 image/jpeg,
  tanpa foto → 404); tanpa login → 401; User boleh mencari; foto tidak valid
  → 400; stats membawa withPhoto; frontend memuat view + logika photo search.
- `node test-yoi.js` (server uji port 3103, DB `/tmp/yoi-test.db`):
  **23 cek lolos, 0 gagal** — stok 12 & rata-rata 3/bln → MOI 4,0 & YOI 0,33;
  riwayat 3 bulan (9 dipakai, pertama 90 hari lalu) → MOI 4,0; tanpa history →
  "–" (moi null); stok habis → MOI 0,0; koreksi opname tidak dihitung sebagai
  pemakaian; daftar Inventaris ikut membawa usage per barang.

## Catatan hosting

- Server ini **tidak di-expose ke publik** (hanya `localhost`).
- `cloudflared` **tidak tersedia** di VM ini (`which cloudflared` kosong) —
  untuk tunnel publik nanti perlu install `cloudflared` dulu
  (`https://developers.cloudflare.com/cloudflare-one/connections/connect/downloads/`)
  atau pakai hosting lain.
