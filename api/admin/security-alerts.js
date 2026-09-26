/* Read-only security dashboard for the administrator. */
var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');
var security = require('../_lib/security');

var PAGE_SIZE_DEFAULT = 20;
var PAGE_SIZE_MAX = 100;

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

    var offset = Math.max(0, parseInt(body.offset, 10) || 0);
    var limit  = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(body.limit, 10) || PAGE_SIZE_DEFAULT));

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
    }).map(function (x) {
        if (x.endpoint) x.endpoint = security.sanitizeEndpoint(x.endpoint);
        /* Setiap event di sini SELALU tercatat pas request-nya diblokir
           (lihat writeEvent() yang cuma dipanggil dari blockIp()) — jadi
           "status" nyatanya adalah apakah blokir IP itu masih aktif
           sekarang atau sudah kadaluarsa, dihitung dari blockedUntil. */
        x.status = (Number(x.blockedUntil || 0) > Date.now()) ? 'blocked_active' : 'blocked_expired';
        return x;
    }).sort(function (a, b) {
        return (b.attemptAt || 0) - (a.attemptAt || 0);
    });

    var eventsTotal = events.length;
    events = events.slice(offset, offset + limit);

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
        eventsTotal: eventsTotal,
        eventsOffset: offset,
        eventsLimit: limit,
        blocks: blocks,
        cspReports: cspCount
    });
};
