/**
 * GET /api/admin-users
 *
 * Ambil SELURUH isi hidz_access_db untuk panel admin.html, dijalankan lewat
 * Firebase Admin SDK di server — bukan dibaca langsung dari browser lewat
 * Firebase client SDK seperti sebelumnya.
 *
 * Kenapa ini penting: rule Firebase hidz_access_db tadinya ".read": true —
 * artinya SIAPA SAJA (bukan cuma admin.html) bisa baca seluruh tabel user
 * (termasuk semua password) langsung dari console browser atau REST call,
 * tanpa perlu tahu apa pun. Endpoint ini menggantikan pola itu: admin.html
 * sekarang minta datanya ke sini dengan mengirim admin secret, dan rule
 * hidz_access_db di Firebase bisa dikunci total (.read/.write: false) karena
 * Admin SDK di server selalu bisa akses berapa pun rule-nya.
 *
 * Header wajib: x-admin-secret (harus sama dengan env var ADMIN_API_SECRET)
 * Response sukses: { ok: true, users: [...] }
 *
 * Pakai env var Firebase yang sama dengan /api/login.js (FIREBASE_PROJECT_ID,
 * FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY) — plus satu env var baru,
 * ADMIN_API_SECRET, yang perlu ditambahkan sendiri di pengaturan project
 * Vercel (isinya bebas, string acak yang cuma diketahui admin).
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
    if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ ok: false, message: 'Method not allowed' });
    }

    if (!isAuthorized(req)) {
        return res.status(401).json({ ok: false, message: 'Admin secret salah atau belum diisi.' });
    }

    try {
        getAdminApp();
        const snap = await admin.database().ref(DB_KEY).once('value');
        const val = snap.val();

        var users;
        if (Array.isArray(val)) {
            users = val.filter(function (u) { return u && u.username; });
        } else if (val && typeof val === 'object') {
            users = Object.values(val).filter(function (u) { return u && u.username; });
        } else {
            users = [];
        }

        return res.status(200).json({ ok: true, users: users });

    } catch (err) {
        console.error('[api/admin-users] gagal ambil data user:', err);
        return res.status(500).json({ ok: false, message: 'Terjadi kesalahan di server.' });
    }
};
