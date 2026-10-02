/* Replika persis executeDeleteAllUsers() di admin.html — hapus semua akun
   KECUALI yang dilindungi (admin_hidz_protected), kirim sinyal
   hidz_delete_all_trigger dulu supaya user yang lagi login langsung
   ter-logout tanpa nunggu, baru bersihkan jejak sesi/banned/blocked
   masing-masing akun yang dihapus. */

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

    /* Intip dulu apakah memang ada yang perlu dihapus, supaya sinyal logout
       instan di bawah tidak terkirim percuma. */
    var current = await db.fetchAllAccounts();
    if (current === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }
    if (!current.some(function (u) { return !db.isProtectedAccount(u); })) {
        res.status(200).json({ ok: true, removedCount: 0 });
        return;
    }

    /* Sinyal logout-instan dikirim LEBIH DULU, sebelum hidz_access_db
       diubah, sama seperti versi lama */
    await db.setPath('hidz_delete_all_trigger', Date.now());

    var out = await db.mutateAccounts(function (list) {
        var removed = list.filter(function (u) { return !db.isProtectedAccount(u); });
        return {
            save: removed.length > 0,
            list: list.filter(function (u) { return db.isProtectedAccount(u); }),
            result: removed
        };
    });

    if (!out.ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    await Promise.all(out.result.map(function (u) { return db.removeAccountTraces(u.id); }));
    res.status(200).json({ ok: true, removedCount: out.result.length });
};
