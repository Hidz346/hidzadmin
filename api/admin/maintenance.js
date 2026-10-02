/* Semua perubahan mode maintenance dari panel Site Control lewat sini.

   Dulu tombol ON/MAINTENANCE, UPDATE MAINTENANCE, dan slider progress menulis
   ke Firebase langsung dari browser (.set()/.update()). Penulisan dari browser
   itu yang ditolak database — muncul toast "Gagal update mode!" dan slider
   progress balik sendiri ke angka lama. Sekarang penulisannya dilakukan di
   server memakai Database Secret yang sama dengan endpoint kelola akun, dan
   identitas admin diverifikasi lewat Firebase ID token seperti endpoint lain.

   Struktur node 'hidz_maintenance_mode' TIDAK diubah, jadi halaman maintenance
   di HidzProject tetap membaca field yang sama: active, progress, startedAt,
   durationMs (0 = UNLIMITED).

   action:
   - on       -> nyalakan MAINTENANCE, durasi dihitung dari sekarang
   - off      -> kembali ONLINE
   - update   -> tambah/kurangi dari SISA waktu yang sedang berjalan, atau
                 langsung ubah ke UNLIMITED (sisa dihitung di server, bukan di
                 browser, supaya tidak terpengaruh jam perangkat admin)
   - progress -> ubah persentase progress perbaikan saja */

var db = require('../_lib/db');
var securityGuard = require('../_lib/security');
var firebaseAuth = require('../_lib/firebase-auth');

var MREF = 'hidz_maintenance_mode';
var DEFAULT_DURATION_MS = 24 * 3600000;       /* sama seperti halaman maintenance user */
var FALLBACK_START_MS   = 3600000;            /* kolom durasi kosong -> 1 jam */
var MAX_DURATION_MS     = 20 * 365 * 86400000;

function toProgress(value, fallback) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return Math.min(100, Math.max(0, n));
}

/* null = tidak aktif, Infinity = UNLIMITED, 0 = waktu habis */
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
    var action = typeof body.action === 'string' ? body.action : '';
    var now    = Date.now();

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
        res.status(200).json({ ok: true, data: onData });
        return;
    }

    if (action === 'off') {
        var offData = { active: false, progress: toProgress(body.progress, knownProgress) };
        if (!(await db.setPath(MREF, offData))) { res.status(200).json({ ok: false, error: true }); return; }
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
