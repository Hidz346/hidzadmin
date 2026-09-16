/* Dipanggil hidzproject.html saat user menekan tombol LOGOUT manual di
   halaman profil. Beda dari sekadar hapus sesi device: logout manual ini
   juga men-"pause" durasi akun — SISA waktu yang belum terpakai disimpan
   balik ke durationMs (bukan dibuang), supaya saat login lagi durasinya
   melanjutkan dari sisa waktu ini, bukan mengulang dari awal. Akun
   UNLIMITED cukup ditandai belum aktif tanpa hitungan durasi.

   Dulu logika "pause" ini jalan langsung dari browser lewat
   firebase.database().ref(DB_KEY).transaction(...), dengan jalur cadangan
   baca-lalu-tulis kalau transaction-nya gagal. Sekarang keduanya
   digantikan satu penulisan di server (pakai Database Secret) — hidz_
   access_db jadi tidak perlu lagi bisa ditulis langsung dari browser
   siapa pun. Kredensial dicocokkan ulang dulu sebelum apa pun diubah. */

var db = require('./_lib/db');
var pw = require('./_lib/password');

var securityGuard = require('./_lib/security');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body     = req.body || {};
    var id       = typeof body.id === 'string' ? body.id : '';
    var username = typeof body.username === 'string' ? body.username : '';
    var password = typeof body.password === 'string' ? body.password : '';
    var role     = typeof body.role === 'string' ? body.role : '';

    if (!id || !username || !password) {
        res.status(200).json({ ok: false });
        return;
    }

    if (role === 'admin') {
        var adminUser = process.env.ADMIN_USERNAME || '';
        var adminPass = process.env.ADMIN_PASSWORD || '';
        if (!adminUser || !adminPass ||
            username.toLowerCase() !== adminUser.toLowerCase() ||
            password !== adminPass) {
            res.status(200).json({ ok: false });
            return;
        }
    }

    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var u = null;
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) { u = list[i]; break; }
    }

    /* Record admin belum pernah tersimpan (mis. logout admin sebelum
       pernah punya record protected) — tidak ada apa pun yang perlu
       di-pause, cukup anggap berhasil. */
    if (!u) {
        res.status(200).json({ ok: true });
        return;
    }
    if ((u.username || '').toLowerCase() !== username.toLowerCase() || !pw.verifyPassword(password, u.password)) {
        res.status(200).json({ ok: false });
        return;
    }

    if (u.activated === true) {
        var now = Date.now();
        if (u.expiresAt) {
            u.durationMs = Math.max(0, u.expiresAt - now);
        }
        u.expiresAt = null;
        u.activated = false;
        u.logoutAt  = now;
        u.loggedOut = true;
        await db.saveAllAccounts(list);
    }

    res.status(200).json({ ok: true });
};
