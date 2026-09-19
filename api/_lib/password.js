/* Hash password satu arah pakai scrypt bawaan Node.js — sengaja gak pakai
   library luar (bcrypt dkk butuh native binding yang ribet di lingkungan
   serverless kayak Vercel), scrypt sudah cukup kuat & sudah include di
   Node.js tanpa perlu instal apa pun.

   Formatnya "scrypt:<salt-hex>:<hash-hex>", jadi gampang dibedain dari
   password lama yang masih plaintext peninggalan sebelum migrasi (dipakai
   juga sama /api/migrate-passwords.js). Begitu semua akun sudah dimigrasi,
   cabang plaintext di verifyPassword() di bawah gak akan pernah kepakai
   lagi — sengaja tetap dibiarkan ada supaya akun yang entah kenapa belum
   sempat termigrasi tetap bisa login, bukan malah terkunci total. */

var crypto = require('crypto');

var KEY_LEN = 64;

function hashPassword(plain) {
    var salt = crypto.randomBytes(16).toString('hex');
    var hash = crypto.scryptSync(String(plain), salt, KEY_LEN).toString('hex');
    return 'scrypt:' + salt + ':' + hash;
}

function isHashed(stored) {
    return typeof stored === 'string' && stored.split(':').length === 3 && stored.indexOf('scrypt:') === 0;
}

/* Bandingin dua string tanpa bocorin info dari waktu eksekusi (percobaan
   pertama beda vs percobaan ke-1000 harus makan waktu yang sama persis).
   Dipakai buat kredensial ADMIN (dari Environment Variable) & fallback
   password lama yang belum ke-hash — bukan cuma == biasa, soalnya ==
   berhenti di karakter pertama yang beda, jadi teorinya bisa dipakai buat
   nebak isi string aslinya sedikit demi sedikit lewat selisih waktu
   respons. Kedua sisi di-hash dulu ke panjang tetap (SHA-256) sebelum
   dibandingin, biar timingSafeEqual bisa jalan walau panjang aslinya beda. */
function timingSafeStringEqual(a, b) {
    var bufA = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
    var bufB = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
    return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPassword(plain, stored) {
    if (!isHashed(stored)) {
        return timingSafeStringEqual(stored, plain);
    }
    var parts = stored.split(':');
    try {
        var actual   = crypto.scryptSync(String(plain), parts[1], KEY_LEN);
        var expected = Buffer.from(parts[2], 'hex');
        if (actual.length !== expected.length) return false;
        return crypto.timingSafeEqual(actual, expected);
    } catch (e) {
        return false;
    }
}

module.exports = {
    hashPassword:         hashPassword,
    isHashed:             isHashed,
    verifyPassword:       verifyPassword,
    timingSafeStringEqual: timingSafeStringEqual
};
