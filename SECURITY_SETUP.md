# HidzAdmin Security Setup

HidzAdmin menggunakan Firebase Authentication custom token untuk akses realtime admin.

Set salah satu konfigurasi server berikut di Vercel:

- `FIREBASE_SERVICE_ACCOUNT_JSON` (disarankan), atau
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.

Jangan memasukkan service-account JSON/private key ke GitHub.
