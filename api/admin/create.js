/* Replika persis createAccess() di admin.html, cuma sekarang jalan di
   server: cek username duplikat & tulis akun baru dilakukan dalam satu
   napas terhadap data server TERBARU. */

var db = require('../_lib/db');

module.exports = async function (req, res) {
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

    if (!db.verifyAdmin(username, password)) {
        res.status(200).json({ ok: false });
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
        password:      newPassword,
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

    res.status(200).json({ ok: true, user: newUser });
};
