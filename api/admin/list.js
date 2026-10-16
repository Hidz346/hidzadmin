var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');

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

    var now = Date.now();
    var maint = await db.fetchPath('hidz_maintenance_mode');
    var maintActive = !!(maint && maint.active === true);
    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    /* Sinkronkan otomatis jika ada akun yang belum ter-freeze saat maintenance aktif
       atau belum ter-unfreeze saat maintenance sudah nonaktif */
    var needSync = false;
    for (var i = 0; i < list.length; i++) {
        var acc = list[i];
        if (!acc || db.isProtectedAccount(acc)) continue;
        if (acc.durationMs === null || acc.durationMs === undefined) continue;
        if (acc.activated === false || !acc.expiresAt) continue;
        if (maintActive) {
            var refTime = (maint && typeof maint.startedAt === 'number') ? maint.startedAt : now;
            if (typeof acc.pausedRemainingMs !== 'number' && acc.expiresAt > refTime) {
                needSync = true;
                break;
            }
        } else if (typeof acc.pausedRemainingMs === 'number' && acc.pausedRemainingMs > 0) {
            needSync = true;
            break;
        }
    }

    if (needSync) {
        var mut = await db.mutateAccounts(function (currList) {
            var changed = false;
            currList.forEach(function (u) {
                if (!u || db.isProtectedAccount(u)) return;
                if (u.durationMs === null || u.durationMs === undefined) return;
                if (u.activated === false || !u.expiresAt) return;
                if (maintActive) {
                    var refTs = (maint && typeof maint.startedAt === 'number') ? maint.startedAt : now;
                    if (typeof u.pausedRemainingMs !== 'number' && u.expiresAt > refTs) {
                        u.pausedRemainingMs = u.expiresAt - refTs;
                        u.pausedAt = refTs;
                        changed = true;
                    }
                } else if (typeof u.pausedRemainingMs === 'number' && u.pausedRemainingMs > 0) {
                    u.expiresAt = now + u.pausedRemainingMs;
                    delete u.pausedRemainingMs;
                    delete u.pausedAt;
                    changed = true;
                }
            });
            return { save: changed, list: currList, result: currList };
        });
        if (mut.ok && mut.result) list = mut.result;
    }

    var sanitizedList = list.map(function (u) {
        var copy = {};
        Object.keys(u).forEach(function (k) { if (k !== 'password') copy[k] = u[k]; });
        return copy;
    });

    var bannedRaw = await db.fetchPath('hidz_banned');
    var banned = {};
    if (bannedRaw && typeof bannedRaw === 'object') {
        Object.keys(bannedRaw).forEach(function (uid) {
            if (bannedRaw[uid] && bannedRaw[uid].banned === true) banned[uid] = true;
        });
    }

    res.status(200).json({ ok: true, users: sanitizedList, banned: banned });
};
