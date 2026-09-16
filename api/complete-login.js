/* Dipanggil hidzproject.html sesaat setelah /api/login berhasil, KHUSUS
   untuk akun yang activated:false (baru dibuat, baru logout manual, atau
   baru kena reset). Dulu langkah "aktifkan akun ini" ditulis langsung dari
   browser ke hidz_access_db lewat firebase.database().ref(DB_KEY)
   .transaction(...) — supaya transaction itu bisa jalan, rules Firebase
   utk hidz_access_db terpaksa dibiarkan bisa dibaca+ditulis siapa saja,
   termasuk yang gak pernah login sama sekali. Sekarang penulisannya
   dipindah ke sini (pakai Database Secret), jadi rules-nya bisa dikunci
   rapat tanpa mematikan fitur aktivasi ini. Kredensial yang dikirim
   dicocokkan ulang di server sebelum apa pun diubah — supaya endpoint ini
   gak bisa dipakai buat mengaktifkan akun orang lain cuma bermodal id. */

var db = require('./_lib/db');
var pw = require('./_lib/password');

/* Password sengaja TIDAK ikut dikirim balik ke browser — sama seperti
   /api/login, browser yang minta ini sudah tahu passwordnya sendiri (baru
   saja dipakai buat login), jadi gak perlu dikirim ulang lewat jaringan.
   Dulu di sini nilai u.password (mentah dari database) ikut dibalikin —
   waktu masih plaintext ini kebetulan gak masalah, tapi begitu password
   di-hash, nilai hash itu bakal ketimpa jadi "password" versi lokal di
   browser dan bikin permintaan logout berikutnya gagal cocok. */
function sanitize(u) {
    var copy = {};
    Object.keys(u).forEach(function (k) { if (k !== 'password') copy[k] = u[k]; });
    return copy;
}

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

    /* Kredensial admin dicek dari Environment Variable, bukan Firebase —
       konsisten dengan /api/login. */
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

    var idx = -1;
    for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === id) { idx = i; break; }
    }

    /* Record admin belum pernah tersimpan di hidz_access_db (mis. login
       admin pertama kali sebelum record protected-nya pernah dibuat) —
       tidak ada apa pun yang perlu diaktifkan di database, biarkan
       hidzproject.html lanjut pakai status aktif lokal seperti biasa. */
    if (idx === -1) {
        res.status(200).json({ ok: true, account: null });
        return;
    }

    var u = list[idx];
    if ((u.username || '').toLowerCase() !== username.toLowerCase() || !pw.verifyPassword(password, u.password)) {
        res.status(200).json({ ok: false });
        return;
    }

    /* Sudah aktif duluan (mis. dua tab dibuka bersamaan, tab pertama
       sudah lebih dulu mengaktifkan) — kembalikan apa adanya, tidak perlu
       menulis ulang. */
    if (u.activated !== false) {
        res.status(200).json({ ok: true, account: sanitize(u) });
        return;
    }

    var hasLimitedDur = (typeof u.durationMs === 'number' && u.durationMs > 0);
    var now = Date.now();
    u.activated = true;
    u.expiresAt = hasLimitedDur ? (now + u.durationMs) : null;
    u.loginAt   = now;
    u.loggedOut = false;

    var ok = await db.saveAllAccounts(list);
    if (!ok) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    res.status(200).json({ ok: true, account: sanitize(u) });
};
