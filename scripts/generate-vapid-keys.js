/* Bikin sepasang kunci VAPID buat notifikasi Chrome (Web Push).
   Jalankan SEKALI di komputer/Termux sendiri — tidak perlu install apa pun:

       node scripts/generate-vapid-keys.js

   Hasilnya diisi ke Environment Variable Vercel:
     - HidzAdmin   : VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (+ VAPID_SUBJECT, opsional)
     - HidzProject : VAPID_PUBLIC_KEY (isinya SAMA dengan di HidzAdmin)

   VAPID_PRIVATE_KEY bersifat rahasia: jangan ditaruh di file project atau
   dibagikan ke siapa pun. Kalau kunci diganti, device yang sudah
   mengaktifkan notifikasi otomatis mendaftar ulang saat halaman dibuka lagi. */

var crypto = require('crypto');

var pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
var jwk  = pair.privateKey.export({ format: 'jwk' });

/* Format yang diminta Web Push: kunci publik = 0x04 + x + y (65 byte),
   kunci privat = d (32 byte), keduanya base64url. */
var publicKey = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url')
]).toString('base64url');

console.log('VAPID_PUBLIC_KEY=' + publicKey);
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
console.log('VAPID_SUBJECT=mailto:emailkamu@contoh.com');
