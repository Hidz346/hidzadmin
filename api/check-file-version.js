/* Dipanggil hidzproject.html SEKALI tiap kali halaman dibuka — oleh SEMUA
   pengunjung, termasuk yang belum login sama sekali — buat ngecek apakah
   ada deploy baru yang sengaja menaikkan FILE_VERSION. Kalau iya, semua
   akun (VIP/USER/ADMIN) di-reset status loginnya supaya wajib login ulang.

   Dulu seluruh baca-ubah-tulis ini (termasuk narik SELURUH isi
   hidz_access_db, isinya semua password akun) jalan langsung di browser
   pengunjung lewat Firebase — jadi siapa pun yang buka halaman ini,
   login atau tidak, sempat memegang salinan penuh database akun cuma
   buat ngecek satu angka versi. Sekarang semuanya dipindah ke sini (pakai
   Database Secret), browser cuma kirim satu POST kosong dan dapat
   jawaban ok/changed doang.

   PENTING: FILE_VERSION di bawah ini HARUS disamakan manual dengan
   konstanta FILE_VERSION di hidzproject.html tiap kali deploy baru yang
   ingin memaksa semua user login ulang — kalau lupa disamakan, reset
   massal tidak akan terpicu walau file HTML-nya sudah berubah. Sengaja
   dibuat konstanta tetap di sini (bukan diambil dari input POST) supaya
   pengunjung tidak bisa memicu reset massal sendiri cuma dengan mengirim
   angka versi sembarangan. */

var db = require('./_lib/db');

var FILE_VERSION = 'HIDZ_FV_2026-07-18_01';

var securityGuard = require('./_lib/security');

module.exports = async function (req, res) {
    if (!(await securityGuard.guard(req, res))) return;
    if (req.method !== 'POST') {
        res.status(200).json({ ok: true, changed: false });
        return;
    }

    var storedFV = await db.fetchPath('hidz_file_ver');

    /* Pertama kali deploy (belum ada di Firebase) -> simpan saja, skip reset */
    if (!storedFV) {
        await db.setPath('hidz_file_ver', FILE_VERSION);
        res.status(200).json({ ok: true, changed: false });
        return;
    }

    /* Versi sama -> tidak ada perubahan file, skip */
    if (storedFV === FILE_VERSION) {
        res.status(200).json({ ok: true, changed: false });
        return;
    }

    /* Versi berbeda -> file baru saja diupdate. Update versi dulu supaya
       pengunjung lain yang baca bersamaan tidak ikut memicu reset dobel. */
    await db.setPath('hidz_file_ver', FILE_VERSION);

    var list = await db.fetchAllAccounts();
    if (list === null) list = [];

    /* Reset status login SEMUA akun TERMASUK ADMIN — berlaku untuk semua
       role, semua tipe durasi (terbatas maupun unlimited), dan semua
       limit device, supaya konsisten dengan tombol FORCE RESET SEMUA
       SESI di admin.html. Akun durasi terbatas yang sedang berjalan
       di-"pause": SISA durasinya disimpan balik ke durationMs (bukan
       dibuang), supaya saat login lagi TIDAK mengulang dari durasi
       penuh semula. */
    var now     = Date.now();
    var changed = false;
    list.forEach(function (u) {
        if (!u) return;
        var isUnlimitedDur = !(typeof u.durationMs === 'number' && u.durationMs > 0);
        if (isUnlimitedDur) {
            u.activated = false;
        } else if (u.activated === true && u.expiresAt && (now <= u.expiresAt)) {
            u.durationMs = Math.max(0, u.expiresAt - now);
            u.expiresAt  = null;
            u.activated  = false;
        }
        u.logoutAt  = now;
        u.loggedOut = false;
        changed = true;
    });

    if (changed) await db.saveAllAccounts(list);

    /* Bersihkan sisa sesi/banned/blocked-device lama tiap akun (termasuk
       admin), supaya tidak ada yang keliru kena "AKUN DIBLOKIR" gara-gara
       data sesi basi peninggalan sebelum update file ini. */
    await Promise.all(list.map(function (u) {
        return u ? db.removeAccountTraces(u.id) : Promise.resolve();
    }));

    /* Kirim signal force re-login ke semua user */
    await db.setPath('hidz_force_relogin', Date.now());

    res.status(200).json({ ok: true, changed: true });
};
