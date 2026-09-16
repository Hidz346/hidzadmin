/* Cek login gerbang admin.html. Kredensial dicocokkan ke Environment
   Variable ADMIN_USERNAME & ADMIN_PASSWORD (samakan isinya dengan project
   hidzproject.html supaya satu kredensial admin bisa dipakai masuk ke
   dua-duanya) — plus percobaan gagal beruntun dicatat per-IP di server
   lewat db.verifyAdmin(), jadi script yang nembak endpoint ini langsung
   tanpa pernah buka gerbang di browser tetap kena kunci. */

var db = require('./_lib/db');
var firebaseAuth = require('./_lib/firebase-auth');

module.exports = async function (req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body = req.body || {};
    var username = typeof body.username === 'string' ? body.username.trim() : '';
    var password = typeof body.password === 'string' ? body.password : '';

    var auth = await db.verifyAdmin(req, username, password);
    if (!auth.ok) {
        res.status(200).json(auth.locked
            ? { ok: false, locked: true, retryAfterSec: auth.retryAfterSec }
            : { ok: false });
        return;
    }

    var token;
    try { token = await firebaseAuth.createCustomToken('admin_hidz_protected', { admin: true, role: 'admin' }); }
    catch (e) { res.status(503).json({ ok: false, error: true, code: 'FIREBASE_AUTH_CONFIG' }); return; }
    res.status(200).json({ ok: true, firebaseToken: token });
};
