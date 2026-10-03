/* Kabar PROJECT BARU ke semua akun, dikirim dari kartu "Project Baru" di
   panel admin.

   Dipanggil dari api/admin/maintenance.js (action: 'project-new') — sengaja
   tidak dibuat sebagai file endpoint sendiri di api/admin/ supaya jumlah
   Serverless Function di paket Hobby tidak bertambah. Pemeriksaan admin
   (guard + token) sudah dilakukan maintenance.js sebelum fungsi ini dipanggil.

   Daftar project di HidzProject tersimpan di dalam halamannya sendiri, bukan
   di database, jadi server tidak punya cara tahu kapan ada project baru —
   admin yang memberi tahu lewat kartu ini setelah project barunya tayang.

   Pengiriman sebenarnya ada di ./push.js (announce): pesan dalam halaman
   untuk akun yang sedang ONLINE, notifikasi Chrome untuk device yang tab-nya
   sedang tidak dibuka. */

var push = require('./push');

var NAME_MAX = 60;
var DESC_MAX = 140;
var DEFAULT_BODY = 'Sudah tersedia di HidzProject. Buka halamannya untuk melihat dan mencobanya.';

/* Teks bebas dari admin: karakter kontrol & baris baru dijadikan spasi, spasi
   ganda dirapikan, lalu dipotong sesuai batasnya. */
function clean(value, max) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

async function run(body, res) {
    var name = clean(body.name, NAME_MAX);
    var desc = clean(body.desc, DESC_MAX);

    if (!name) {
        res.status(200).json({ ok: false, reason: 'invalid' });
        return;
    }

    var out = await push.announce({
        type:  'project_new',
        title: 'Project Baru: ' + name,
        body:  desc || DEFAULT_BODY
    });

    if (!out) {
        res.status(200).json({ ok: false, error: true });
        return;
    }
    res.status(200).json({ ok: true, accounts: out.accounts, pushed: out.pushed });
}

module.exports = { run: run };
