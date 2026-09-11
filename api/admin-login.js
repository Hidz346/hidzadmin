/* Cek login gerbang admin.html. Project ini TERPISAH dari project
   hidzproject.html, jadi endpoint-nya juga sendiri — dan karena gerbang
   ini cuma buat satu orang (pemilik panel), gak perlu nyambung ke
   Firebase sama sekali, cukup cocokkan ke Environment Variable
   ADMIN_USERNAME & ADMIN_PASSWORD yang diset di project Vercel ini.
   Isi env var-nya samakan dengan yang di project hidzproject.html supaya
   satu kredensial admin bisa dipakai masuk ke dua-duanya. */
module.exports = function (req, res) {
    if (req.method !== 'POST') {
        res.status(200).json({ ok: false });
        return;
    }

    var body = req.body || {};
    var username = typeof body.username === 'string' ? body.username.trim() : '';
    var password = typeof body.password === 'string' ? body.password : '';

    var adminUser = process.env.ADMIN_USERNAME || '';
    var adminPass = process.env.ADMIN_PASSWORD || '';

    /* Kalau env var belum diisi di Vercel, jangan pernah anggap valid
       apa pun yang diketik — daripada diam-diam kebobolan gara-gara
       konfigurasi yang belum lengkap. */
    var valid = !!adminUser && !!adminPass &&
        username.toLowerCase() === adminUser.toLowerCase() &&
        password === adminPass;

    res.status(200).json({ ok: valid });
};
