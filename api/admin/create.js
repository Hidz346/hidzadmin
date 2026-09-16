/* Bikin akun role=user baru dari Panel VIP. Pengecekan username dobel dan
   penulisan ke database dilakukan di server supaya browser gak perlu
   download+timpa seluruh daftar akun sendiri kayak sebelumnya. */

var db = require('../_lib/db');
var pw = require('../_lib/password');

var securityGuard = require('../_lib/security');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body         = req.body || {};
    var vipId        = typeof body.vipId === 'string' ? body.vipId : '';
    var vipUsername  = typeof body.vipUsername === 'string' ? body.vipUsername : '';
    var vipPassword  = typeof body.vipPassword === 'string' ? body.vipPassword : '';
    var newUsername  = typeof body.username === 'string' ? body.username.trim() : '';
    var newPassword  = typeof body.password === 'string' ? body.password : '';
    var deviceLimit  = typeof body.deviceLimit === 'number' ? body.deviceLimit : 1;
    var isUnlimited  = !!body.isUnlimited;
    var durationMs   = typeof body.durationMs === 'number' ? body.durationMs : null;
    var durationLabel = typeof body.durationLabel === 'string' ? body.durationLabel : 'UNLIMITED';

    if (!vipId || !vipUsername || !vipPassword || !newUsername || !newPassword) {
        res.status(200).json({ ok: false });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var me = db.findValidVip(list, vipId, vipUsername, vipPassword);
    if (!me) {
        res.status(200).json({ ok: false });
        return;
    }

    var dup = list.some(function (u) { return (u.username || '').toLowerCase() === newUsername.toLowerCase(); });
    if (dup) {
        res.status(200).json({ ok: false, reason: 'duplicate' });
        return;
    }

    var now = Date.now();
    /* expiresAt sengaja dibiarkan null — hitung mundur baru mulai jalan
       begitu akun ini pertama kali login (lihat _completeLogin di
       hidzproject.html), bukan dari saat dibuat. Sama persis seperti
       perilaku Panel VIP yang lama. */
    var newUser = {
        id:            'u_' + now,
        username:      newUsername,
        password:      pw.hashPassword(newPassword),
        role:          'user',
        createdAt:     now,
        createdBy:     { id: me.id, username: me.username },
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

    /* Password asli (bukan hash) sengaja tetap dibalikin SEKALI di sini —
       ini cuma echo dari apa yang barusan diketik VIP sendiri di form,
       dipakai buat ditampilkan/disalin begitu akun selesai dibuat. Yang
       tersimpan di database tetap hash-nya (newUser.password di atas). */
    res.status(200).json({ ok: true, user: Object.assign({}, newUser, { password: newPassword }) });
};
