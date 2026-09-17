/* Ganti listener .on('value') penuh yang lama di admin.html — dulu
   SELURUH isi hidz_access_db (semua password) langsung ke-download ke
   browser siapa pun yang berhasil lewat gerbang UI, padahal rules Firebase
   di baliknya tetap kebuka buat siapa saja yang tahu cara manggilnya
   langsung. Sekarang identitas admin diverifikasi ulang di server dulu
   baru datanya dikirim. */

var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};

    try { await firebaseAuth.requireAdmin(req); } catch (e) {
        res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }
    var sanitizedList = list.map(function (u) {
        var copy = {};
        Object.keys(u).forEach(function (k) { if (k !== 'password') copy[k] = u[k]; });
        return copy;
    });

    var bannedRaw = await db.fetchPath('hidz_banned');
    var banned = {};
    if (bannedRaw && typeof bannedRaw === 'object') {
        Object.keys(bannedRaw).forEach(function (uid) {
            if (bannedRaw[uid] && bannedRaw[uid].banned === true) banned[uid] = true;
        });
    }

    res.status(200).json({ ok: true, users: sanitizedList, banned: banned });
};
