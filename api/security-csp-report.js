/* CSP reports are telemetry, not automatic attack evidence.
 * Keep them out of the security-alert stream so normal browser CSP noise
 * cannot make the administrator think an attack is happening.
 */
var db = require('./_lib/db');

module.exports = async function (req, res) {
    if (req.method !== 'POST') {
        res.status(204).end();
        return;
    }

    try {
        var body = req.body || {};
        var h = req.headers || {};
        var ip = String(
            h['cf-connecting-ip'] || h['x-real-ip'] || h['x-forwarded-for'] || ''
        ).split(',')[0].trim() || 'unknown';
        var now = Date.now();

        /* Separate node. HidzAdmin does not show this node as an attack event. */
        await db.setPath('hidz_security_csp_reports/' + (now + '_' + Math.random().toString(36).slice(2, 8)), {
            ip: ip,
            reportedAt: now,
            userAgent: String(h['user-agent'] || '').slice(0, 220),
            report: body
        });
    } catch (e) {
        /* Reporting must never break the site response. */
    }

    res.status(204).end();
};
