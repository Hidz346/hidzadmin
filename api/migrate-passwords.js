/* Jalankan endpoint ini SEKALI setelah deploy perubahan hashing password —
   tugasnya cuma satu: cari akun yang password-nya MASIH plaintext (belum
   berformat "scrypt:...") lalu hash di tempat. Aman dipanggil berkali-kali
   (idempotent) — akun yang password-nya sudah ke-hash otomatis dilewati,
   jadi gak akan di-hash dobel.

   Cara pakai: kirim POST ke /api/migrate-passwords dengan body
   { "username": "...", "password": "..." } pakai kredensial ADMIN (env
   var ADMIN_USERNAME/ADMIN_PASSWORD) — sama seperti login admin biasa.
   Setelah dijalankan sekali & responsnya menunjukkan migrated:0 di
   panggilan kedua (artinya semua sudah ke-hash), file ini boleh dihapus
   dari project kalau mau lebih rapi — tapi dibiarkan pun tidak berbahaya
   karena tetap butuh kredensial admin & tetap idempotent. */

var db = require('./_lib/db');
var pw = require('./_lib/password');

var securityGuard = require('./_lib/security');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};
    var username = typeof body.username === 'string' ? body.username : '';
    var password = typeof body.password === 'string' ? body.password : '';

    var adminUser = process.env.ADMIN_USERNAME || '';
    var adminPass = process.env.ADMIN_PASSWORD || '';
    if (!adminUser || !adminPass ||
        username.toLowerCase() !== adminUser.toLowerCase() ||
        password !== adminPass) {
        res.status(200).json({ ok: false });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var migrated = 0;
    list.forEach(function (u) {
        if (u && u.password && !pw.isHashed(u.password)) {
            u.password = pw.hashPassword(u.password);
            migrated++;
        }
    });

    if (migrated > 0) {
        var ok = await db.saveAllAccounts(list);
        if (!ok) {
            res.status(200).json({ ok: false, error: true });
            return;
        }
    }

    res.status(200).json({ ok: true, total: list.length, migrated: migrated });
};
