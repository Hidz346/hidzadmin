/* Pengirim notifikasi dari panel admin ke HidzProject. Dipanggil dari
   endpoint admin setelah RESET PASSWORD, TAMBAH DURASI, MAINTENANCE ON, dan
   PROJECT BARU — file bantu saja, bukan endpoint (nama folder _lib), jadi
   jumlah Serverless Function di paket Hobby tidak bertambah.

   Ada dua jalur pengiriman yang saling melengkapi:

   1) ANTREAN DALAM HALAMAN — hidz_notifications/{userId}/{id}
      Pesan ditulis ke antrean milik akun tujuan. hidzproject.html
      mendengarkan antrean itu hanya saat akunnya sedang login & tab-nya
      terlihat (ONLINE), menampilkan pesannya paling banyak 3 kali
      (sekali per membuka halaman), lalu menghapus catatannya. Kalau akunnya
      sedang tidak membuka halaman, pesan menunggu di antrean sampai akun itu
      aktif lagi — tidak ada yang dikirim ke halaman yang tidak sedang dibuka.

   2) WEB PUSH (notifikasi Chrome) — hidz_push_subs/{userId}/{deviceId}
      Dikirim ke setiap device yang sudah mengaktifkan notifikasi. Service
      worker di device itu sendiri yang memutuskan: kalau tab HidzProject
      sedang terbuka & terlihat, notifikasi sistem tidak ditampilkan (pesan
      dalam halaman yang jalan), kalau tidak ya muncul di bar notifikasi
      seperti notifikasi Chrome biasa.

   3) RIWAYAT — hidz_notification_log/{id}
      Tiap pengiriman dicatat untuk kartu "Riwayat Notifikasi" di panel
      admin (jenis, isi, penerima, jumlah device Chrome yang terkirim). Path
      ini tertutup untuk browser; dibaca dan dihapus lewat action 'notif-list'
      / 'notif-delete' di api/admin/maintenance.js. Menghapus riwayat juga
      menarik pesan antrean yang belum dibaca (ditandai logId).

   Semuanya best-effort: kegagalan di sini TIDAK boleh menggagalkan aksi
   admin yang sudah berhasil, jadi tidak ada fungsi di bawah yang melempar
   error. Kalau paket web-push belum terpasang atau kunci VAPID belum
   diisi, jalur Web Push dilewati dan antrean dalam halaman tetap jalan. */

var crypto = require('crypto');
var db = require('./db');

var webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }

var SUBS_PATH  = 'hidz_push_subs';
var INBOX_PATH = 'hidz_notifications';
var LOG_PATH   = 'hidz_notification_log';
var ADMIN_ID   = 'admin_hidz_protected';

/* Id akun dipakai langsung sebagai kunci path Firebase. Satu kunci yang
   mengandung karakter terlarang (. # $ [ ] /) membuat seluruh penulisan
   massal ditolak, jadi akun dengan id aneh dilewati saja. */
var ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

var LOG_ID_PATTERN = /^l_[0-9]{10,16}_[0-9a-f]{6}$/;
var LOG_KEEP = 50;   /* riwayat yang disimpan; sisanya dipangkas saat daftar dibuka */

var BATCH_SIZE   = 10;
var SEND_TIMEOUT = 4000;   /* batas tiap pengiriman ke layanan push */
var TOTAL_BUDGET = 6000;   /* batas total sebelum respons ke admin dibalas */

/* Endpoint langganan disimpan dari browser, jadi dianggap tidak tepercaya:
   server ini tidak boleh dipancing menembak alamat sembarangan. Hanya host
   layanan push milik browser besar yang dilayani. */
var PUSH_HOST_SUFFIXES = [
    '.googleapis.com',            /* Chrome, Edge, Samsung Internet (FCM) */
    '.push.services.mozilla.com', /* Firefox */
    '.push.apple.com',            /* Safari */
    '.notify.windows.com'         /* Edge lama / WNS */
];

function isAllowedEndpoint(endpoint) {
    var url;
    try { url = new URL(endpoint); } catch (e) { return false; }
    if (url.protocol !== 'https:') return false;
    return PUSH_HOST_SUFFIXES.some(function (suffix) {
        return url.hostname.length > suffix.length && url.hostname.slice(-suffix.length) === suffix;
    });
}

/* Alasan Web Push tidak jalan dicatat ke log Vercel (sekali per alasan per
   instance), supaya kelihatan di Logs tanpa membanjiri. */
var _warned = {};
function warnOnce(key, message) {
    if (_warned[key]) return;
    _warned[key] = true;
    console.warn('[push] ' + message);
}

var _configured = false;
function pushReady() {
    if (!webpush) {
        warnOnce('module', 'paket web-push tidak terpasang — pastikan package.json ada di root repo HidzAdmin, lalu deploy ulang.');
        return false;
    }
    if (_configured) return true;

    var publicKey  = process.env.VAPID_PUBLIC_KEY || '';
    var privateKey = process.env.VAPID_PRIVATE_KEY || '';
    if (!publicKey || !privateKey) {
        warnOnce('keys', 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY belum diisi di HidzAdmin (atau belum redeploy).');
        return false;
    }

    try {
        webpush.setVapidDetails(
            process.env.VAPID_SUBJECT || 'https://hidzproject.my.id',
            publicKey,
            privateKey
        );
        _configured = true;
    } catch (e) {
        warnOnce('details', 'kunci VAPID / VAPID_SUBJECT ditolak: ' + (e && e.message));
        return false;
    }
    return true;
}

/* Milidetik -> "1 TAHUN 2 BULAN 3 HARI", sama seperti _msToFullLabel() di
   admin.html. Hanya satuan yang nilainya di atas 0 yang ditampilkan. */
function describeDuration(ms) {
    var DAY = 86400000;
    var units = [
        ['TAHUN', 365 * DAY], ['BULAN', 30 * DAY], ['HARI', DAY],
        ['JAM', 3600000], ['MENIT', 60000], ['DETIK', 1000]
    ];
    var left = Math.max(0, Math.floor(ms));
    var parts = [];
    units.forEach(function (u) {
        var n = Math.floor(left / u[1]);
        left -= n * u[1];
        if (n > 0) parts.push(n + ' ' + u[0]);
    });
    return parts.length ? parts.join(' ') : '0 DETIK';
}

/* Satu pengiriman. Langganan yang sudah mati (404/410 dari layanan push —
   aplikasi dihapus, izin dicabut, dsb) langsung dibuang supaya tidak
   dicoba terus-menerus. */
async function sendOne(path, sub, payload, ttl) {
    if (!sub || !isAllowedEndpoint(sub.endpoint)) return false;
    if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;

    try {
        await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
            payload,
            { TTL: ttl, urgency: 'high', timeout: SEND_TIMEOUT }
        );
        return true;
    } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) await db.deletePath(path);
        else console.warn('[push] gagal kirim (status ' + (e && e.statusCode) + '): ' + String((e && e.body) || (e && e.message) || '').slice(0, 200));
        return false;
    }
}

/* targets: [{ path, sub, tag? }]. `tag` per target (opsional) menggantikan
   tag umum — dipakai kalau tiap akun punya id antrean sendiri. Dikirim per
   kelompok kecil; kelompok baru tidak dimulai lagi kalau batas waktu total
   sudah lewat. */
async function sendAll(targets, note, tag, ttl) {
    var startedAt = Date.now();
    var sent = 0;

    for (var i = 0; i < targets.length; i += BATCH_SIZE) {
        if (Date.now() - startedAt > TOTAL_BUDGET) break;
        var results = await Promise.all(targets.slice(i, i + BATCH_SIZE).map(function (t) {
            var payload = JSON.stringify({
                title: note.title,
                body:  note.body,
                tag:   t.tag || tag,
                type:  note.type || 'info'
            });
            return sendOne(t.path, t.sub, payload, ttl);
        }));
        results.forEach(function (ok) { if (ok) sent++; });
    }
    return sent;
}

function newInboxId() {
    return 'n_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

function newLogId() {
    return 'l_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

/* Catat satu pengiriman ke riwayat. Best-effort seperti yang lain di file
   ini: gagal mencatat tidak boleh mengganggu pengiriman yang sudah jalan. */
async function logHistory(id, entry) {
    var rec = {
        type:      entry.type || 'info',
        title:     entry.title,
        body:      entry.body,
        scope:     entry.scope,
        pushed:    entry.pushed || 0,
        createdAt: entry.createdAt || Date.now()
    };
    if (entry.userId)   rec.userId   = entry.userId;
    if (entry.accounts) rec.accounts = entry.accounts;

    var saved = await db.setPath(LOG_PATH + '/' + id, rec);
    if (!saved) console.warn('[push] riwayat notifikasi gagal ditulis ke Firebase.');
    return saved;
}

/* Kabari satu akun: antrean dalam halaman + Web Push ke semua device-nya.
   note = { type, title, body }. Balikan: jumlah push yang terkirim. */
async function notifyUser(userId, note) {
    if (!userId || !note) return 0;

    var pushed = 0;
    try {
        var id    = newInboxId();
        var logId = newLogId();
        var queued = await db.setPath(INBOX_PATH + '/' + userId + '/' + id, {
            type:      note.type || 'info',
            title:     note.title,
            body:      note.body,
            createdAt: Date.now(),
            logId:     logId
        });
        if (!queued) console.warn('[push] pesan dalam halaman gagal ditulis ke Firebase (cek FIREBASE_DB_SECRET).');

        if (pushReady()) {
            var devices = await db.fetchPath(SUBS_PATH + '/' + userId);
            if (devices && typeof devices === 'object') {
                var targets = Object.keys(devices).map(function (deviceId) {
                    return { path: SUBS_PATH + '/' + userId + '/' + deviceId, sub: devices[deviceId] };
                });
                pushed = await sendAll(targets, note, id, 86400);
            }
        }

        if (queued || pushed > 0) {
            await logHistory(logId, {
                type: note.type, title: note.title, body: note.body,
                scope: 'user', userId: userId, pushed: pushed
            });
        }
    } catch (e) { /* best-effort */ }
    return pushed;
}

/* Kabari SEMUA device yang sudah mengaktifkan notifikasi (mis. maintenance
   dimulai). Tidak lewat antrean dalam halaman — yang sedang membuka halaman
   sudah melihat layar maintenance langsung dari listener-nya. Device milik
   akun admin dilewati: admin tetap bisa masuk saat maintenance.

   Langganan milik akun yang sudah dihapus tidak dikirimi apa-apa dan
   dibersihkan sekalian, supaya orang yang akunnya sudah tidak ada tidak
   terus menerima notifikasi. */
async function broadcast(note, tag) {
    if (!note) return 0;

    try {
        if (!pushReady()) return 0;

        var all = await db.fetchPath(SUBS_PATH);
        if (!all || typeof all !== 'object') return 0;

        var accounts = await db.fetchAllAccounts();
        if (accounts === null) return 0;
        var alive = {};
        accounts.forEach(function (u) { alive[u.id] = true; });

        var targets = [];
        var orphans = [];
        var reached = {};
        Object.keys(all).forEach(function (userId) {
            if (userId === ADMIN_ID || !all[userId] || typeof all[userId] !== 'object') return;
            if (!alive[userId]) { orphans.push(userId); return; }
            Object.keys(all[userId]).forEach(function (deviceId) {
                reached[userId] = true;
                targets.push({ path: SUBS_PATH + '/' + userId + '/' + deviceId, sub: all[userId][deviceId] });
            });
        });

        await Promise.all(orphans.map(function (userId) { return db.deletePath(SUBS_PATH + '/' + userId); }));
        var sent = await sendAll(targets, note, tag || 'hidz-info', 21600);
        await logHistory(newLogId(), {
            type: note.type, title: note.title, body: note.body,
            scope: 'all', accounts: Object.keys(reached).length, pushed: sent
        });
        return sent;
    } catch (e) {
        return 0;
    }
}

/* Kabari SEMUA akun biasa lewat dua jalur sekaligus (mis. project baru
   dirilis): antrean dalam halaman milik tiap akun — akun yang sedang online
   langsung melihat kartunya, yang offline melihatnya begitu aktif lagi —
   ditambah Web Push ke semua device yang sudah mengaktifkan notifikasi.

   Penerima: akun user/VIP yang durasinya belum habis. Akun admin dilewati,
   begitu juga akun yang sudah expired (tidak bisa login, antreannya cuma
   jadi sampah). Notifikasi Chrome memakai id antrean akun itu sebagai tag,
   jadi begitu kartu dalam halaman tampil, notifikasi sistemnya ikut ditutup
   (sama seperti notifyUser).

   Balikan: { accounts, pushed } — jumlah akun penerima & push yang
   terkirim. null kalau daftar akun gagal dibaca atau antrean gagal ditulis,
   artinya belum ada yang terkirim. */
async function announce(note) {
    if (!note) return null;

    try {
        var accounts = await db.fetchAllAccounts();
        if (accounts === null) return null;

        var now = Date.now();
        var recipients = accounts.filter(function (u) {
            if (!u || !ID_PATTERN.test(String(u.id || ''))) return false;
            if (u.id === ADMIN_ID || String(u.role || '').toLowerCase() === 'admin') return false;
            return !(u.expiresAt && now > u.expiresAt);
        });
        if (!recipients.length) return { accounts: 0, pushed: 0 };

        /* Satu penulisan massal ke semua antrean — bukan satu request per akun. */
        var logId = newLogId();
        var inbox = {};
        var tags  = {};
        recipients.forEach(function (u) {
            var id = newInboxId();
            tags[u.id] = id;
            inbox[u.id + '/' + id] = {
                type:      note.type || 'info',
                title:     note.title,
                body:      note.body,
                createdAt: now,
                logId:     logId
            };
        });
        if (!(await db.updatePath(INBOX_PATH, inbox))) return null;

        var pushed = 0;
        if (pushReady()) {
            var subs = await db.fetchPath(SUBS_PATH);
            if (subs && typeof subs === 'object') {
                var targets = [];
                recipients.forEach(function (u) {
                    var devices = subs[u.id];
                    if (!devices || typeof devices !== 'object') return;
                    Object.keys(devices).forEach(function (deviceId) {
                        targets.push({
                            path: SUBS_PATH + '/' + u.id + '/' + deviceId,
                            sub:  devices[deviceId],
                            tag:  tags[u.id]
                        });
                    });
                });
                pushed = await sendAll(targets, note, 'hidz-info', 86400);
            }
        }

        await logHistory(logId, {
            type: note.type, title: note.title, body: note.body,
            scope: 'all', accounts: recipients.length, pushed: pushed, createdAt: now
        });
        return { accounts: recipients.length, pushed: pushed };
    } catch (e) {
        return null;
    }
}

/* Riwayat untuk panel admin, terbaru lebih dulu. Yang melewati LOG_KEEP
   dipangkas di sini — daftar ini hanya dibuka admin, jadi tidak perlu tugas
   pembersih terpisah. */
async function listHistory() {
    var all = await db.fetchPath(LOG_PATH);
    if (!all || typeof all !== 'object') return [];

    var items = Object.keys(all)
        .filter(function (id) { return LOG_ID_PATTERN.test(id) && all[id] && typeof all[id] === 'object'; })
        .map(function (id) {
            var e = all[id];
            return {
                id:        id,
                type:      String(e.type || 'info'),
                title:     String(e.title || ''),
                body:      String(e.body || ''),
                scope:     e.scope === 'user' ? 'user' : 'all',
                userId:    e.userId ? String(e.userId) : '',
                accounts:  Number(e.accounts) || 0,
                pushed:    Number(e.pushed) || 0,
                createdAt: Number(e.createdAt) || 0
            };
        })
        .sort(function (a, b) { return b.createdAt - a.createdAt; });

    if (items.length > LOG_KEEP) {
        var stale = {};
        items.slice(LOG_KEEP).forEach(function (it) { stale[it.id] = null; });
        await db.updatePath(LOG_PATH, stale);
        items = items.slice(0, LOG_KEEP);
    }
    return items;
}

/* Hapus satu catatan riwayat sekaligus menarik pesan antrean yang masih
   belum dibaca penerimanya (yang sudah dibaca/terhapus tidak ada lagi).
   Balikan: null kalau id tidak valid, false kalau database gagal,
   selain itu { retracted } — jumlah pesan antrean yang ditarik. */
async function removeHistory(id) {
    if (typeof id !== 'string' || !LOG_ID_PATTERN.test(id)) return null;

    try {
        var inbox = await db.fetchPath(INBOX_PATH);
        var retract = {};
        if (inbox && typeof inbox === 'object') {
            Object.keys(inbox).forEach(function (userId) {
                var notes = inbox[userId];
                if (!ID_PATTERN.test(userId) || !notes || typeof notes !== 'object') return;
                Object.keys(notes).forEach(function (noteId) {
                    if (notes[noteId] && notes[noteId].logId === id) retract[userId + '/' + noteId] = null;
                });
            });
        }

        var retracted = Object.keys(retract).length;
        if (retracted && !(await db.updatePath(INBOX_PATH, retract))) return false;
        if (!(await db.deletePath(LOG_PATH + '/' + id))) return false;
        return { retracted: retracted };
    } catch (e) {
        return false;
    }
}

module.exports = {
    notifyUser: notifyUser,
    broadcast: broadcast,
    announce: announce,
    listHistory: listHistory,
    removeHistory: removeHistory,
    describeDuration: describeDuration
};
