/* Login terpusat untuk hidzproject.html — menggantikan cara lama yang
   nyocokin username/password ke daftar akun yang di-download penuh ke
   browser (itu sebabnya seluruh isi hidz_access_db, termasuk password
   semua akun VIP/USER, ikut kebaca siapa pun yang buka DevTools begitu
   halaman login dibuka — bahkan sebelum sempat login sama sekali).

   Sekarang:
   - Kredensial ADMIN dicek dari Environment Variable (gak pernah di Firebase).
   - Kredensial VIP/USER dicek di sini, di server, pakai Firebase Database
     Secret (FIREBASE_DB_SECRET) — browser cuma dikirimin HASIL cocok/tidak
     plus data akun yang berhasil login, bukan seluruh daftarnya. */

var DB_URL = 'https://hidzproject-8f335-default-rtdb.asia-southeast1.firebasedatabase.app';

module.exports = async function (req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body = req.body || {};
    var username = typeof body.username === 'string' ? body.username.trim() : '';
    var password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
        res.status(200).json({ ok: false });
        return;
    }

    /* -- Cek admin dulu, gak perlu nyentuh Firebase sama sekali -- */
    var adminUser = process.env.ADMIN_USERNAME || '';
    var adminPass = process.env.ADMIN_PASSWORD || '';
    if (adminUser && adminPass &&
        username.toLowerCase() === adminUser.toLowerCase() &&
        password === adminPass) {
        res.status(200).json({
            ok: true,
            account: {
                id:            'admin_hidz_protected',
                username:      username,
                role:          'admin',
                createdAt:     Date.now(),
                expiresAt:     null,
                durationLabel: 'UNLIMITED',
                deviceLimit:   1,
                logoutAt:      null
            }
        });
        return;
    }

    /* -- Bukan admin -> cek akun VIP/USER lewat Database Secret -- */
    var secret = process.env.FIREBASE_DB_SECRET || '';
    if (!secret) {
        res.status(200).json({ ok: false });
        return;
    }

    try {
        var r = await fetch(DB_URL + '/hidz_access_db.json?auth=' + secret);
        var data = await r.json();

        var list = [];
        if (Array.isArray(data)) list = data.filter(function (u) { return u && u.username; });
        else if (data && typeof data === 'object') list = Object.values(data).filter(function (u) { return u && u.username; });

        var found = null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].username.toLowerCase() === username.toLowerCase() && list[i].password === password) {
                found = list[i];
                break;
            }
        }

        if (!found) {
            res.status(200).json({ ok: false });
            return;
        }

        /* Password TIDAK ikut dikirim balik — browser yang minta login sudah
           tahu password itu sendiri (baru saja diketik), jadi gak perlu
           dikirim ulang lewat jaringan. */
        res.status(200).json({
            ok: true,
            account: {
                id:            found.id,
                username:      found.username,
                role:          found.role || 'user',
                createdAt:     found.createdAt || Date.now(),
                expiresAt:     found.expiresAt || null,
                durationLabel: found.durationLabel || 'UNLIMITED',
                deviceLimit:   found.deviceLimit || 1,
                activated:     found.activated,
                logoutAt:      found.logoutAt || null
            }
        });
    } catch (e) {
        res.status(200).json({ ok: false, error: true });
    }
};
