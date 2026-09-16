# HIDZ Security Layer

Update ini menambahkan lapisan keamanan server-side tanpa mengubah alur login utama.

## Yang ditambahkan
- Deteksi pola SQL injection, script/defacement injection, path traversal dan command-injection pada request API.
- IP yang terdeteksi otomatis diblokir di application layer selama 24 jam; pelanggaran berulang memperpanjang sampai maksimal 7 hari.
- Request flood pada API dibatasi di application layer; jika melewati ambang, IP mendapat blokir sementara 10 menit.
- Event keamanan disimpan di Firebase pada `hidz_security_events` dan IP block pada `hidz_security_ip_blocks`.
- Laporan CSP disimpan terpisah di `hidz_security_csp_reports` dan tidak dianggap sebagai serangan otomatis.
- HidzAdmin memiliki monitor keamanan dan tombol BUKA BLOKIR.
- Security guard dipasang pada seluruh endpoint `/api` di HidzProject.
- Password tidak ikut dipindai oleh regex untuk mengurangi false-positive.
- Header keamanan dasar ditambahkan di `vercel.json`.

## Environment variable
Tetap wajib menggunakan:
- `FIREBASE_DB_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

Jangan pernah menaruh secret tersebut di HTML/JavaScript browser.

## Penting tentang DDoS
Script aplikasi tidak bisa menjamin penghentian DDoS volumetrik: trafik dapat membanjiri jaringan/CDN sebelum request mencapai Vercel Function. Untuk proteksi edge, gunakan WAF/CDN seperti Cloudflare atau firewall provider hosting. Setelah domain diproxy melalui Cloudflare, aktifkan DDoS Managed Rules dan rate limiting untuk `/api/*`, terutama `/api/login` dan `/api/admin-login`.

## SQL injection
Project ini menggunakan Firebase Realtime Database, bukan query SQL langsung. Jadi tidak ada query SQL yang bisa diparameterisasi di endpoint yang sekarang. Guard tetap mendeteksi pola SQL injection sebagai sinyal serangan, tetapi pencegahan utamanya adalah jangan pernah menambahkan query SQL berbasis string jika database SQL ditambahkan nanti. Gunakan prepared/parameterized statements.

## Deface
Vercel deployment bersifat immutable; script ini tidak mencoba "memperbaiki" file deployment dari runtime. Header keamanan dan deteksi payload membantu mencegah XSS/injection, sedangkan integritas deployment harus dijaga melalui Git/Vercel dan akses akun.

## CSP reports
CSP `Report-Only` tetap dipakai sebagai telemetry. Laporan browser tidak lagi masuk ke daftar `Event Terbaru` sebagai ancaman, karena satu halaman dapat menghasilkan beberapa laporan CSP yang sah. HidzAdmin hanya menampilkan jumlah laporan CSP secara terpisah.

## Rate limiting aplikasi
Security guard menerapkan jendela 60 detik dengan batas 90 request per IP pada endpoint yang dilindungi. Pelampauan batas menghasilkan HTTP 429 dan blokir sementara 10 menit. Ambang ini adalah lapisan aplikasi, bukan pengganti rate limiting di CDN/WAF.


## Firebase Authentication hardening

Versi hardened menggunakan Firebase Authentication untuk mengikat akses Realtime Database ke identitas akun. API login membuat custom token di server; browser kemudian sign-in ke Firebase Auth sebelum memakai listener realtime.

Set environment variable server berikut di Vercel untuk HIDZPROJECT dan HidzAdmin:

- `FIREBASE_SERVICE_ACCOUNT_JSON` = seluruh JSON service account Firebase, atau gunakan tiga variable berikut:
  - `FIREBASE_PROJECT_ID`
  - `FIREBASE_CLIENT_EMAIL`
  - `FIREBASE_PRIVATE_KEY`

Jangan commit service-account JSON/private key ke GitHub.

Rules sekarang mengizinkan user mengakses node miliknya sendiri berdasarkan `auth.uid`, sedangkan operasi admin menggunakan custom claim `admin=true`. Node server-only tetap tertutup dari client.

Setelah environment variable dipasang, deploy API terlebih dahulu. Kemudian uji login user/admin dan fitur realtime. Firebase merekomendasikan Local Emulator Suite untuk pengujian Rules sebelum production.
