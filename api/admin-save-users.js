/**
 * POST /api/admin-save-users
 *
 * Timpa SELURUH isi hidz_access_db dengan array yang dikirim admin.html,
 * dijalankan lewat Firebase Admin SDK di server — bukan ditulis langsung
 * dari browser lewat Firebase client SDK seperti sebelumnya.
 *
 * Kenapa ini penting: sama seperti /api/admin-users, tapi untuk sisi TULIS.
 * Rule Firebase hidz_access_db tadinya ".write": true dengan validasi yang
 * longgar (cuma cek "ada isinya") — artinya siapa saja bisa menimpa seluruh
 * tabel user, termasuk menaikkan role akunnya sendiri jadi admin. Endpoint
 * ini menggantikan pola itu supaya rule Firebase bisa dikunci total.
 *
 * Header wajib: x-admin-secret (harus sama dengan env var ADMIN_API_SECRET)
 * Body: array user lengkap (JSON array, sama seperti yang dulu dikirim ke
 *       firebase.database().ref('hidz_access_db').set(arr))
 * Response sukses: { ok: true }
 *
 * Pakai env var yang sama dengan /api/admin-users.js.
 */

const admin = require('firebase-admin');

const DB_KEY = 'hidz_access_db';
const DATABASE_URL =
    process.env.FIREBASE_DATABASE_URL ||
    'https://hidzproject-8f335-default-rtdb.asia-southeast1.firebasedatabase.app';

function getAdminApp() {
    if (admin.apps.length) return admin.app();

    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

    return admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey
        }),
        databaseURL: DATABASE_URL
    });
}

function isAuthorized(req) {
    var secret = process.env.ADMIN_API_SECRET || '';
    var given = req.headers['x-admin-secret'] || '';
    return secret.length > 0 && given === secret;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, message: 'Method not allowed' });
    }

    if (!isAuthorized(req)) {
        return res.status(401).json({ ok: false, message: 'Admin secret salah atau belum diisi.' });
    }

    var users = req.body;
    if (!Array.isArray(users)) {
        return res.status(400).json({ ok: false, message: 'Body harus berupa array user.' });
    }

    try {
        getAdminApp();
        await admin.database().ref(DB_KEY).set(users);
        return res.status(200).json({ ok: true });

    } catch (err) {
        console.error('[api/admin-save-users] gagal simpan data user:', err);
        return res.status(500).json({ ok: false, message: 'Terjadi kesalahan di server.' });
    }
};
