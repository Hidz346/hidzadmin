/* Replika persis createAccess() di admin.html, cuma sekarang jalan di
   server: cek username duplikat & tulis akun baru dilakukan dalam satu
   napas terhadap data server TERBARU. */

var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');
var pw = require('../_lib/password');
var resetPassword = require('../_lib/reset-password');

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

    /* Reset password akun lama dilayani di endpoint ini juga, bukan file
       api/admin/ tersendiri, supaya jumlah Serverless Function di paket
       Hobby tidak bertambah. Logikanya ada di _lib/reset-password.js. */
    if (body.action === 'reset-password') {
        await resetPassword.run(body, res);
        return;
    }

    if (!newUsername || !newPassword) {
        res.status(200).json({ ok: false });
        return;
    }

    /* Hash dihitung SEKALI di luar mutator (scrypt-nya mahal, dan mutator bisa
       terpanggil ulang kalau ada bentrok penulisan). */
    var hashed = pw.hashPassword(newPassword);

    var out = await db.mutateAccounts(function (list) {
        var dup = list.some(function (u) { return (u.username || '').toLowerCase() === newUsername.toLowerCase(); });
        if (dup) return { save: false, result: { ok: false, reason: 'duplicate' } };

        /* Durasi/status BELUM aktif saat dibuat — baru aktif begitu akun ini
           login pertama kali ke hidzproject.html (lihat _completeLogin di
           sana), berlaku juga untuk akun UNLIMITED. Sama persis seperti
           createAccess() versi lama. */
        var now = Date.now();
        while (list.some(function (u) { return u.id === 'u_' + now; })) now++;

        var newUser = {
            id:            'u_' + now,
            username:      newUsername,
            password:      hashed,
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
        list.push(newUser);

        /* Password asli sengaja tetap dibalikin SEKALI di sini — cuma echo dari
           apa yang barusan diketik admin sendiri, buat ditampilkan/disalin
           begitu akun selesai dibuat. Yang tersimpan di database tetap
           hash-nya (newUser.password di atas). */
        return { save: true, result: { ok: true, user: Object.assign({}, newUser, { password: newPassword }) } };
    });

    if (!out.ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }
    res.status(200).json(out.result);
};
