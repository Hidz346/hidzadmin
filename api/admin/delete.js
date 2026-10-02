/* Replika persis deleteUser() di admin.html — cek akun bukan yang
   dilindungi, hapus dari daftar, lalu bersihkan jejaknya di sesi/banned/
   blocked device. */

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
    var targetId = typeof body.targetId === 'string' ? body.targetId : '';

    try { await firebaseAuth.requireAdmin(req); } catch (e) {
        res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
        return;
    }
    if (!targetId) {
        res.status(200).json({ ok: false });
        return;
    }

    var out = await db.mutateAccounts(function (list) {
        var target = list.filter(function (u) { return u.id === targetId; })[0];
        if (!target) return { save: false, result: { ok: false, reason: 'not_found' } };
        if (db.isProtectedAccount(target)) return { save: false, result: { ok: false, reason: 'protected' } };

        return {
            save: true,
            list: list.filter(function (u) { return u.id !== targetId; }),
            result: { ok: true }
        };
    });

    if (!out.ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }
    if (out.result.ok) await db.removeAccountTraces(targetId);
    res.status(200).json(out.result);
};
