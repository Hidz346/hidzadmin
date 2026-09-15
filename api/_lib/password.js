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

function verifyPassword(plain, stored) {
    if (!isHashed(stored)) {
        return stored === plain;
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
    hashPassword:   hashPassword,
    isHashed:       isHashed,
    verifyPassword: verifyPassword
};
