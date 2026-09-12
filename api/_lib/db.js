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

/* Cek {username, password} yang dikirim benar-benar cocok dengan
   ADMIN_USERNAME/ADMIN_PASSWORD di Environment Variable. Dipakai tiap
   endpoint sebelum ngizinin baca/tulis apa pun — jadi walau seseorang tahu
   alamat endpoint-nya, tetap gak bisa dipakai tanpa kredensial admin yang
   benar. */
function verifyAdmin(username, password) {
    var adminUser = process.env.ADMIN_USERNAME || '';
    var adminPass = process.env.ADMIN_PASSWORD || '';
    if (!adminUser || !adminPass) return false;
    if ((username || '').toLowerCase() !== adminUser.toLowerCase()) return false;
    if (password !== adminPass) return false;
    return true;
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

