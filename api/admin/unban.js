/* Replika persis unbanUser() di admin.html — kalau device yang login lebih
   banyak dari deviceLimit, yang paling awal login (loginAt terkecil) yang
   dipertahankan, sisanya ditandai diblokir. Status banned selalu dihapus
   di akhir supaya device yang sah langsung normal lagi. */

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
    var deviceLimit = target ? (target.deviceLimit === 0 ? 0 : (target.deviceLimit || 1)) : 1;

    var sessions = await db.fetchPath('hidz_sessions/' + targetId);
    var blockedCount = 0;

    if (sessions && typeof sessions === 'object' && Object.keys(sessions).length > 0) {
        var sessionList = Object.keys(sessions).map(function (devId) {
            return { deviceId: devId, loginAt: sessions[devId].loginAt || 0 };
        });
        sessionList.sort(function (a, b) { return a.loginAt - b.loginAt; });

        var keepCount    = deviceLimit === 0 ? sessionList.length : deviceLimit;
        var blockDevices = sessionList.slice(keepCount);
        blockedCount = blockDevices.length;

        for (var i = 0; i < blockDevices.length; i++) {
            var dev = blockDevices[i];
            await db.deletePath('hidz_sessions/' + targetId + '/' + dev.deviceId);
            await db.setPath('hidz_blocked_devices/' + targetId + '/' + dev.deviceId, {
                blockedAt: Date.now(),
                reason:    'Melebihi batas maksimum perangkat'
            });
        }
    }

    await db.deletePath('hidz_banned/' + targetId);
    res.status(200).json({ ok: true, blockedCount: blockedCount });
};
