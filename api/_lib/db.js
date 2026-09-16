/* Helper bersama buat semua endpoint di /api yang perlu baca/tulis
   database akun (hidz_access_db). Satu tempat saja yang tahu cara ngomong
   ke Firebase pakai Database Secret, biar gak ditulis ulang di tiap file.
   Nama folder diawali underscore supaya Vercel gak menganggapnya sebagai
   endpoint sendiri — ini murni file bantu. */

var DB_URL = 'https://hidzproject-8f335-default-rtdb.asia-southeast1.firebasedatabase.app';

function authQS() {
    var secret = process.env.FIREBASE_DB_SECRET || '';
    return secret ? ('?auth=' + secret) : null;
}

/* Ambil nilai mentah dari path mana pun di database. null = secret belum
   diset / gagal konek. */
async function fetchPath(path) {
    var qs = authQS();
    if (!qs) return null;
    try {
        var r = await fetch(DB_URL + '/' + path + '.json' + qs);
        return await r.json();
    } catch (e) {
        return null;
    }
}

/* Timpa nilai di path mana pun. */
async function setPath(path, value) {
    var qs = authQS();
    if (!qs) return false;
    try {
        var r = await fetch(DB_URL + '/' + path + '.json' + qs, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value)
        });
        return r.ok;
    } catch (e) {
        return false;
    }
}

/* Hapus path mana pun. */
async function deletePath(path) {
    var qs = authQS();
    if (!qs) return false;
    try {
        var r = await fetch(DB_URL + '/' + path + '.json' + qs, { method: 'DELETE' });
        return r.ok;
    } catch (e) {
        return false;
    }
}

/* Ambil seluruh daftar akun (VIP/USER/admin lama). null = secret belum
   diset / gagal konek, [] = memang kosong. */
async function fetchAllAccounts() {
    var data = await fetchPath('hidz_access_db');
    if (data === null) return null;
    if (Array.isArray(data)) return data.filter(function (u) { return u && u.username; });
    if (data && typeof data === 'object') return Object.values(data).filter(function (u) { return u && u.username; });
    return [];
}

/* Timpa seluruh daftar akun dengan array baru (pola yang sama seperti
   admin.html/mutateUsersAtomic — baca semua, ubah di memori, tulis semua). */
async function saveAllAccounts(list) {
    return setPath('hidz_access_db', list);
}

/* Bersihkan jejak akun yang sudah dihapus di node-node lain (sesi aktif,
   status banned, device yang diblokir) — sama seperti yang dilakukan
   Panel VIP & admin.html sebelumnya. */
async function removeAccountTraces(id) {
    await Promise.all([
        deletePath('hidz_sessions/' + id),
        deletePath('hidz_banned/' + id),
        deletePath('hidz_blocked_devices/' + id)
    ]);
}

var pw = require('./password');

/* Cek apakah {id, username, password} yang dikirim benar-benar akun VIP
   yang valid di dalam daftar. Dipakai tiap endpoint Panel VIP sebelum
   ngizinin baca/tulis apa pun. */
function findValidVip(list, vipId, vipUsername, vipPassword) {
    var me = list.filter(function (u) { return u.id === vipId; })[0];
    if (!me) return null;
    if (me.role !== 'vip') return null;
    if ((me.username || '').toLowerCase() !== (vipUsername || '').toLowerCase()) return null;
    if (!pw.verifyPassword(vipPassword, me.password)) return null;
    return me;
}

/* ===== RATE LIMIT LOGIN — dicatat di server, bukan cuma di browser =====
   Cooldown yang sebelumnya cuma ada di sisi client (localStorage) gampang
   dilewati siapa pun yang langsung nembak endpoint ini pakai script, tanpa
   pernah buka form login di browser sama sekali. Ini dicatat di Firebase
   berdasarkan IP pemanggil, jadi tetap kena kunci walau localStorage-nya
   dikosongin/incognito. Pola makin lama tiap terulang, sama seperti
   cooldown di sisi client, cuma sekarang beneran gak bisa dilewati. */
var RATE_LIMIT_MAX_FAILS = 5;
var RATE_LIMIT_BASE_MS   = 30000;
var RATE_LIMIT_CAP_MS    = 300000;

function callerKey(req) {
    var fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    var ip  = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
    return ip.replace(/[.#$\[\]/:]/g, '_');
}

/* { blocked: true, retryAfterSec } kalau IP ini lagi kena kunci,
   { blocked: false } kalau boleh lanjut cek kredensial. */
async function checkLoginRateLimit(path, req) {
    var rec = await fetchPath(path + '/' + callerKey(req));
    if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
        return { blocked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
    }
    return { blocked: false };
}

/* Panggil tiap kredensial yang dikirim TERNYATA salah. */
async function registerLoginFail(path, req) {
    var key = callerKey(req);
    var rec = (await fetchPath(path + '/' + key)) || { fails: 0, tier: 0 };
    var fails = (rec.fails || 0) + 1;
    if (fails >= RATE_LIMIT_MAX_FAILS) {
        var tier   = rec.tier || 0;
        var lockMs = Math.min(RATE_LIMIT_BASE_MS * Math.pow(2, tier), RATE_LIMIT_CAP_MS);
        await setPath(path + '/' + key, { fails: 0, tier: tier + 1, lockedUntil: Date.now() + lockMs });
    } else {
        await setPath(path + '/' + key, { fails: fails, tier: rec.tier || 0 });
    }
}

/* Panggil tiap kredensial yang dikirim TERNYATA benar — reset hitungan
   gagal beruntun punya IP itu. */
async function clearLoginRateLimit(path, req) {
    await deletePath(path + '/' + callerKey(req));
}

module.exports = {
    DB_URL: DB_URL,
    fetchPath: fetchPath,
    setPath: setPath,
    deletePath: deletePath,
    fetchAllAccounts: fetchAllAccounts,
    saveAllAccounts: saveAllAccounts,
    removeAccountTraces: removeAccountTraces,
    findValidVip: findValidVip,
    checkLoginRateLimit: checkLoginRateLimit,
    registerLoginFail: registerLoginFail,
    clearLoginRateLimit: clearLoginRateLimit
};
