/* Replika persis createAccess() di admin.html, cuma sekarang jalan di
   server: cek username duplikat & tulis akun baru dilakukan dalam satu
   napas terhadap data server TERBARU. */

var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');
var pw = require('../_lib/password');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body        = req.body || {};
    var username    = typeof body.username === 'string' ? body.username : '';
    var password    = typeof body.password === 'string' ? body.password : '';
    var newUsername = typeof body.newUsername === 'string' ? body.newUsername.trim() : '';
    var newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    var role        = (body.role === 'vip') ? 'vip' : 'user';
    var deviceLimit = typeof body.deviceLimit === 'number' ? body.deviceLimit : 1;
    var isUnlimited = !!body.isUnlimited;
    var durationMs  = typeof body.durationMs === 'number' ? body.durationMs : null;
    var durationLabel = typeof body.durationLabel === 'string' ? body.durationLabel : 'UNLIMITED';

    try { await firebaseAuth.requireAdmin(req); } catch (e) {
        res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
        return;
    }
    if (!newUsername || !newPassword) {
        res.status(200).json({ ok: false });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var dup = list.some(function (u) { return (u.username || '').toLowerCase() === newUsername.toLowerCase(); });
    if (dup) {
        res.status(200).json({ ok: false, reason: 'duplicate' });
        return;
    }

    var now = Date.now();
    /* Durasi/status BELUM aktif saat dibuat — baru aktif begitu akun ini
       login pertama kali ke hidzproject.html (lihat _completeLogin di
       sana), berlaku juga untuk akun UNLIMITED. Sama persis seperti
       createAccess() versi lama. */
    var newUser = {
        id:            'u_' + now,
        username:      newUsername,
        password:      pw.hashPassword(newPassword),
        role:          role,
        createdAt:     now,
        expiresAt:     null,
        durationMs:    isUnlimited ? null : durationMs,
        durationLabel: durationLabel,
        deviceLimit:   deviceLimit,
        activated:     false,
        logoutAt:      null,
        loginAt:       null,
        loggedOut:     false
    };

    var ok = await db.saveAllAccounts(list.concat([newUser]));
    if (!ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    /* Password asli sengaja tetap dibalikin SEKALI di sini — cuma echo dari
       apa yang barusan diketik admin sendiri, buat ditampilkan/disalin
       begitu akun selesai dibuat. Yang tersimpan di database tetap
       hash-nya (newUser.password di atas). */
    res.status(200).json({ ok: true, user: Object.assign({}, newUser, { password: newPassword }) });
};
