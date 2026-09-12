/* Ganti listener .on('value') penuh yang lama di admin.html — dulu
   SELURUH isi hidz_access_db (semua password) langsung ke-download ke
   browser siapa pun yang berhasil lewat gerbang UI, padahal rules Firebase
   di baliknya tetap kebuka buat siapa saja yang tahu cara manggilnya
   langsung. Sekarang identitas admin diverifikasi ulang di server dulu
   baru datanya dikirim. */

var db = require('../_lib/db');

module.exports = async function (req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};
    var username = typeof body.username === 'string' ? body.username : '';
    var password = typeof body.password === 'string' ? body.password : '';

    if (!db.verifyAdmin(username, password)) {
        res.status(200).json({ ok: false });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var bannedRaw = await db.fetchPath('hidz_banned');
    var banned = {};
    if (bannedRaw && typeof bannedRaw === 'object') {
        Object.keys(bannedRaw).forEach(function (uid) {
            if (bannedRaw[uid] && bannedRaw[uid].banned === true) banned[uid] = true;
        });
    }

    res.status(200).json({ ok: true, users: list, banned: banned });
};
