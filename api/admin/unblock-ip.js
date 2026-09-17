var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');
var crypto = require('crypto');

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
    var ip = typeof body.ip === 'string' ? body.ip.trim() : '';
    if (!ip || ip.length > 64) {
        res.status(400).json({ ok: false });
        return;
    }
    var key = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 48);
    var ok = await db.deletePath('hidz_security_ip_blocks/' + key);
    res.status(200).json({ ok: ok });
};
