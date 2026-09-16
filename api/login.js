/* Login terpusat untuk hidzproject.html — menggantikan cara lama yang
   nyocokin username/password ke daftar akun yang di-download penuh ke
   browser (itu sebabnya seluruh isi hidz_access_db, termasuk password
   semua akun VIP/USER, ikut kebaca siapa pun yang buka DevTools begitu
   halaman login dibuka — bahkan sebelum sempat login sama sekali).

   Sekarang:
   - Kredensial ADMIN dicek dari Environment Variable (gak pernah di Firebase).
   - Kredensial VIP/USER dicek di sini, di server, pakai Firebase Database
     Secret (FIREBASE_DB_SECRET) — browser cuma dikirimin HASIL cocok/tidak
     plus data akun yang berhasil login, bukan seluruh daftarnya.
   - Percobaan gagal beruntun dicatat per-IP di server (bukan cuma di
     localStorage browser), jadi script yang nembak endpoint ini langsung
     tanpa lewat form login sama sekali tetap kena kunci. */

var db = require('./_lib/db');
var pw = require('./_lib/password');
var RATE_PATH = 'hidz_login_rate_limit';

var securityGuard = require('./_lib/security');
var firebaseAuth = require('./_lib/firebase-auth');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var limit = await db.checkLoginRateLimit(RATE_PATH, req);
    if (limit.blocked) {
        res.status(200).json({ ok: false, locked: true, retryAfterSec: limit.retryAfterSec });
        return;
    }

    var body     = req.body || {};
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
        await db.clearLoginRateLimit(RATE_PATH, req);

        /* Ambil record akun admin yang sudah ada di hidz_access_db (kalau
           ada) — activated/loginAt/logoutAt/loggedOut yang dibalikin ke
           browser harus data ASLI dari database, bukan angka kosong yang
           di-hardcode. Soalnya _completeLogin() di hidzproject.html cuma
           mau nulis ulang activated:true & loggedOut:false pas login kalau
           dia lihat activated:false di respons ini. Kalau di-hardcode terus
           (activated selalu dianggap "sudah aktif"), maka begitu admin
           LOGOUT manual lewat halaman profil, activated:false yang
           kesimpen di Firebase gak akan PERNAH ketimpa balik jadi true
           lagi walau admin login ulang — akibatnya admin.html nyangkut
           terus nunjukin akun ini "Akun telah logout" selamanya, padahal
           di hidzproject.html sendiri adminnya udah login & pakai akun itu
           normal. */
        var adminRecord = null;
        try {
            var accounts = await db.fetchAllAccounts();
            if (accounts) {
                adminRecord = accounts.filter(function (u) { return u.id === 'admin_hidz_protected'; })[0] || null;
            }
        } catch (e) {}

        var adminToken;
        try { adminToken = await firebaseAuth.createCustomToken('admin_hidz_protected', { admin: true, role: 'admin' }); }
        catch (e) { res.status(503).json({ ok: false, error: true, code: 'FIREBASE_AUTH_CONFIG' }); return; }

        res.status(200).json({
            ok: true,
            firebaseToken: adminToken,
            account: {
                id:            'admin_hidz_protected',
                username:      username,
                role:          'admin',
                createdAt:     (adminRecord && adminRecord.createdAt) || Date.now(),
                expiresAt:     null,
                durationMs:    null,
                durationLabel: 'UNLIMITED',
                deviceLimit:   1,
                activated:     (adminRecord && adminRecord.activated === false) ? false : true,
                loginAt:       (adminRecord && adminRecord.loginAt) || null,
                logoutAt:      (adminRecord && adminRecord.logoutAt) || null,
                loggedOut:     !!(adminRecord && adminRecord.loggedOut)
            }
        });
        return;
    }

    /* -- Bukan admin -> cek akun VIP/USER lewat Database Secret -- */
    var list = await db.fetchAllAccounts();
    if (list === null) {
        res.status(200).json({ ok: false, error: true });
        return;
    }

    var found = null;
    for (var i = 0; i < list.length; i++) {
        /* Admin CUMA boleh lolos lewat env var di atas — sengaja dilewati di
           sini walau kebetulan masih ada record lama berrole admin nyangkut
           di database (mis. sisa sebelum dipindah ke env var), supaya
           password lama yang mungkin masih nempel di situ gak pernah lagi
           bisa dipakai buat masuk. */
        if (list[i].role === 'admin') continue;
        if (list[i].username.toLowerCase() === username.toLowerCase() && pw.verifyPassword(password, list[i].password)) {
            found = list[i];
            break;
        }
    }

    if (!found) {
        await db.registerLoginFail(RATE_PATH, req);
        res.status(200).json({ ok: false });
        return;
    }
    await db.clearLoginRateLimit(RATE_PATH, req);

    /* Password TIDAK ikut dikirim balik — browser yang minta login sudah
       tahu password itu sendiri (baru saja diketik), jadi gak perlu
       dikirim ulang lewat jaringan. durationMs WAJIB ikut dikirim karena
       dipakai buat hitung expiresAt begitu akun ini pertama kali login
       (lihat _completeLogin di hidzproject.html). */
    var userToken;
    try { userToken = await firebaseAuth.createCustomToken(found.id, { role: found.role || 'user' }); }
    catch (e) { res.status(503).json({ ok: false, error: true, code: 'FIREBASE_AUTH_CONFIG' }); return; }

    res.status(200).json({
        ok: true,
        firebaseToken: userToken,
        account: {
            id:            found.id,
            username:      found.username,
            role:          found.role || 'user',
            createdAt:     found.createdAt || Date.now(),
            createdBy:     found.createdBy || null,
            expiresAt:     found.expiresAt || null,
            durationMs:    (typeof found.durationMs === 'number') ? found.durationMs : null,
            durationLabel: found.durationLabel || 'UNLIMITED',
            deviceLimit:   found.deviceLimit || 1,
            activated:     found.activated,
            logoutAt:      found.logoutAt || null
        }
    });
};
