/* Public intake for low-trust browser security notices.
 * It is intentionally rate-limited and writes only through the server-side
 * Firebase credential. It does not grant access to any protected database node.
 */
var crypto = require('crypto');
var db = require('./_lib/db');

function ip(req) {
    var h = req.headers || {};
    var raw = h['cf-connecting-ip'] || h['x-real-ip'] || h['x-forwarded-for'] || '';
    return String(raw).split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function key(req) {
    return crypto.createHash('sha256').update(ip(req)).digest('hex').slice(0, 48);
}
function text(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

module.exports = async function (req, res) {
    if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }

    var k = key(req);
    var path = 'hidz_security_rate_limit/admin_alert_' + k;
    var now = Date.now();
    var rec = await db.fetchPath(path);
    if (rec && Number(rec.windowStarted) && now - Number(rec.windowStarted) < 60000 && Number(rec.count || 0) >= 8) {
        res.status(429).json({ ok: false });
        return;
    }
    if (!rec || now - Number(rec.windowStarted || 0) >= 60000) rec = { windowStarted: now, count: 0 };
    rec.count = Number(rec.count || 0) + 1;
    await db.setPath(path, rec);

    var body = req.body || {};
    var role = text(body.role, 20) || 'admin';
    if (role !== 'admin' && role !== 'user' && role !== 'vip') role = 'user';

    var event = {
        userId: text(body.userId, 120),
        username: text(body.username, 120),
        role: role,
        deviceId: text(body.deviceId, 180),
        attemptAt: now,
        reason: text(body.reason, 180) || 'Security event',
        type: text(body.type, 40) || 'security',
        source: 'admin-client'
    };
    var id = now + '_' + Math.random().toString(36).slice(2, 8);
    var ok = await db.setPath('hidz_security_alerts/' + id, event);
    res.status(ok ? 200 : 503).json({ ok: ok });
};
