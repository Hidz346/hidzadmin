/* Kebalikan dari extend.js — KURANGI durasi akun, dipakai bareng dari modal
   Atur Durasi yang sama di admin.html (confirmExtendDuration(), mode 'sub').
   Ada 3 skenario tergantung status akun saat ini:
   1) Belum aktif (pending)  -> kurangi langsung dari durationMs
   2) Sudah lewat expiresAt  -> sisa sudah 0, tidak ada yang bisa dikurangi
   3) Masih aktif berjalan   -> expiresAt & durationMs dikurangi langsung
   Beda sama extend.js: di sini WAJIB ada pengecekan sisa waktu yang berjalan
   (remaining) supaya subMs tidak pernah membuat sisa durasi jadi 0 ke bawah —
   kalau kebablasan, tolak dan kirim balik remainingMs biar client bisa
   nyaranin angka yang tepat. Logika ini HARUS selaras dengan
   confirmExtendDuration() di client, jangan disederhanakan. */

var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');

function msToLabel(ms) {
    if (ms === null || ms === undefined) return 'UNLIMITED';
    var DAY = 86400000;
    var units = [
        ['TAHUN', 365 * DAY], ['BULAN', 30 * DAY], ['MINGGU', 7 * DAY],
        ['HARI', DAY], ['JAM', 3600000], ['MENIT', 60000]
    ];
    for (var i = 0; i < units.length; i++) {
        if (ms >= units[i][1] && ms % units[i][1] === 0) {
            return (ms / units[i][1]) + ' ' + units[i][0];
        }
    }
    return Math.max(1, Math.round(ms / DAY)) + ' HARI';
}

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};
    var targetId = typeof body.targetId === 'string' ? body.targetId : '';
    var subMs    = typeof body.subMs === 'number' ? body.subMs : 0;

    try { await firebaseAuth.requireAdmin(req); } catch (e) {
        res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
        return;
    }
    if (!targetId || subMs < 1) {
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
    if (target.durationMs === null || target.durationMs === undefined) {
        res.status(200).json({ ok: false, reason: 'unlimited' });
        return;
    }

    var now       = Date.now();
    var isExpired = target.expiresAt && now > target.expiresAt;
    var pending   = !target.activated || !target.expiresAt;
    var remaining = pending ? (target.durationMs || 0) : (isExpired ? 0 : target.expiresAt - now);

    if (remaining < 1) {
        res.status(200).json({ ok: false, reason: 'expired' });
        return;
    }
    if (subMs >= remaining) {
        res.status(200).json({ ok: false, reason: 'exceeds', remainingMs: remaining });
        return;
    }

    if (pending) {
        target.durationMs = target.durationMs - subMs;
    } else {
        target.expiresAt  = target.expiresAt - subMs;
        target.durationMs = target.durationMs - subMs;
    }
    target.durationLabel = msToLabel(target.durationMs);

    var ok = await db.saveAllAccounts(list);
    if (!ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    res.status(200).json({ ok: true, username: target.username });
};
