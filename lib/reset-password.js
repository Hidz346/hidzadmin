/* Reset password satu akun USER/VIP dari panel admin.

   Dipanggil dari api/admin/create.js (action: 'reset-password') — sengaja
   tidak dibuat sebagai file endpoint sendiri di api/admin/ supaya jumlah
   Serverless Function di paket Hobby tidak bertambah. Pemeriksaan admin
   (guard + token) sudah dilakukan create.js sebelum fungsi ini dipanggil.

   Password lama tersimpan sebagai hash satu arah, jadi tidak ada cara
   "melihat" isinya — satu-satunya jalan kalau admin perlu mengirim ulang
   password ke pembeli adalah bikin yang baru. Password baru dibuat di
   server (acak) KECUALI admin mengisi `customPassword` — dipakai kalau
   admin atau pemilik akunnya mau password pilihan sendiri. Apa pun
   asalnya, password disimpan hanya dalam bentuk hash, lalu dibalikin
   SEKALI ke admin yang memanggil supaya bisa langsung disalin.

   Begitu berhasil, pemilik akun dikabari lewat ./push.js (pesan dalam
   halaman saat ONLINE + notifikasi Chrome). Isi pesannya tidak pernah
   memuat password.

   Yang diubah cuma field `password` milik akun target, ditulis lewat
   db.mutateAccounts() sehingga tidak menimpa perubahan lain yang masuk di
   saat yang sama. */

var crypto = require('crypto');
var db = require('./db');
var pw = require('./password');
var push = require('./push');

/* Tanpa karakter yang gampang ketuker (0/O, 1/l/I) karena password ini
   bakal dikirim lewat chat dan diketik ulang oleh pembeli. */
var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
var PASSWORD_LENGTH = 12;

/* Batas password pilihan sendiri. Spasi di awal/akhir ditolak karena hampir
   pasti salah ketik dan membuat pemilik akun tidak bisa login. */
var CUSTOM_MIN = 4;
var CUSTOM_MAX = 64;

function isValidCustomPassword(value) {
    return value.length >= CUSTOM_MIN && value.length <= CUSTOM_MAX && value === value.trim();
}

function generatePassword() {
    var out = '';
    for (var i = 0; i < PASSWORD_LENGTH; i++) {
        out += ALPHABET.charAt(crypto.randomInt(0, ALPHABET.length));
    }
    return out;
}

async function run(body, res) {
    var targetId = typeof body.targetId === 'string' ? body.targetId : '';
    if (!targetId) {
        res.status(200).json({ ok: false });
        return;
    }

    var custom = typeof body.customPassword === 'string' ? body.customPassword : '';
    if (custom !== '' && !isValidCustomPassword(custom)) {
        res.status(200).json({ ok: false, reason: 'invalid_password' });
        return;
    }

    var newPassword = custom !== '' ? custom : generatePassword();
    var hashed      = pw.hashPassword(newPassword);

    var out = await db.mutateAccounts(function (list) {
        var target = list.filter(function (u) { return u.id === targetId; })[0];
        if (!target) return { save: false, result: { ok: false, reason: 'not_found' } };
        if (db.isProtectedAccount(target)) return { save: false, result: { ok: false, reason: 'protected' } };

        target.password = hashed;
        return { save: true, result: { ok: true, username: target.username, password: newPassword } };
    });

    if (!out.ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    if (out.result && out.result.ok) {
        await push.notifyUser(targetId, {
            type:  'reset_password',
            title: 'Password Akun Direset',
            body:  'Admin sudah mengganti password akunmu. Pakai password baru saat login berikutnya.'
        });
    }
    res.status(200).json(out.result);
}

module.exports = { run: run };
