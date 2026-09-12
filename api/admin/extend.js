/* Replika persis confirmExtendDuration() di admin.html — ada 3 skenario
   tergantung status akun saat ini:
   1) Belum aktif (pending)  -> tambahkan ke durationMs, expiresAt tetap null
   2) Sudah lewat expiresAt  -> diperlakukan sama seperti pending, direset
      activated & expiresAt-nya (belum sungguhan expired sampai user login
      lagi), sisa dihitung dari durationMs
   3) Masih aktif berjalan   -> expiresAt & durationMs ditambah langsung
   Logika ini HARUS sama persis dengan yang di client, jangan disederhanakan. */

var db = require('../_lib/db');

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
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};
    var username = typeof body.username === 'string' ? body.username : '';
    var password = typeof body.password === 'string' ? body.password : '';
    var targetId = typeof body.targetId === 'string' ? body.targetId : '';
    var addMs    = typeof body.addMs === 'number' ? body.addMs : 0;

    if (!db.verifyAdmin(username, password)) {
        res.status(200).json({ ok: false });
        return;
    }
    if (!targetId || addMs < 1) {
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
    if (target.durationMs === null || target.durationMs === undefined) {
        res.status(200).json({ ok: false, reason: 'unlimited' });
        return;
    }

    var now = Date.now();
    var isExpired = target.expiresAt && now > target.expiresAt;

    if (!target.activated || !target.expiresAt) {
        target.durationMs = (target.durationMs || 0) + addMs;
    } else if (isExpired) {
        target.activated  = false;
        target.expiresAt  = null;
        target.durationMs = (target.durationMs || 0) + addMs;
    } else {
        target.expiresAt  = target.expiresAt + addMs;
        target.durationMs = (target.durationMs || 0) + addMs;
    }
    target.durationLabel = msToLabel(target.durationMs);

    var ok = await db.saveAllAccounts(list);
    if (!ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    res.status(200).json({ ok: true, username: target.username });
};
