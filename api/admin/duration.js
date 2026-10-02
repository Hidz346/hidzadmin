/* TAMBAH atau KURANGI durasi satu akun dari modal "Atur Durasi" di
   admin.html (confirmExtendDuration()). Dua aksi itu dilayani satu endpoint
   supaya jumlah Serverless Function di paket Hobby tidak membengkak:

     { targetId, addMs }  -> tambah
     { targetId, subMs }  -> kurangi

   TAMBAH — 3 skenario tergantung status akun saat ini:
   1) Belum aktif (pending)  -> tambahkan ke durationMs, expiresAt tetap null
   2) Sudah lewat expiresAt  -> diperlakukan sama seperti pending, direset
      activated & expiresAt-nya (belum sungguhan expired sampai user login
      lagi), sisa dihitung dari durationMs
   3) Masih aktif berjalan   -> expiresAt & durationMs ditambah langsung

   KURANGI — 3 skenario juga:
   1) Belum aktif (pending)  -> kurangi langsung dari durationMs
   2) Sudah lewat expiresAt  -> sisa sudah 0, tidak ada yang bisa dikurangi
   3) Masih aktif berjalan   -> expiresAt & durationMs dikurangi langsung
   Di sisi ini WAJIB ada pengecekan sisa waktu yang berjalan (remaining)
   supaya subMs tidak pernah membuat sisa durasi jadi 0 ke bawah — kalau
   kebablasan, tolak dan kirim balik remainingMs biar client bisa nyaranin
   angka yang tepat.

   Logika ini HARUS selaras dengan confirmExtendDuration() di client,
   jangan disederhanakan. */

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
    var addMs    = typeof body.addMs === 'number' ? body.addMs : 0;
    var subMs    = typeof body.subMs === 'number' ? body.subMs : 0;

    try { await firebaseAuth.requireAdmin(req); } catch (e) {
        res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
        return;
    }

    /* Harus tepat satu dari addMs / subMs yang diisi */
    var adding = addMs >= 1;
    if (!targetId || adding === (subMs >= 1)) {
        res.status(200).json({ ok: false });
        return;
    }

    var out = await db.mutateAccounts(function (list) {
        var target = list.filter(function (u) { return u.id === targetId; })[0];
        if (!target) return { save: false, result: { ok: false, reason: 'not_found' } };
        if (db.isProtectedAccount(target)) return { save: false, result: { ok: false, reason: 'protected' } };
        if (target.durationMs === null || target.durationMs === undefined) {
            return { save: false, result: { ok: false, reason: 'unlimited' } };
        }

        var now       = Date.now();
        var isExpired = target.expiresAt && now > target.expiresAt;
        var pending   = !target.activated || !target.expiresAt;

        if (adding) {
            if (pending) {
                target.durationMs = (target.durationMs || 0) + addMs;
            } else if (isExpired) {
                target.activated  = false;
                target.expiresAt  = null;
                target.durationMs = (target.durationMs || 0) + addMs;
            } else {
                target.expiresAt  = target.expiresAt + addMs;
                target.durationMs = (target.durationMs || 0) + addMs;
            }
        } else {
            var remaining = pending ? (target.durationMs || 0) : (isExpired ? 0 : target.expiresAt - now);
            if (remaining < 1) return { save: false, result: { ok: false, reason: 'expired' } };
            if (subMs >= remaining) {
                return { save: false, result: { ok: false, reason: 'exceeds', remainingMs: remaining } };
            }

            if (!pending) target.expiresAt = target.expiresAt - subMs;
            target.durationMs = target.durationMs - subMs;
        }
        target.durationLabel = msToLabel(target.durationMs);

        var fresh = {};
        Object.keys(target).forEach(function (k) { if (k !== 'password') fresh[k] = target[k]; });
        return { save: true, result: { ok: true, username: target.username, user: fresh } };
    });

    if (!out.ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }
    res.status(200).json(out.result);
};
