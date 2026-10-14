# P2P Share

Website kirim file langsung antar browser (peer-to-peer). File **tidak diupload ke server**, data mengalir langsung dari browser pengirim ke browser penerima lewat WebRTC.

**Tampilan Glassmorphism ala Apple**, dengan mode terang dan gelap yang otomatis mengikuti pengaturan perangkat.

**File besar (sampai GB) didukung.** Penerima menulis data langsung ke disk, bukan menumpuknya di RAM, jadi perangkat tidak terbebani. Penjelasan ada di bagian "File besar: cara kerja dan batasnya".

Semua yang dipakai gratis:

| Kebutuhan | Yang dipakai |
|---|---|
| Hosting | Vercel atau Netlify (pilih salah satu) |
| Kode | GitHub |
| P2P | WebRTC DataChannel + PeerJS (sudah disertakan di folder ini) |
| Signaling | PeerJS Cloud (server publik gratis) |
| STUN | `stun.l.google.com:19302` |
| TURN (cadangan) | Metered Open Relay (opsional, langkah 8) |

> Tidak perlu install Node.js, tidak ada build, tidak ada database. Ini hanya file statis: `index.html`, `style.css`, `app.js` (+ `writer.js`, `peerjs.min.js`, dan `qrcode.js`).

---

## Isi folder

```
p2p-share/
├── index.html      Tampilan halaman
├── style.css       Gaya Glassmorphism (otomatis terang/gelap)
├── app.js          Logika: buat room, gabung, kirim, terima
├── writer.js       Worker yang menulis file yang diterima langsung ke disk
├── peerjs.min.js   Library PeerJS 1.5.4 (disimpan lokal, tanpa CDN)
├── qrcode.js       Library pembuat QR code (qrcode-generator 1.4.4, MIT, lokal)
├── favicon.svg     Ikon tab browser (utama)
├── favicon.ico     Ikon tab untuk browser lama (16 dan 32 px)
├── apple-touch-icon.png   Ikon saat halaman ditambahkan ke layar utama iPhone/iPad
├── icon-192.png, icon-512.png, icon-maskable-512.png   Ikon aplikasi (Android, PWA)
├── site.webmanifest   Nama dan ikon aplikasi kalau dipasang ke layar utama
└── README.md       Panduan ini
```

---

## Cara pakai (dari sisi pengguna)

1. Orang A buka website, klik **Buat room**, muncul kode 6 karakter.
2. A kirim kode (atau tombol **Salin link**) ke B lewat WhatsApp.
3. B buka website dan masukkan kode, atau langsung buka link-nya.
4. Status berubah jadi **Terhubung langsung (P2P)**.
5. Salah satu pilih file. Pihak lain klik **Terima**, lalu file berpindah dan muncul tombol **Unduh**.

Kedua pihak bisa saling kirim file. Satu room untuk satu teman.

---

## Step by step

### Langkah 1: Siapkan akun dan tools

Yang dibutuhkan:

- Akun **GitHub** (github.com)
- Akun **Vercel** (vercel.com) atau **Netlify** (netlify.com). Daftar pakai akun GitHub supaya mudah
- **Git** terpasang di komputer (cek dengan `git --version`)
- Browser modern (Chrome, Edge, Firefox, Safari)

### Langkah 2: Taruh folder di komputer

Salin folder `p2p-share` ke komputer, misalnya ke `Documents/p2p-share`. Pastikan `index.html` ada langsung di dalam folder itu.

### Langkah 3: Jalankan di komputer sendiri

Buka terminal di dalam folder `p2p-share`, lalu pilih salah satu:

```bash
# Kalau punya Python
python3 -m http.server 8000

# Atau kalau punya Node.js
npx serve -l 8000
```

Buka **http://localhost:8000** di browser.

> Jangan buka `index.html` dengan klik dua kali (alamat `file://`). Pakai server lokal seperti di atas.

### Langkah 4: Tes dengan dua tab

1. Di tab pertama klik **Buat room**, catat kodenya.
2. Buka tab kedua ke `http://localhost:8000`, isi kode, klik **Gabung**.
3. Di kedua tab status harus berubah menjadi **Terhubung langsung (P2P)**.
4. Di tab pertama pilih file kecil. Di tab kedua klik **Terima**, lalu **Unduh**.
5. Coba juga file besar (misalnya 500 MB sampai 1 GB). Selama transfer buka Task Manager (Windows) atau Activity Monitor (Mac): pemakaian memori tab penerima harus tetap kecil, tidak naik sebesar ukuran file.

Kalau ini berhasil, kodenya sudah benar. Lanjut ke online.

### Langkah 5: Upload ke GitHub

1. Di github.com klik **New repository**, beri nama `p2p-share`, biarkan kosong (jangan centang README), lalu **Create repository**.
2. Di terminal, di dalam folder `p2p-share`:

```bash
git init
git add .
git commit -m "P2P Share pertama"
git branch -M main
git remote add origin https://github.com/USERNAME-KAMU/p2p-share.git
git push -u origin main
```

Ganti `USERNAME-KAMU` dengan username GitHub kamu.

### Langkah 6: Deploy (pilih salah satu)

**Opsi A: Vercel**

1. Login ke vercel.com, klik **Add New → Project**.
2. Pilih repo `p2p-share`, klik **Import**.
3. **Framework Preset**: `Other`. Kosongkan Build Command dan Output Directory.
4. Klik **Deploy**. Hasilnya alamat seperti `https://p2p-share-xxxx.vercel.app`.

Catatan: paket Vercel Hobby (gratis) ditujukan untuk pemakaian non-komersial.

**Opsi B: Netlify**

1. Login ke netlify.com, klik **Add new site → Import an existing project**.
2. Pilih GitHub, lalu repo `p2p-share`.
3. Kosongkan Build command, isi Publish directory dengan `.` (atau biarkan kosong).
4. Klik **Deploy**. Hasilnya alamat seperti `https://nama-acak.netlify.app`.

Cara tercepat tanpa GitHub: buka app.netlify.com/drop, lalu seret seluruh folder `p2p-share` ke halamannya.

Setiap kali kamu `git push`, Vercel/Netlify otomatis memperbarui website.

### Langkah 7: Tes sungguhan

Buka alamat website di dua perangkat yang berbeda:

1. Laptop dan HP di **WiFi yang sama**. Biasanya langsung jalan.
2. Laptop (WiFi) dan HP (**data seluler**). Ini tes yang paling penting. Kalau gagal, lanjut ke langkah 8.
3. Coba juga di browser berbeda (Chrome, Firefox, Safari).

### Langkah 8: Tambah TURN (hanya kalau langkah 7 poin 2 gagal)

Sekitar 10 sampai 20 persen koneksi, terutama jaringan seluler atau kantor yang ketat, tidak bisa tersambung langsung dan butuh server relay (TURN).

1. Daftar akun gratis di **metered.ca** (layanan Open Relay), lalu buat kredensial TURN di dashboard-nya.
2. Cek halaman pricing mereka untuk kuota gratis terbaru. Kuota bisa berubah.
3. Buka `app.js`, cari bagian `PEER_OPTIONS`, hapus tanda `//` di baris TURN dan isi dengan data dari dashboard:

```js
{ urls: 'turn:NAMA-SERVER-TURN:80', username: 'USERNAME', credential: 'PASSWORD' },
```

4. Simpan, lalu `git add . && git commit -m "tambah TURN" && git push`.

Perhatikan: karena ini website statis, username dan password TURN terlihat di kode yang diunduh browser. Untuk proyek kecil ini bisa diterima, tapi artinya orang lain bisa memakai kuotamu. Jangan pakai kredensial yang berbayar atau penting.

### Langkah 9: Sesuaikan (opsional)

Semua pengaturan ada di bagian atas `app.js`:

| Nama | Fungsi | Bawaan |
|---|---|---|
| `CHUNK` | Ukuran satu pesan data | 64 KB |
| `WINDOW` | Maksimal data yang boleh dikirim sebelum penerima mengonfirmasi sudah menulisnya ke disk. Ini yang menjaga memori kedua sisi tetap kecil | 8 MB |
| `RAM_LIMIT` | Batas ukuran file kalau browser penerima terpaksa memakai RAM (browser lama atau mode private) | 200 MB |
| `ROOM_PREFIX` | Awalan ID di server PeerJS | `p2pshare-` |

Ganti `ROOM_PREFIX` dengan awalan unik milikmu (misalnya `zul-share-`) supaya tidak bentrok dengan proyek lain di server publik.

### Langkah 10: Ubah tampilan (opsional)

Semua warna ada di bagian paling atas `style.css`, dalam variabel `:root` (mode terang) dan blok `@media (prefers-color-scheme: dark)` (mode gelap). Beberapa yang paling sering diubah:

| Variabel | Fungsi |
|---|---|
| `--accent` | Warna tombol utama dan progress bar |
| `--b1` sampai `--b5` | Warna bercak latar di belakang kaca (dan `--b1o` sampai `--b5o` untuk kepekatannya) |
| `--glass-bg` | Seberapa bening panel kaca. Naikkan angka terakhirnya (misalnya `0.58` jadi `0.8`) supaya lebih pekat dan lebih mudah dibaca |
| `--bg` | Warna dasar halaman |

Efek blur butuh browser modern. Kalau browser tidak mendukung, atau pengguna mengaktifkan "kurangi transparansi" di pengaturan perangkat, panel otomatis memakai warna solid, jadi tulisan tetap terbaca. Supaya perangkat tidak terbebani, bercak latar dibuat dengan gradien (bukan filter blur), dan **selama transfer berlangsung blur kaca dimatikan otomatis** (panel jadi sedikit lebih pekat, lalu kembali normal setelah selesai). Di lingkungan tes tanpa GPU, efek blur penuh membuat transfer sekitar 2 sampai 3 kali lebih lambat, dan setelah dua langkah ini kecepatan kembali normal. Kalau tetap terasa berat di HP lama, ubah `--glass-bg` jadi lebih pekat dan hapus `backdrop-filter` di bagian "KACA" pada `style.css`.

### QR code untuk gabung room

Setelah membuat room, halaman menampilkan QR code di bawah kode room. Teman cukup scan dengan kamera HP, lalu browser terbuka di link `?room=KODE` dan langsung masuk ke room itu tanpa mengetik apa pun. QR hilang saat teman sudah terhubung, dan muncul lagi kalau dia keluar.

QR berisi alamat website kamu. Jadi di `localhost` QR tidak berguna untuk HP (muncul peringatan kuning), karena HP tidak bisa membuka `localhost` komputermu. Setelah deploy ke Vercel atau Netlify, QR langsung berfungsi. Kamera HP biasa sudah cukup, tidak perlu aplikasi khusus.

### Ikon tab browser

Browser memakai `favicon.svg` (atau `favicon.ico` untuk browser lama). Kalau kamu mengganti ikon, ganti kelima file ikonnya dengan ukuran yang sama: `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` (180 px), `icon-192.png`, `icon-512.png`, dan `icon-maskable-512.png`. Setelah deploy, ikon lama kadang masih tampil karena disimpan browser. Muat ulang paksa (Ctrl+Shift+R) atau tutup dan buka lagi tab-nya.

---

## Cara kerja singkat

1. **Buat room**: browser pendaftar ke PeerJS Cloud dengan ID `p2pshare-KODE`.
2. **Gabung**: browser teman meminta tersambung ke ID itu. PeerJS Cloud hanya jadi perantara perkenalan (signaling).
3. STUN membantu kedua browser menemukan alamat satu sama lain, lalu **koneksi WebRTC langsung terbentuk**. Server signaling tidak lagi dilewati.
4. Kirim file: pesan `meta` (nama dan ukuran) → penerima klik Terima → file dikirim per potongan 16 KB (`chunk`) → pesan `done` → penerima menyusun ulang dan menyediakan tombol Unduh.

---

## File besar: cara kerja dan batasnya

Supaya file berukuran GB tidak membebani perangkat, aplikasi ini bekerja begini:

- **Pengirim** membaca file per 1 MB langsung dari disk dan mengirimnya per 64 KB. File tidak pernah dimuat utuh ke RAM.
- **Penerima** langsung menulis setiap potongan ke penyimpanan browser (Origin Private File System, lewat `writer.js`). Data tidak ditumpuk di RAM. Setelah selesai, tombol **Unduh** menyimpan file ke folder Download.
- **Rem otomatis (flow control).** Penerima rutin melapor "sudah tertulis sekian MB". Pengirim berhenti kalau data yang belum dikonfirmasi lebih dari `WINDOW` (8 MB). Jadi kalau disk penerima lambat, pengirim ikut melambat dan tidak ada data yang menumpuk di memori.
- **Cek ruang kosong.** Sebelum file diterima, browser penerima memeriksa sisa kuota penyimpanannya. Kalau tidak cukup, file ditolak otomatis dengan alasan yang jelas.
- **Layar HP dijaga tetap menyala** selama transfer (Wake Lock), kalau browser mendukung.
- Data dikirim sebagai biner mentah (`serialization: 'raw'`), tanpa pembungkus tambahan, jadi beban CPU lebih ringan.

Hasil tes lokal (dua browser di satu mesin, server signaling lokal): file 1 GB sampai utuh dan identik byte demi byte, dan memori proses browser penerima hanya naik sekitar 80 MB, bukan 1 GB. Kenaikan itu tetap sama untuk file 256 MB maupun 1 GB, jadi bukan bergantung ukuran file.

**Yang perlu kamu tahu:**

1. **Butuh ruang disk dua kali lipat sementara.** File ditulis dulu ke penyimpanan browser, lalu "Unduh" menyalinnya ke folder Download. Salinan sementara dihapus otomatis saat halaman dibuka lagi. Pastikan ruang kosong di perangkat penerima minimal 2 kali ukuran file.
2. **Kuota penyimpanan tiap browser berbeda.** Chrome dan Edge biasanya lega. Safari dan mode private/incognito lebih ketat. Kalau tidak cukup, muncul pesan penolakan dan pengirim diberi tahu alasannya.
3. **Browser tanpa dukungan penyimpanan disk** (browser lama, sebagian mode private) otomatis memakai RAM dengan batas 200 MB. Pengirim akan melihat pesan "Ditolak: browser penerima hanya mendukung file sampai 200 MB".
4. **Jangan lewat TURN untuk file besar.** Kalau koneksi langsung gagal dan harus lewat relay TURN gratis, beberapa GB akan menghabiskan kuota. File besar sebaiknya hanya dikirim saat koneksi langsung berhasil (WiFi yang sama atau jaringan yang tidak terlalu ketat).
5. **Kecepatan mengikuti jaringan.** Di internet, batasnya adalah kecepatan upload pengirim. Di WiFi yang sama biasanya jauh lebih cepat. Angka kecepatan tampil di kartu transfer.
6. **Belum ada fitur lanjutkan transfer.** Kalau koneksi putus di tengah, file dikirim ulang dari awal. Tab dan perangkat harus tetap aktif selama transfer.

---

## Troubleshooting

| Masalah | Penyebab dan solusi |
|---|---|
| "Room tidak ditemukan" | Kode salah, atau pembuat room sudah menutup tab. Minta kode baru. |
| Status "Menghubungkan…" lama sekali | Jaringan salah satu pihak memblokir koneksi langsung. Coba langkah 8 (TURN), atau pindah jaringan. |
| "Gagal menghubungi server signaling" | PeerJS Cloud sedang sibuk atau diblokir jaringan. Coba lagi nanti. Kalau sering terjadi, ganti ke signaling Supabase Realtime. |
| Tombol Salin tidak bekerja di HP | Penyalinan otomatis butuh HTTPS. Di alamat online (Vercel/Netlify) sudah aman. Kalau tidak tersedia, muncul kotak untuk salin manual. |
| "Ditolak: ruang penyimpanan browser penerima tidak cukup" | Ruang kosong atau kuota browser penerima kurang. Kosongkan disk, atau pakai Chrome/Edge di desktop. |
| "Ditolak: browser penerima hanya mendukung file sampai 200 MB" | Browser penerima tidak mendukung penyimpanan disk (browser lama atau mode private). Minta penerima memakai Chrome, Edge, Firefox, atau Safari terbaru di jendela biasa. |
| Setelah transfer file besar, ruang disk terasa berkurang | Ada salinan sementara di penyimpanan browser. Buka ulang halaman website ini, salinannya dihapus otomatis. |
| Transfer berhenti di tengah | Tab ditutup, HP masuk mode tidur, atau koneksi putus. Kirim ulang. |
| Link lama `?room=KODE` hanya menampilkan "Room tidak ditemukan" | Link hanya berlaku selama pembuat room masih membuka halamannya. Buat room baru. |

---

## Keamanan dan batasan

- Data WebRTC **terenkripsi** (DTLS), tapi **alamat IP** kedua pihak terlihat oleh lawan bicara.
- Siapa pun yang tahu kode room bisa masuk selama room masih kosong. Kirim kode hanya ke orang yang dituju. Room menolak orang ketiga kalau sudah ada teman yang tersambung.
- Penerima selalu harus klik **Terima**, jadi tidak ada file masuk diam-diam. Tetap periksa file dari sumber yang tidak dikenal (terutama `.exe` dan `.apk`) sebelum membukanya.
- PeerJS Cloud dan TURN gratis tidak punya jaminan uptime. Cocok untuk proyek kecil dan belajar, bukan layanan produksi.
- Tab harus tetap terbuka di kedua sisi selama transfer.
- Satu room hanya untuk dua orang.
- Penerima menolak otomatis file yang melebihi ruang kosongnya. Nama file hanya ditampilkan sebagai teks (aman dari injeksi HTML).

---

## Pengembangan berikutnya

Urutan yang disarankan, dari paling mudah:

1. Tombol QR code supaya HP tinggal scan (library `qrcode.js`).
2. Kode room kedaluwarsa otomatis setelah beberapa menit.
3. Chat teks di room yang sama (pesan `{type:'chat'}` lewat koneksi yang sama).
4. Ganti signaling ke Supabase Realtime kalau PeerJS Cloud kurang stabil.
5. Lanjutkan transfer yang terputus dari titik terakhir (resume), berguna untuk file puluhan GB.

Lisensi: kode proyek ini bebas dipakai. `peerjs.min.js` adalah library PeerJS (lisensi MIT, https://peerjs.com).
