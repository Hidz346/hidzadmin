/* Permintaan ganti username/password dari pengguna HIDZPROJECT yang masuk lewat Google atau GitHub.

   Pengguna yang lupa username/password mengajukan perubahan dari halaman login HIDZPROJECT. Pengajuan
   disimpan di Firebase (`hidz_credential_requests/<id>`, hanya bisa ditulis server) dan baru berlaku
   setelah admin menyetujuinya di sini:
   - disetujui -> username & password akun diganti, pengguna yang menunggu di HIDZPROJECT langsung
                  masuk otomatis (HIDZPROJECT yang membaca status ini)
   - ditolak   -> tidak ada yang berubah, pengguna diberi tahu beserta alasannya (kalau diisi)

   Dipanggil dari api/admin/list.js (daftar) dan api/admin/create.js (action: 'cred-decide'), sengaja bukan
   file endpoint sendiri supaya jumlah Serverless Function di paket Hobby tidak bertambah. Pemeriksaan
   admin (guard + token) sudah dilakukan pemanggilnya.

   Hash password baru dibuat HIDZPROJECT saat pengajuan dan tidak pernah dikirim ke browser admin. */

var db = require('./db');
var push = require('./push');

var REQUESTS_PATH = 'hidz_credential_requests';
var ID_PATTERN = /^r_[0-9]{10,16}_[0-9a-f]{8}$/;
var USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,20}$/;
var REASON_MAX = 140;
/* Yang sudah diputuskan tetap tampil sebentar sebagai riwayat; HIDZPROJECT yang membersihkannya. */
var HISTORY_LIMIT = 30;

function publicRecord(r) {
    return {
        id:          r.id,
        accountId:   r.accountId,
        username:    r.username,
        newUsername: r.newUsername,
        provider:    r.provider === 'github' ? 'github' : 'google',
        label:       typeof r.label === 'string' ? r.label : '',
        status:      r.status,
        createdAt:   r.createdAt || 0,
        decidedAt:   r.decidedAt || null,
        reason:      typeof r.reason === 'string' ? r.reason : null
    };
}

function isValidRecord(r, key) {
    return !!r && typeof r === 'object' && r.id === key && ID_PATTERN.test(key) &&
        typeof r.accountId === 'string' && typeof r.newUsername === 'string' &&
        (r.status === 'pending' || r.status === 'approved' || r.status === 'rejected');
}

/* Daftar untuk panel admin: yang menunggu di atas (terlama dulu, supaya yang paling lama menunggu
   dikerjakan duluan), lalu riwayat terbaru. Tanpa hash password dan tanpa claimHash. */
async function listAll() {
    var all = await db.fetchPath(REQUESTS_PATH);
    if (all === null) return null;
    if (!all || typeof all !== 'object') return [];
    var rows = Object.keys(all).filter(function (k) { return isValidRecord(all[k], k); }).map(function (k) { return publicRecord(all[k]); });
    var pending = rows.filter(function (r) { return r.status === 'pending'; }).sort(function (a, b) { return a.createdAt - b.createdAt; });
    var decided = rows.filter(function (r) { return r.status !== 'pending'; })
        .sort(function (a, b) { return (b.decidedAt || b.createdAt) - (a.decidedAt || a.createdAt); })
        .slice(0, HISTORY_LIMIT);
    return pending.concat(decided);
}

async function approve(rec) {
    var out = await db.mutateAccounts(function (list) {
        var target = list.filter(function (u) { return u.id === rec.accountId; })[0];
        if (!target) return { save: false, result: { ok: false, reason: 'account_missing' } };
        if (db.isProtectedAccount(target)) return { save: false, result: { ok: false, reason: 'protected' } };

        /* Pernah tersimpan tapi catatan permintaannya gagal diperbarui: cukup selesaikan catatannya. */
        if (target.username === rec.newUsername && target.password === rec.newPasswordHash) {
            return { save: false, result: { ok: true, changed: false } };
        }
        var wanted = rec.newUsername.toLowerCase();
        var adminName = String(process.env.ADMIN_USERNAME || '').toLowerCase();
        var clash = (adminName && wanted === adminName) || list.some(function (u) {
            return u.id !== target.id && String(u.username || '').toLowerCase() === wanted;
        });
        if (clash) return { save: false, result: { ok: false, reason: 'username_taken' } };

        target.username = rec.newUsername;
        target.password = rec.newPasswordHash;
        return { save: true, result: { ok: true, changed: true } };
    });
    if (!out.ok) return { ok: false, error: true };
    return out.result;
}

async function run(body, res) {
    var id = typeof body.requestId === 'string' ? body.requestId : '';
    var decision = body.decision === 'approve' ? 'approve' : (body.decision === 'reject' ? 'reject' : '');
    if (!ID_PATTERN.test(id) || !decision) {
        res.status(200).json({ ok: false });
        return;
    }

    var rec = await db.fetchPath(REQUESTS_PATH + '/' + id);
    if (!isValidRecord(rec, id)) { res.status(200).json({ ok: false, reason: 'not_found' }); return; }
    if (rec.status !== 'pending') { res.status(200).json({ ok: false, reason: 'already_decided', status: rec.status }); return; }

    var reason = '';
    if (decision === 'reject' && typeof body.reason === 'string') reason = body.reason.trim().slice(0, REASON_MAX);

    if (decision === 'approve') {
        /* Data permintaan ini ditulis server HIDZPROJECT; tetap diperiksa lagi sebelum menyentuh akun. */
        if (!USERNAME_PATTERN.test(rec.newUsername) || typeof rec.newPasswordHash !== 'string' || rec.newPasswordHash.indexOf('scrypt:') !== 0) {
            res.status(200).json({ ok: false, reason: 'invalid_request' });
            return;
        }
        var applied = await approve(rec);
        if (!applied.ok) { res.status(200).json(applied); return; }
    }

    var patch = { status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: Date.now(), reason: reason || null };
    if (!(await db.updatePath(REQUESTS_PATH + '/' + id, patch))) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    await push.notifyUser(rec.accountId, decision === 'approve'
        ? {
            type:  'credential_request',
            title: 'Perubahan Akun Disetujui',
            body:  'Username dan password baru akunmu sudah aktif. Pakai itu saat login berikutnya.'
        }
        : {
            type:  'credential_request',
            title: 'Perubahan Akun Ditolak',
            body:  reason ? 'Admin menolak perubahan username/password: ' + reason : 'Admin menolak perubahan username/password. Akunmu tidak berubah.'
        });

    res.status(200).json({ ok: true, status: patch.status, request: publicRecord(Object.assign({}, rec, patch)) });
}

module.exports = { listAll: listAll, run: run };
