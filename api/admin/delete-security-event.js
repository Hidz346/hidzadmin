/* Hapus satu entri "ancaman terdeteksi" dari hidz_security_events.
   Mirip unblock-ip.js, cuma target node-nya beda. */
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
    var body = req.body || {};
    var id = typeof body.id === 'string' ? body.id.trim() : '';
    /* ID event dibuat dari Date.now() + '_' + random base36, jadi cukup
       divalidasi longgar: huruf/angka/underscore saja. */
    if (!id || id.length > 64 || !/^[a-zA-Z0-9_]+$/.test(id)) {
        res.status(400).json({ ok: false });
        return;
    }
    var ok = await db.deletePath('hidz_security_events/' + id);
    res.status(200).json({ ok: ok });
};
