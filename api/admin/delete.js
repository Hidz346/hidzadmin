/* Replika persis deleteUser() di admin.html — cek akun bukan yang
   dilindungi, hapus dari daftar, lalu bersihkan jejaknya di sesi/banned/
   blocked device. */

var db = require('../_lib/db');

module.exports = async function (req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};
    var username = typeof body.username === 'string' ? body.username : '';
    var password = typeof body.password === 'string' ? body.password : '';
    var targetId = typeof body.targetId === 'string' ? body.targetId : '';

    if (!db.verifyAdmin(username, password)) {
        res.status(200).json({ ok: false });
        return;
    }
    if (!targetId) {
        res.status(200).json({ ok: false });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var target = list.filter(function (u) { return u.id === targetId; })[0];
    if (!target) {
        res.status(200).json({ ok: false, reason: 'not_found' });
        return;
    }
    if (db.isProtectedAccount(target)) {
        res.status(200).json({ ok: false, reason: 'protected' });
        return;
    }

    var remaining = list.filter(function (u) { return u.id !== targetId; });
    var ok = await db.saveAllAccounts(remaining);
    if (!ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    await db.removeAccountTraces(targetId);
    res.status(200).json({ ok: true });
};
