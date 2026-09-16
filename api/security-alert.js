/* Client security-alert intake.
 * The browser never writes hidz_security_alerts directly anymore.
 * This endpoint validates the small alert payload, applies the application
 * security guard/rate limit, and writes with the server-side Firebase secret.
 */
var db = require('./_lib/db');
var securityGuard = require('./_lib/security');

function clean(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false });
        return;
    }

    var body = req.body || {};
    var event = {
        userId: clean(body.userId, 120),
        username: clean(body.username, 120),
        role: clean(body.role, 20) || 'user',
        deviceId: clean(body.deviceId, 180),
        attemptAt: Date.now(),
        reason: clean(body.reason, 180) || 'Security event',
        type: clean(body.type, 40) || 'security'
    };

    if (!['user', 'vip', 'admin'].includes(event.role)) event.role = 'user';

    var id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    var ok = await db.setPath('hidz_security_alerts/' + id, event);
    res.status(ok ? 200 : 503).json({ ok: ok });
};
