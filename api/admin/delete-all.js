/* Replika persis executeDeleteAllUsers() di admin.html — hapus semua akun
   KECUALI yang dilindungi (admin_hidz_protected), kirim sinyal
   hidz_delete_all_trigger dulu supaya user yang lagi login langsung
   ter-logout tanpa nunggu, baru bersihkan jejak sesi/banned/blocked
   masing-masing akun yang dihapus. */

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

    var kept    = list.filter(function (u) { return db.isProtectedAccount(u); });
    var removed = list.filter(function (u) { return !db.isProtectedAccount(u); });

    if (removed.length === 0) {
        res.status(200).json({ ok: true, removedCount: 0 });
        return;
    }

    /* Sinyal logout-instan dikirim LEBIH DULU, sebelum hidz_access_db
       diubah, sama seperti versi lama */
    await db.setPath('hidz_delete_all_trigger', Date.now());

    var ok = await db.saveAllAccounts(kept);
    if (!ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    await Promise.all(removed.map(function (u) { return db.removeAccountTraces(u.id); }));
    res.status(200).json({ ok: true, removedCount: removed.length });
};
