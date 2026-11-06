# Setup Notifikasi (HidzAdmin — sisi pengirim)

Dipakai untuk mengabari pemilik akun saat admin menekan **RESET PASSWORD**,
**TAMBAH durasi**, menyalakan **MAINTENANCE**, atau mengirim kabar **PROJECT BARU**.

- Akun sedang **online** di HidzProject → pesan tampil di dalam halaman, paling banyak 3 kali
  (sekali setiap halaman dibuka kembali). Pesannya tetap tersimpan di **Riwayat Notifikasi**
  (tab Notifikasi di halaman Pengumuman) sampai dihapus atau masa berlakunya habis.
- Device tidak sedang membuka HidzProject → notifikasi Chrome (Web Push).

Tanpa langkah di bawah, reset password / tambah durasi / maintenance tetap
jalan seperti biasa — yang tidak aktif hanya notifikasi Chrome-nya.

## Langkah (sekali saja)

1. Buat sepasang kunci:

       node scripts/generate-vapid-keys.js

2. Isi **Environment Variable** project HidzAdmin di Vercel:

       VAPID_PUBLIC_KEY   = (hasil langkah 1)
       VAPID_PRIVATE_KEY  = (hasil langkah 1 — RAHASIA, jangan dibagikan)
       VAPID_SUBJECT      = mailto:emailkamu@contoh.com   (opsional)

3. Isi **Environment Variable** project HidzProject di Vercel:

       VAPID_PUBLIC_KEY   = (sama persis dengan di HidzAdmin)

4. Salin isi `databaserules.json` ke Firebase Realtime Database → Rules → Publish.
   Yang baru: `hidz_notifications` dan `hidz_push_subs`.

5. Deploy ulang kedua project. `package.json` di project ini memasang
   `web-push` otomatis saat build.

## Catatan

- Kunci VAPID jangan diganti-ganti. Kalau terpaksa diganti, device yang sudah
  mengaktifkan notifikasi mendaftar ulang sendiri saat HidzProject dibuka lagi.
- Admin (`admin_hidz_protected`) tidak ikut menerima notifikasi maintenance.
- **Maintenance**, **Project Baru**, dan **Voucher VIP Baru** dikirim ke SEMUA akun user/VIP yang
  sudah dibuat — sudah pernah login atau belum, durasi masih jalan atau sudah habis. Pesannya
  menunggu di antrean tiap akun (sekaligus jadi riwayatnya), jadi akun yang belum pernah login
  melihatnya saat login pertama. Notifikasi maintenance hanya masuk riwayat, tanpa kartu pop-up.
- Mengurangi durasi tidak mengirim notifikasi.
- **Project Baru**: isi nama (dan deskripsi singkat, opsional) di kartu *Project Baru*
  panel admin, lalu **KIRIM NOTIFIKASI**. Daftar project di HidzProject tersimpan di
  halamannya sendiri, jadi kabar ini dikirim manual setelah project barunya tayang.
  Penerimanya semua akun user/VIP (admin dilewati). Pengirimannya numpang di `api/admin/maintenance.js` (action `project-new`),
  jadi jumlah Serverless Function tidak bertambah.
