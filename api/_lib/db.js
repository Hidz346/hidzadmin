/* Helper bersama buat semua endpoint kelola akun di project hidzadmin.
   Nama folder diawali underscore supaya Vercel gak menganggapnya endpoint
   sendiri — ini murni file bantu. */

var DB_URL = 'https://hidzproject-8f335-default-rtdb.asia-southeast1.firebasedatabase.app';

function authQS() {
    var secret = process.env.FIREBASE_DB_SECRET || '';
    return secret ? ('?auth=' + secret) : null;
}

/* Ambil nilai mentah dari path mana pun di database (mis. 'hidz_banned',
   'hidz_sessions/abc123'). null = secret belum diset / gagal konek. */
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

/* Ambil seluruh daftar akun (VIP/USER/admin lama), dibersihkan dari entri
   kosong — sama seperti getUsers() di sisi client. */
async function fetchAllAccounts() {
    var data = await fetchPath('hidz_access_db');
    if (data === null) return null;
    if (Array.isArray(data)) return data.filter(function (u) { return u && u.username; });
    if (data && typeof data === 'object') return Object.values(data).filter(function (u) { return u && u.username; });
    return [];
}

/* Timpa seluruh daftar akun dengan array baru. */
async function saveAllAccounts(list) {
    return setPath('hidz_access_db', list);
}

/* Bersihkan jejak satu akun di node-node lain (sesi aktif, status banned,
   device yang diblokir) — dipakai tiap kali akun dihapus/direset. */
async function removeAccountTraces(id) {
    await Promise.all([
        deletePath('hidz_sessions/' + id),
        deletePath('hidz_banned/' + id),
        deletePath('hidz_blocked_devices/' + id)
    ]);
}

/* Akun ini boleh dihapus/direset atau tidak — SATU-SATUNYA akun yang
   dilindungi adalah id tetap admin ('admin_hidz_protected'), sama seperti
   isProtected() di sisi client. */
function isProtectedAccount(u) {
    return !!u && u.id === 'admin_hidz_protected';
}

/* ===== RATE LIMIT LOGIN — dicatat di server, bukan cuma di browser =====
   Cooldown yang sebelumnya cuma ada di sisi client (localStorage) gampang
   dilewati siapa pun yang langsung nembak endpoint ini pakai script, tanpa
   pernah buka gerbang admin.html di browser sama sekali. Ini dicatat di
   Firebase berdasarkan IP pemanggil, jadi tetap kena kunci walau
   localStorage-nya dikosongin/incognito. */
var RATE_LIMIT_MAX_FAILS = 5;
var RATE_LIMIT_BASE_MS   = 30000;
var RATE_LIMIT_CAP_MS    = 300000;
var RATE_PATH            = 'hidz_admin_rate_limit';

function callerKey(req) {
    var fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    var ip  = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
    return ip.replace(/[.#$\[\]/:]/g, '_');
}

async function checkLoginRateLimit(req) {
    var rec = await fetchPath(RATE_PATH + '/' + callerKey(req));
    if (rec && rec.lockedUntil && Date.now() < rec.lockedUntil) {
        return { blocked: true, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
    }
    return { blocked: false };
}

async function registerLoginFail(req) {
    var key = callerKey(req);
    var rec = (await fetchPath(RATE_PATH + '/' + key)) || { fails: 0, tier: 0 };
    var fails = (rec.fails || 0) + 1;
    if (fails >= RATE_LIMIT_MAX_FAILS) {
        var tier   = rec.tier || 0;
        var lockMs = Math.min(RATE_LIMIT_BASE_MS * Math.pow(2, tier), RATE_LIMIT_CAP_MS);
        await setPath(RATE_PATH + '/' + key, { fails: 0, tier: tier + 1, lockedUntil: Date.now() + lockMs });
    } else {
        await setPath(RATE_PATH + '/' + key, { fails: fails, tier: rec.tier || 0 });
    }
}

async function clearLoginRateLimit(req) {
    await deletePath(RATE_PATH + '/' + callerKey(req));
}

/* Cek {username, password} yang dikirim benar-benar cocok dengan
   ADMIN_USERNAME/ADMIN_PASSWORD di Environment Variable — DIPAKAI SEMUA
   endpoint admin/* (bukan cuma gerbang login), jadi titik pemeriksaannya
   cuma satu dan rate limit-nya otomatis berlaku ke semuanya sekaligus.
   Balikannya { ok, locked, retryAfterSec } — bukan boolean polos lagi. */
async function verifyAdmin(req, username, password) {
    var limit = await checkLoginRateLimit(req);
    if (limit.blocked) {
        return { ok: false, locked: true, retryAfterSec: limit.retryAfterSec };
    }

    var adminUser = process.env.ADMIN_USERNAME || '';
    var adminPass = process.env.ADMIN_PASSWORD || '';
    var valid = !!adminUser && !!adminPass &&
        (username || '').toLowerCase() === adminUser.toLowerCase() &&
        password === adminPass;

    if (valid) {
        await clearLoginRateLimit(req);
        return { ok: true };
    }
    await registerLoginFail(req);
    return { ok: false, locked: false };
}

module.exports = {
    DB_URL: DB_URL,
    fetchPath: fetchPath,
    setPath: setPath,
    deletePath: deletePath,
    fetchAllAccounts: fetchAllAccounts,
    saveAllAccounts: saveAllAccounts,
    removeAccountTraces: removeAccountTraces,
    isProtectedAccount: isProtectedAccount,
    verifyAdmin: verifyAdmin
};

