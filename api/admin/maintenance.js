/* Semua perubahan mode maintenance dari panel Site Control lewat sini. */

var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');
var push = require('../_lib/push');
var projectNew = require('../_lib/project-new');
var adminVipVouchers = require('../_lib/admin-vip-vouchers');

var MREF = 'hidz_maintenance_mode';
var DEFAULT_DURATION_MS = 24 * 3600000;
var FALLBACK_START_MS   = 3600000;
var MAX_DURATION_MS     = 20 * 365 * 86400000;

function toProgress(value, fallback) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return Math.min(100, Math.max(0, n));
}

function remainingMs(node) {
    if (!node || node.active !== true) return null;
    if (node.durationMs === 0) return Infinity;
    var dur = (typeof node.durationMs === 'number' && node.durationMs > 0)
        ? node.durationMs : DEFAULT_DURATION_MS;
    var left = (node.startedAt || Date.now()) + dur - Date.now();
    return left > 0 ? left : 0;
}

function fail(res, reason, extra) {
    res.status(200).json(Object.assign({ ok: false, reason: reason }, extra || {}));
}

/* Bekukan sisa durasi semua akun aktif (kecuali UNLIMITED & yang belum login) */
async function freezeActiveAccountDurations(now) {
    await db.mutateAccounts(function (list) {
        var changed = false;
        list.forEach(function (u) {
            if (!u || db.isProtectedAccount(u)) return;
            if (u.durationMs === null || u.durationMs === undefined) return;
            if (u.activated === false || !u.expiresAt) return;
            if (typeof u.pausedRemainingMs === 'number' && u.pausedRemainingMs > 0) return;
            var rem = u.expiresAt - now;
            if (rem > 0) {
                u.pausedRemainingMs = rem;
                u.pausedAt = now;
                changed = true;
            }
        });
        return { save: changed, list: list };
    });
}

/* Lanjutkan kembali durasi akun yang dibekukan saat maintenance berakhir */
async function resumeFrozenAccountDurations(now, maintStartedAt) {
    await db.mutateAccounts(function (list) {
        var changed = false;
        list.forEach(function (u) {
            if (!u || db.isProtectedAccount(u)) return;
            if (u.durationMs === null || u.durationMs === undefined) return;
            if (u.activated === false || !u.expiresAt) {
                if (u.pausedRemainingMs !== undefined || u.pausedAt !== undefined) {
                    delete u.pausedRemainingMs;
                    delete u.pausedAt;
                    changed = true;
                }
                return;
            }
            if (typeof u.pausedRemainingMs === 'number' && u.pausedRemainingMs > 0) {
                u.expiresAt = now + u.pausedRemainingMs;
                delete u.pausedRemainingMs;
                delete u.pausedAt;
                changed = true;
            } else if (maintStartedAt && u.expiresAt > maintStartedAt) {
                var freezeStart = (typeof u.pausedAt === 'number') ? u.pausedAt : maintStartedAt;
                var pausedDur = Math.max(0, now - freezeStart);
                if (pausedDur > 0) {
                    u.expiresAt = u.expiresAt + pausedDur;
                    changed = true;
                }
                delete u.pausedRemainingMs;
                delete u.pausedAt;
            }
        });
        return { save: changed, list: list };
    });
}

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    try { await firebaseAuth.requireAdmin(req); } catch (e) {
        res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
        return;
    }

    var body   = req.body || {};
    var vipAdminAction = (req.query && req.query.vipAdminAction) || body.vipAdminAction || '';
    if (vipAdminAction) { await adminVipVouchers.handleAdminAction(String(vipAdminAction), body, res); return; }
    var action = typeof body.action === 'string' ? body.action : '';
    var now    = Date.now();

    if (action === 'project-new') {
        await projectNew.run(body, res);
        return;
    }

    if (action === 'notif-list') {
        res.status(200).json({ ok: true, items: await push.listHistory() });
        return;
    }

    if (action === 'notif-delete') {
        var removed = await push.removeHistory(body.id);
        if (removed === null) { fail(res, 'invalid'); return; }
        if (!removed)         { res.status(200).json({ ok: false, error: true }); return; }
        res.status(200).json({ ok: true, retracted: removed.retracted });
        return;
    }

    var current = await db.fetchPath(MREF);
    var knownProgress = (current && typeof current.progress === 'number') ? current.progress : 0;

    if (action === 'on') {
        var startMs = (typeof body.durationMs === 'number' && body.durationMs >= 0)
            ? Math.floor(body.durationMs) : FALLBACK_START_MS;
        if (startMs > MAX_DURATION_MS) { fail(res, 'too_long'); return; }

        var onData = {
            active:     true,
            progress:   toProgress(body.progress, knownProgress),
            startedAt:  now,
            durationMs: startMs
        };
        if (!(await db.setPath(MREF, onData))) { res.status(200).json({ ok: false, error: true }); return; }

        await freezeActiveAccountDurations(now);

        await push.broadcast({
            type:  'maintenance',
            title: 'Maintenance HidzProject',
            body:  'Website sedang dalam perbaikan' +
                   (startMs > 0 ? ', estimasi ' + push.describeDuration(startMs) : '') +
                   '. Akses dibuka lagi setelah selesai.'
        }, 'hidz-maintenance');
        res.status(200).json({ ok: true, data: onData });
        return;
    }

    if (action === 'off') {
        var offData = { active: false, progress: toProgress(body.progress, knownProgress) };
        if (!(await db.setPath(MREF, offData))) { res.status(200).json({ ok: false, error: true }); return; }

        var maintStartedAt = (current && typeof current.startedAt === 'number') ? current.startedAt : null;
        await resumeFrozenAccountDurations(now, maintStartedAt);

        res.status(200).json({ ok: true, data: offData });
        return;
    }

    if (action === 'progress') {
        var progress = toProgress(body.progress, null);
        if (progress === null) { fail(res, 'invalid'); return; }
        if (!(await db.updatePath(MREF, { progress: progress }))) { res.status(200).json({ ok: false, error: true }); return; }
        res.status(200).json({ ok: true, data: Object.assign({}, current || {}, { progress: progress }) });
        return;
    }

    if (action === 'update') {
        if (!current || current.active !== true) { fail(res, 'inactive'); return; }

        var payload;
        if (body.unlimited === true) {
            payload = { startedAt: now, durationMs: 0 };
        } else {
            var ms = (typeof body.ms === 'number') ? Math.floor(body.ms) : 0;
            if (ms < 1) { fail(res, 'invalid'); return; }

            var remain = remainingMs(current);
            if (remain === Infinity) { fail(res, 'unlimited_current'); return; }

            if (body.mode === 'sub') {
                if (remain === null || remain < 1) { fail(res, 'expired'); return; }
                if (ms >= remain) { fail(res, 'exceeds', { remainingMs: remain }); return; }
                payload = { startedAt: now, durationMs: remain - ms };
            } else {
                var next = (remain === null ? 0 : remain) + ms;
                if (next > MAX_DURATION_MS) { fail(res, 'too_long'); return; }
                payload = { startedAt: now, durationMs: next };
            }
        }

        if (!(await db.updatePath(MREF, payload))) { res.status(200).json({ ok: false, error: true }); return; }
        res.status(200).json({ ok: true, data: Object.assign({}, current, payload) });
        return;
    }

    fail(res, 'invalid');
};
