/* Replika persis forceReloginAll() di admin.html — berlaku utk SEMUA akun
   termasuk admin_hidz_protected (tidak dikecualikan, sama seperti versi
   lama):
   - Durasi UNLIMITED       -> langsung ditandai belum aktif
   - Durasi terbatas & aktif -> di-"pause": sisa waktu (expiresAt-sekarang)
     disimpan balik ke durationMs, BUKAN direset ke penuh
   - Sudah pending/expired  -> dibiarkan apa adanya
   logoutAt diisi waktu yang sama untuk semua akun, loginAt tidak disentuh. */

var db = require('../_lib/db');

module.exports = async function (req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};
    var username = typeof body.username === 'string' ? body.username : '';
    var password = typeof body.password === 'string' ? body.password : '';

    if (!db.verifyAdmin(username, password)) {
        res.status(200).json({ ok: false });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var now = Date.now();
    list.forEach(function (u) {
        var isUnlimitedDur = !(typeof u.durationMs === 'number' && u.durationMs > 0);
        var isExpired = u.expiresAt && now > u.expiresAt;
        if (isUnlimitedDur) {
            u.activated = false;
        } else if (u.activated === true && u.expiresAt && !isExpired) {
            u.durationMs = Math.max(0, u.expiresAt - now);
            u.expiresAt  = null;
            u.activated  = false;
        }
        u.logoutAt  = now;
        u.loggedOut = false;
    });

    var ok = await db.saveAllAccounts(list);

    /* Bersihkan sesi/banned/blocked semua akun apa pun hasil di atas, sama
       seperti versi lama — supaya sisa data sesi lama gak bikin akun yang
       baru saja direset kena "AKUN DIBLOKIR" secara keliru. */
    await Promise.all(list.map(function (u) { return db.removeAccountTraces(u.id); }));
    await db.setPath('hidz_force_relogin', now);

    res.status(200).json({ ok: !!ok });
};
