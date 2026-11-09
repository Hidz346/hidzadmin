var db = require('../../../lib/db');
var securityGuard = require('../../../lib/security');
var firebaseAuth = require('../../../lib/firebase-auth');
var push = require('../../../lib/push');

function msToLabel(ms) {
    if (ms === null || ms === undefined) return 'UNLIMITED';
    var DAY = 86400000;
    var units = [
        ['TAHUN', 365 * DAY], ['BULAN', 30 * DAY], ['MINGGU', 7 * DAY],
        ['HARI', DAY], ['JAM', 3600000], ['MENIT', 60000]
    ];
    for (var i = 0; i < units.length; i++) {
        if (ms >= units[i][1] && ms % units[i][1] === 0) {
            return (ms / units[i][1]) + ' ' + units[i][0];
        }
    }
    return Math.max(1, Math.round(ms / DAY)) + ' HARI';
}

/* Batas wajar durasi VIP yang diberikan manual dari panel (10 tahun). */
var MAX_UPGRADE_MS = 10 * 365 * 86400000;

/* Naikkan akun USER jadi VIP dari panel admin tanpa membuat akun baru. Aturannya sama dengan
   pembelian paket di HidzProject: masa VIP yang baru menggantikan sisa durasi USER dan dihitung
   dari sekarang. Akun yang belum pernah login atau sudah kedaluwarsa tetap menunggu login berikutnya
   sebelum jamnya berjalan, sama seperti akun baru. */
async function upgradeToVip(targetId, durationMs, res) {
    if (!targetId || typeof durationMs !== 'number' || !isFinite(durationMs) ||
        durationMs < 1000 || durationMs > MAX_UPGRADE_MS) {
        res.status(200).json({ ok: false, reason: 'invalid' });
        return;
    }
    durationMs = Math.round(durationMs);

    var maint = await db.fetchPath('hidz_maintenance_mode');
    var maintActive = !!(maint && maint.active === true);

    var out = await db.mutateAccounts(function (list) {
        var target = list.filter(function (u) { return u.id === targetId; })[0];
        if (!target) return { save: false, result: { ok: false, reason: 'not_found' } };
        if (db.isProtectedAccount(target)) return { save: false, result: { ok: false, reason: 'protected' } };
        if (target.role === 'vip') return { save: false, result: { ok: false, reason: 'already_vip' } };

        var now      = Date.now();
        var hasPause = (typeof target.pausedRemainingMs === 'number' && target.pausedRemainingMs > 0) ||
                       !!(maintActive && maint.startedAt && target.expiresAt > maint.startedAt);
        var expired  = target.activated !== false && !hasPause && !!target.expiresAt &&
                       target.durationMs !== null && target.durationMs !== undefined && now > target.expiresAt;

        target.role = 'vip';
        target.durationMs = durationMs;
        if (target.activated === false || expired) {
            target.activated = false;
            target.expiresAt = null;
            delete target.pausedRemainingMs;
            delete target.pausedAt;
        } else {
            target.activated = true;
            target.loggedOut = false;
            target.expiresAt = now + durationMs;
            if (maintActive) {
                target.pausedRemainingMs = durationMs;
                target.pausedAt = (maint && maint.startedAt) || now;
            } else {
                delete target.pausedRemainingMs;
                delete target.pausedAt;
            }
        }
        target.durationLabel = msToLabel(durationMs);

        var fresh = {};
        Object.keys(target).forEach(function (k) { if (k !== 'password') fresh[k] = target[k]; });
        return { save: true, result: { ok: true, username: target.username, user: fresh } };
    });

    if (!out.ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }
    if (out.result && out.result.ok) {
        await push.notifyUser(targetId, {
            type:  'role_upgraded',
            title: 'Akun Di-upgrade ke VIP',
            body:  'Akunmu sekarang VIP selama ' + push.describeDuration(durationMs) + '. Fitur VIP sudah bisa langsung dipakai.'
        });
    }
    res.status(200).json(out.result);
}

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};
    var targetId = typeof body.targetId === 'string' ? body.targetId : '';
    var addMs    = typeof body.addMs === 'number' ? body.addMs : 0;
    var subMs    = typeof body.subMs === 'number' ? body.subMs : 0;

    try { await firebaseAuth.requireAdmin(req); } catch (e) {
        res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
        return;
    }

    /* Upgrade USER -> VIP dilayani di endpoint ini juga (lewat /api/admin/upgrade-vip), bukan file
       api/admin/ tersendiri, supaya jumlah Serverless Function di paket Hobby tidak bertambah. */
    if (req.query && req.query.action === 'upgrade') {
        await upgradeToVip(targetId, body.durationMs, res);
        return;
    }

    var adding = addMs >= 1;
    if (!targetId || adding === (subMs >= 1)) {
        res.status(200).json({ ok: false });
        return;
    }

    var maint = await db.fetchPath('hidz_maintenance_mode');
    var maintActive = !!(maint && maint.active === true);

    var out = await db.mutateAccounts(function (list) {
        var target = list.filter(function (u) { return u.id === targetId; })[0];
        if (!target) return { save: false, result: { ok: false, reason: 'not_found' } };
        if (db.isProtectedAccount(target)) return { save: false, result: { ok: false, reason: 'protected' } };
        if (target.durationMs === null || target.durationMs === undefined) {
            return { save: false, result: { ok: false, reason: 'unlimited' } };
        }

        var now       = Date.now();
        var pending   = !target.activated || !target.expiresAt;
        var hasPause  = !pending && ((typeof target.pausedRemainingMs === 'number' && target.pausedRemainingMs > 0) || (maintActive && maint.startedAt && target.expiresAt > maint.startedAt));
        var pausedRem = hasPause
            ? ((typeof target.pausedRemainingMs === 'number' && target.pausedRemainingMs > 0) ? target.pausedRemainingMs : Math.max(0, target.expiresAt - maint.startedAt))
            : 0;
        var isExpired = !pending && !hasPause && target.expiresAt && now > target.expiresAt;

        if (adding) {
            if (pending) {
                target.durationMs = (target.durationMs || 0) + addMs;
            } else if (isExpired) {
                target.activated  = false;
                target.expiresAt  = null;
                delete target.pausedRemainingMs;
                delete target.pausedAt;
                target.durationMs = (target.durationMs || 0) + addMs;
            } else {
                if (hasPause) {
                    target.pausedRemainingMs = pausedRem + addMs;
                    if (!target.pausedAt) target.pausedAt = (maint && maint.startedAt) || now;
                }
                target.expiresAt  = target.expiresAt + addMs;
                target.durationMs = (target.durationMs || 0) + addMs;
            }
        } else {
            var remaining = pending ? (target.durationMs || 0) : (hasPause ? pausedRem : (isExpired ? 0 : target.expiresAt - now));
            if (remaining < 1) return { save: false, result: { ok: false, reason: 'expired' } };
            if (subMs >= remaining) {
                return { save: false, result: { ok: false, reason: 'exceeds', remainingMs: remaining } };
            }

            if (!pending) {
                if (hasPause) {
                    target.pausedRemainingMs = pausedRem - subMs;
                    if (!target.pausedAt) target.pausedAt = (maint && maint.startedAt) || now;
                }
                target.expiresAt = target.expiresAt - subMs;
            }
            target.durationMs = target.durationMs - subMs;
        }
        target.durationLabel = msToLabel(target.durationMs);

        var fresh = {};
        Object.keys(target).forEach(function (k) { if (k !== 'password') fresh[k] = target[k]; });
        return { save: true, result: { ok: true, username: target.username, user: fresh } };
    });

    if (!out.ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    if (adding && out.result && out.result.ok) {
        await push.notifyUser(targetId, {
            type:  'duration_added',
            title: 'Durasi Akun Ditambah',
            body:  'Durasi akunmu bertambah ' + push.describeDuration(addMs) + '.'
        });
    }
    res.status(200).json(out.result);
};
