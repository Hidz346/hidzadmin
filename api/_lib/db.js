/* Helper bersama buat semua endpoint kelola akun di project hidzadmin.
   Nama folder diawali underscore supaya Vercel gak menganggapnya endpoint
   sendiri — ini murni file bantu. */

var pw = require('./password');


var DB_URL = 'https://hidzproject-8f335-default-rtdb.asia-southeast1.firebasedatabase.app';
var crypto = require('crypto');

var _accessTokenCache = { token: '', expiresAt: 0 };

function _b64url(value) {
    return Buffer.from(value).toString('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function _serviceAccount() {
    var raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
    if (raw) {
        try {
            var parsed = JSON.parse(raw);
            if (parsed && parsed.client_email && parsed.private_key && parsed.project_id) return parsed;
        } catch (e) {}
    }

    var email = process.env.FIREBASE_CLIENT_EMAIL || '';
    var key = process.env.FIREBASE_PRIVATE_KEY || '';
    var projectId = process.env.FIREBASE_PROJECT_ID || 'hidzproject-8f335';
    if (!email || !key) return null;

    return {
        client_email: email,
        private_key: key.replace(/\\n/g, '\n'),
        project_id: projectId
    };
}

/* Pakai Database Secret kalau masih tersedia. Kalau tidak, fallback ke
   OAuth access token dari service account yang memang sudah dibutuhkan
   Firebase Authentication. Ini membuat hidz_access_db tetap tertutup
   oleh Firebase Rules, tanpa mengharuskan operator mengedit database
   secara manual. */
async function _getGoogleAccessToken() {
    var now = Date.now();
    if (_accessTokenCache.token && _accessTokenCache.expiresAt > now + 60000) {
        return _accessTokenCache.token;
    }

    var sa = _serviceAccount();
    if (!sa) return null;

    try {
        var nowSec = Math.floor(now / 1000);
        var header = { alg: 'RS256', typ: 'JWT' };
        var payload = {
            iss: sa.client_email,
            scope: 'https://www.googleapis.com/auth/firebase.database',
            aud: 'https://oauth2.googleapis.com/token',
            iat: nowSec,
            exp: nowSec + 3600
        };

        var unsigned = _b64url(JSON.stringify(header)) + '.' + _b64url(JSON.stringify(payload));
        var signer = crypto.createSign('RSA-SHA256');
        signer.update(unsigned);
        signer.end();
        var assertion = unsigned + '.' + _b64url(signer.sign(sa.private_key));

        var response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: assertion
            }).toString()
        });

        if (!response.ok) return null;
        var data = await response.json();
        if (!data || !data.access_token) return null;

        _accessTokenCache = {
            token: data.access_token,
            expiresAt: now + Math.max(60000, Math.min(Number(data.expires_in || 3600) * 1000, 3600000))
        };
        return _accessTokenCache.token;
    } catch (e) {
        return null;
    }
}

async function _requestAuth() {
    var secret = process.env.FIREBASE_DB_SECRET || '';
    if (secret) {
        return {
            query: '?auth=' + encodeURIComponent(secret),
            headers: {}
        };
    }

    var accessToken = await _getGoogleAccessToken();
    if (!accessToken) return null;

    return {
        query: '',
        headers: { Authorization: 'Bearer ' + accessToken }
    };
}

/* Ambil nilai mentah dari path mana pun. null = database credential
   belum tersedia atau request Firebase gagal. */
async function fetchPath(path) {
    var auth = await _requestAuth();
    if (!auth) return null;

    try {
        var r = await fetch(DB_URL + '/' + path + '.json' + auth.query, {
            headers: Object.assign({ Accept: 'application/json' }, auth.headers)
        });
        if (!r.ok) return null;
        return await r.json();
    } catch (e) {
        return null;
    }
}

/* Timpa nilai di path mana pun. */
async function setPath(path, value) {
    var auth = await _requestAuth();
    if (!auth) return false;

    try {
        var r = await fetch(DB_URL + '/' + path + '.json' + auth.query, {
            method: 'PUT',
            headers: Object.assign({ 'Content-Type': 'application/json' }, auth.headers),
            body: JSON.stringify(value)
        });
        return r.ok;
    } catch (e) {
        return false;
    }
}

/* Hapus path mana pun. */
async function deletePath(path) {
    var auth = await _requestAuth();
    if (!auth) return false;

    try {
        var r = await fetch(DB_URL + '/' + path + '.json' + auth.query, {
            method: 'DELETE',
            headers: auth.headers
        });
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
        pw.timingSafeStringEqual(password, adminPass);

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
