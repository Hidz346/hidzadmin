/* Dipanggil hidzproject.html tiap beberapa detik selama user login, buat
   nanya "akun aku masih ada/belum expired?" — TANPA perlu narik seluruh
   daftar akun ke browser kayak listener real-time yang lama. Server yang
   buka datanya (pakai Database Secret), browser cuma dapat jawaban
   valid: true/false. */

var db = require('./_lib/db');

var securityGuard = require('./_lib/security');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ valid: true });
        return;
    }

    var body = req.body || {};
    var id   = typeof body.id === 'string' ? body.id : '';
    var role = typeof body.role === 'string' ? body.role : '';

    if (!id) {
        res.status(200).json({ valid: true });
        return;
    }

    /* Admin gak pernah tercatat di hidz_access_db lagi, jadi gak perlu dicek
       ke Firebase — validitasnya cuma bergantung pada ADMIN_USERNAME/
       ADMIN_PASSWORD yang sudah dicek waktu login. */
    if (role === 'admin') {
        res.status(200).json({ valid: true });
        return;
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        /* Secret belum diset / server bermasalah -> jangan asal logout orang */
        res.status(200).json({ valid: true });
        return;
    }

    var found = null;
    for (var i = 0; i < list.length; i++) {
        if (list[i].id === id) { found = list[i]; break; }
    }

    if (!found) {
        res.status(200).json({ valid: false, reason: 'deleted' });
        return;
    }
    if (found.expiresAt && Date.now() > found.expiresAt) {
        res.status(200).json({ valid: false, reason: 'expired' });
        return;
    }

    res.status(200).json({ valid: true });
};
