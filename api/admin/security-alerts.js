/* Read-only security dashboard for the administrator. */
var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false });
        return;
    }

    var body = req.body || {};
    try { await firebaseAuth.requireAdmin(req); } catch (e) {
        res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
        return;
    }


    var events = await db.fetchPath('hidz_security_events');
    var blocks = await db.fetchPath('hidz_security_ip_blocks');

    function vals(x) {
        if (!x || typeof x !== 'object') return [];
        return Object.keys(x).map(function (k) {
            return Object.assign({ id: k }, x[k] || {});
        });
    }

    /* CSP reports are deliberately stored elsewhere. Filter legacy CSP
       records too, so old noise disappears from the monitor immediately. */
    events = vals(events).filter(function (x) {
        return String(x.reason || '').toLowerCase() !== 'csp violation report';
    }).sort(function (a, b) {
        return (b.attemptAt || 0) - (a.attemptAt || 0);
    }).slice(0, 50);

    blocks = vals(blocks).filter(function (x) {
        return x.blocked && Number(x.blockedUntil || 0) > Date.now();
    }).sort(function (a, b) {
        return (b.blockedAt || 0) - (a.blockedAt || 0);
    });

    var cspReports = await db.fetchPath('hidz_security_csp_reports');
    var cspCount = 0;
    if (cspReports && typeof cspReports === 'object') {
        cspCount = Object.keys(cspReports).length;
    }

    res.status(200).json({
        ok: true,
        events: events,
        blocks: blocks,
        cspReports: cspCount
    });
};
