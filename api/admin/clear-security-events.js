/* Kosongkan seluruh riwayat "ancaman terdeteksi" (hidz_security_events)
   sekaligus. TIDAK menyentuh hidz_security_ip_blocks — IP yang lagi
   diblokir tetap diblokir, ini cuma bersihin catatan/riwayatnya. */
var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false });
        return;
    }
    try {
        await firebaseAuth.requireAdmin(req);
    } catch (e) {
        res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
        return;
    }
    var ok = await db.deletePath('hidz_security_events');
    res.status(200).json({ ok: ok });
};
