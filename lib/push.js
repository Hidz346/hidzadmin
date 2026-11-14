/* Pengirim notifikasi dari panel admin ke HidzProject. Dipanggil dari
   endpoint admin setelah RESET PASSWORD, TAMBAH DURASI, MAINTENANCE ON,
   PROJECT BARU, dan VOUCHER VIP BARU — file bantu saja, bukan endpoint (nama folder _lib), jadi
   jumlah Serverless Function di paket Hobby tidak bertambah.

   Ada dua jalur pengiriman yang saling melengkapi:

   1) ANTREAN DALAM HALAMAN — hidz_notifications/{userId}/{id}
      Pesan ditulis ke antrean milik akun tujuan. hidzproject.html
      mendengarkan antrean itu hanya saat akunnya sedang login & tab-nya
      terlihat (ONLINE), menampilkan pesannya paling banyak 3 kali
      (sekali per membuka halaman) sebagai kartu. Kalau akunnya sedang tidak
      membuka halaman, pesan menunggu di antrean sampai akun itu aktif lagi —
      tidak ada yang dikirim ke halaman yang tidak sedang dibuka.

      Antrean ini sekaligus jadi RIWAYAT NOTIFIKASI di HIDZPROJECT: pesan yang
      sudah dibaca tetap tersimpan supaya bisa dilihat lagi, dan baru hilang
      kalau penerimanya menghapusnya, admin menghapus riwayatnya, atau masa
      berlakunya (expiresAt) habis — lihat expiryFor() dan pruneExpired().
      Akun yang dibuat sesudahnya mendapat salinan notifikasi "untuk semua
      akun" yang masih berlaku lewat seedNewAccount().

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
      / 'notif-delete' / 'notif-delete-all' di api/admin/maintenance.js.
      Menghapus riwayat juga menarik pesan yang sama dari riwayat notifikasi
      penerimanya di HIDZPROJECT (ditandai logId), sudah dibaca maupun belum.

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
var CHAT_PATH  = 'hidz_global_chat/messages';
var VOUCHER_PATH = 'hidz_vouchers';
var ADMIN_ID   = 'admin_hidz_protected';

/* Id akun dipakai langsung sebagai kunci path Firebase. Satu kunci yang
   mengandung karakter terlarang (. # $ [ ] /) membuat seluruh penulisan
   massal ditolak, jadi akun dengan id aneh dilewati saja. */
var ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

var LOG_ID_PATTERN = /^l_[0-9]{10,16}_[0-9a-f]{6}$/;
var CHAT_MESSAGE_ID = /^[0-9]{13}-[a-z0-9]{6}$/;
var CHAT_FRESH_MS   = 120000;   /* hanya pesan Chat Global yang baru saja dikirim yang boleh memicu notifikasi */
var CHAT_URL        = './?gc=1';
/* Penanda opsional di tiap pesan antrean ("voucher:HEMAT20") supaya satu kelompok pesan bisa ditarik
   sekaligus lewat withdrawByRef(), mis. saat voucher-nya dihapus sebelum waktunya. */
var REF_PATTERN = /^[A-Za-z0-9:_-]{1,80}$/;
var LOG_KEEP = 50;   /* riwayat yang disimpan; sisanya dipangkas saat daftar dibuka */

/* Masa berlaku notifikasi di riwayat HIDZPROJECT, menurut jenisnya. Setelah lewat, notifikasi
   terhapus sendiri. Pemanggil boleh menentukan sendiri lewat note.expiresAt (mis. voucher: sampai
   voucher berakhir), tetapi tidak lebih dari NOTE_TTL_MAX supaya riwayat tidak menumpuk. */
var DAY_MS = 86400000;
var NOTE_TTL = {
    reset_password: 7 * DAY_MS,
    duration_added: 14 * DAY_MS,
    role_upgraded:  14 * DAY_MS,
    credential_request: 14 * DAY_MS,
    project_new:    30 * DAY_MS,
    maintenance:     3 * DAY_MS
};
var NOTE_TTL_DEFAULT = 14 * DAY_MS;
var NOTE_TTL_MAX     = 365 * DAY_MS;
/* Pesan lama yang ditulis sebelum ada expiresAt: dianggap berlaku 7 hari sejak dibuat. */
var NOTE_TTL_LEGACY  = 7 * DAY_MS;
/* Nilai `shown` yang membuat kartu pop-up tidak muncul lagi (sama dengan INBOX_MAX_SHOWS di hidzproject). */
var NOTE_SHOWN_DONE  = 3;

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
                type:  note.type || 'info',
                url:   note.url
            });
            return sendOne(t.path, t.sub, payload, ttl);
        }));
        results.forEach(function (ok) { if (ok) sent++; });
    }
    return sent;
}

/* Kapan notifikasi ini berakhir (epoch ms). */
function expiryFor(note, now) {
    var wanted = Number(note && note.expiresAt);
    var ttl = NOTE_TTL[note && note.type] || NOTE_TTL_DEFAULT;
    var end = wanted > now ? wanted : now + ttl;
    return Math.min(end, now + NOTE_TTL_MAX);
}

function isExpiredNote(n, now) {
    if (!n || typeof n !== 'object') return false;
    var end = Number(n.expiresAt);
    if (end > 0) return end <= now;
    var created = Number(n.createdAt);
    return created > 0 && now - created > NOTE_TTL_LEGACY;
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
    if (entry.userId)    rec.userId    = entry.userId;
    if (entry.accounts)  rec.accounts  = entry.accounts;
    if (entry.expiresAt) rec.expiresAt = entry.expiresAt;
    if (entry.ref)       rec.ref       = entry.ref;

    var saved = await db.setPath(LOG_PATH + '/' + id, rec);
    if (!saved) console.warn('[push] riwayat notifikasi gagal ditulis ke Firebase.');
    return saved;
}

/* Buang notifikasi yang masa berlakunya sudah habis. Halaman penerima juga menghapus miliknya sendiri
   saat terbuka, tapi akun yang lama tidak dibuka akan menumpuk — jadi dibersihkan di sini setiap ada
   pengiriman baru. Satu akun saja kalau `userId` diisi, kalau tidak semua akun.
   Balikan: jumlah yang dibuang (0 kalau tidak ada atau gagal — tidak pernah melempar error). */
async function pruneExpired(userId) {
    try {
        var now = Date.now();
        var inbox = {};
        if (userId) inbox[userId] = await db.fetchPath(INBOX_PATH + '/' + userId);
        else inbox = await db.fetchPath(INBOX_PATH);
        if (!inbox || typeof inbox !== 'object') return 0;

        var stale = {};
        Object.keys(inbox).forEach(function (uid) {
            var notes = inbox[uid];
            if (!ID_PATTERN.test(uid) || !notes || typeof notes !== 'object') return;
            Object.keys(notes).forEach(function (noteId) {
                if (isExpiredNote(notes[noteId], now)) stale[uid + '/' + noteId] = null;
            });
        });

        var count = Object.keys(stale).length;
        if (count && !(await db.updatePath(INBOX_PATH, stale))) return 0;
        return count;
    } catch (e) {
        return 0;
    }
}

/* Kabari satu akun: antrean dalam halaman + Web Push ke semua device-nya.
   note = { type, title, body }. Balikan: jumlah push yang terkirim. */
async function notifyUser(userId, note) {
    if (!userId || !note) return 0;

    var pushed = 0;
    try {
        var id    = newInboxId();
        var logId = newLogId();
        var now   = Date.now();
        var endsAt = expiryFor(note, now);
        await pruneExpired(userId);
        var queued = await db.setPath(INBOX_PATH + '/' + userId + '/' + id, {
            type:      note.type || 'info',
            title:     note.title,
            body:      note.body,
            createdAt: now,
            expiresAt: endsAt,
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
                scope: 'user', userId: userId, pushed: pushed, createdAt: now, expiresAt: endsAt
            });
        }
    } catch (e) { /* best-effort */ }
    return pushed;
}

/* Kabari SEMUA akun biasa lewat dua jalur sekaligus (project baru, voucher baru, maintenance dimulai):
   antrean dalam halaman milik tiap akun — sekaligus jadi riwayat notifikasinya — ditambah Web Push ke
   semua device yang sudah mengaktifkan notifikasi.

   Penerima: SEMUA akun user/VIP yang sudah dibuat, baik yang sudah pernah login maupun yang belum, baik
   yang durasinya masih jalan maupun yang sudah habis. Pesannya menunggu di antrean akun itu: akun yang
   sedang online langsung melihat kartunya, akun yang offline atau belum pernah login melihatnya (dan
   riwayatnya) begitu login, selama masa berlaku notifikasinya belum habis. Hanya akun admin yang dilewati.
   Notifikasi Chrome memakai id antrean akun itu sebagai tag, jadi begitu kartu dalam halaman tampil,
   notifikasi sistemnya ikut ditutup (sama seperti notifyUser).

   note.silent = true: masuk riwayat saja, tanpa kartu pop-up. Dipakai maintenance — layar maintenance
   sudah jadi peringatannya, dan kartu yang baru muncul sesudah maintenance selesai cuma menyesatkan.

   Balikan: { accounts, pushed } — jumlah akun penerima & push yang
   terkirim. null kalau daftar akun gagal dibaca atau antrean gagal ditulis,
   artinya belum ada yang terkirim. */
async function announce(note) {
    if (!note) return null;

    try {
        var accounts = await db.fetchAllAccounts();
        if (accounts === null) return null;

        var now = Date.now();
        var endsAt = expiryFor(note, now);
        var ref = REF_PATTERN.test(String(note.ref || '')) ? note.ref : '';
        await pruneExpired();
        var recipients = accounts.filter(function (u) {
            if (!u || !ID_PATTERN.test(String(u.id || ''))) return false;
            return !(u.id === ADMIN_ID || String(u.role || '').toLowerCase() === 'admin');
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
                expiresAt: endsAt,
                logId:     logId
            };
            if (ref) inbox[u.id + '/' + id].ref = ref;
            if (note.silent === true) inbox[u.id + '/' + id].shown = NOTE_SHOWN_DONE;
        });
        if (!(await db.updatePath(INBOX_PATH, inbox))) return null;

        var pushed = 0;
        if (pushReady()) {
            var subs = await db.fetchPath(SUBS_PATH);
            if (subs && typeof subs === 'object') {
                /* Langganan milik akun yang sudah dihapus tidak dikirimi apa-apa dan dibersihkan sekalian. */
                var alive = {};
                accounts.forEach(function (u) { alive[u.id] = true; });
                await Promise.all(Object.keys(subs).filter(function (uid) {
                    return uid !== ADMIN_ID && !alive[uid];
                }).map(function (uid) { return db.deletePath(SUBS_PATH + '/' + uid); }));

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
            scope: 'all', accounts: recipients.length, pushed: pushed, createdAt: now, expiresAt: endsAt, ref: ref
        });
        return { accounts: recipients.length, pushed: pushed };
    } catch (e) {
        return null;
    }
}

/* Notifikasi Chrome untuk pesan ADMIN di Chat Global yang membalas pesan seseorang atau menyebut (@) akun VIP.
   Pesan admin ditulis langsung ke Firebase dari panel, jadi panel memanggil ini sesudahnya (action 'chat-notify').
   Pesan dibaca ulang dari database: hanya pesan milik admin yang baru dikirim yang diproses, penerimanya
   diambil dari pesan itu sendiri, bukan dari kiriman browser. Akun yang dibalas/ditag tidak mendapat kartu
   di Riwayat Notifikasi (itu untuk kabar penting dari admin), hanya Web Push ke device-nya.
   Balikan: jumlah push yang terkirim (0 kalau tidak ada yang perlu dikirim atau gagal — tidak pernah melempar error). */
async function notifyChat(id) {
    try {
        if (typeof id !== 'string' || !CHAT_MESSAGE_ID.test(id)) return 0;
        var msg = await db.fetchPath(CHAT_PATH + '/' + id);
        if (!msg || msg.uid !== ADMIN_ID || msg.delAll === true || typeof msg.text !== 'string') return 0;
        if (Math.abs(Date.now() - Number(msg.ts)) > CHAT_FRESH_MS) return 0;

        var kinds = {};
        if (msg.reply && typeof msg.reply === 'object' && msg.reply.uid) kinds[msg.reply.uid] = 'reply';
        (Array.isArray(msg.mentions) ? msg.mentions : []).forEach(function (t) {
            if (t && t.uid) kinds[t.uid] = 'mention';
        });
        var uids = Object.keys(kinds).filter(function (uid) { return uid !== ADMIN_ID && ID_PATTERN.test(uid); }).slice(0, 10);
        if (!uids.length || !pushReady()) return 0;

        var subs = await Promise.all(uids.map(function (uid) { return db.fetchPath(SUBS_PATH + '/' + uid); }));
        var pushed = 0;
        for (var i = 0; i < uids.length; i++) {
            var devices = subs[i];
            if (!devices || typeof devices !== 'object') continue;
            var targets = Object.keys(devices).filter(function (d) { return ID_PATTERN.test(d); }).map(function (deviceId) {
                return { path: SUBS_PATH + '/' + uids[i] + '/' + deviceId, sub: devices[deviceId] };
            });
            var body = String(msg.text);
            if (body.length > 120) body = body.slice(0, 119).replace(/[\ud800-\udbff]$/, '').replace(/\s+$/, '') + '\u2026';
            pushed += await sendAll(targets, {
                title: String(msg.name || 'Hidz') + (kinds[uids[i]] === 'mention' ? ' menyebut kamu di Chat Global' : ' membalas pesanmu di Chat Global'),
                body: body,
                type: 'chat',
                url: CHAT_URL
            }, 'hidz-gc-' + id, 3600);
        }
        return pushed;
    } catch (e) {
        return 0;
    }
}

/* Penanda kelompok sebuah catatan riwayat. Catatan voucher yang ditulis sebelum ada field `ref` dikenali
   dari judulnya ("Voucher VIP Baru: KODE"). */
function refOfLog(entry) {
    if (REF_PATTERN.test(String(entry.ref || ''))) return entry.ref;
    var m = entry.type === 'voucher_new' && /^Voucher VIP Baru: ([A-Za-z0-9_-]{1,60})$/.exec(String(entry.title || ''));
    return m ? 'voucher:' + m[1] : '';
}

/* Voucher yang masih bisa dipakai: ada di daftar, belum berakhir, kuotanya belum habis. */
function voucherUsable(v, now) {
    if (!v || typeof v !== 'object') return false;
    var end = Number(v.expiresAt);
    if (end > 0 && end <= now) return false;
    var max = Math.floor(Number(v.maxUses)) > 0 ? Math.floor(Number(v.maxUses)) : 0;
    return !(max > 0 && (Number(v.usedCount) || 0) >= max);
}

/* Akun baru dibuat sesudah sebuah notifikasi dikirim ke semua akun, jadi tidak ikut menerimanya. Fungsi ini
   menyalin ke antrean akun itu (= riwayatnya) semua notifikasi "untuk semua akun" yang MASIH berlaku, lengkap
   dengan masa berlaku, waktu masuk, dan penanda aslinya — jadi ikut tertarik kalau admin menghapus riwayatnya
   atau voucher-nya. Belum dibaca, jadi kartunya muncul saat akun itu login pertama.

   Yang dilewati: maintenance (kabar sesaat, tidak berguna bagi akun baru), catatan yang sudah berakhir atau
   sudah dihapus admin, dan voucher yang sudah dihapus / berakhir / kuotanya habis. Voucher yang dibuat ulang
   dengan kode yang sama cukup disalin yang terbaru. Aman dipanggil dua kali: yang sudah ada tidak digandakan.

   Best-effort, tidak pernah melempar error. Balikan: jumlah notifikasi yang disalin. */
async function seedNewAccount(userId) {
    if (!userId || userId === ADMIN_ID || !ID_PATTERN.test(String(userId))) return 0;

    try {
        var now = Date.now();
        var log = await db.fetchPath(LOG_PATH);
        if (!log || typeof log !== 'object') return 0;

        var candidates = Object.keys(log)
            .filter(function (id) { return LOG_ID_PATTERN.test(id) && log[id] && typeof log[id] === 'object'; })
            .map(function (id) { return { id: id, e: log[id] }; })
            .filter(function (it) {
                var e = it.e;
                return e.scope === 'all' && e.type !== 'maintenance' && e.title && e.body && Number(e.expiresAt) > now;
            })
            .sort(function (a, b) { return (Number(b.e.createdAt) || 0) - (Number(a.e.createdAt) || 0); });
        if (!candidates.length) return 0;

        var vouchers = null;
        if (candidates.some(function (it) { return refOfLog(it.e).indexOf('voucher:') === 0; })) {
            vouchers = (await db.fetchPath(VOUCHER_PATH)) || {};
        }

        var mine = await db.fetchPath(INBOX_PATH + '/' + userId);
        var has = {};
        if (mine && typeof mine === 'object') {
            Object.keys(mine).forEach(function (k) { if (mine[k] && mine[k].logId) has[mine[k].logId] = true; });
        }

        var taken = {};
        var writes = {};
        var count = 0;
        candidates.forEach(function (it) {
            var ref = refOfLog(it.e);
            if (ref) {
                if (taken[ref]) return;          /* terbaru per penanda saja */
                taken[ref] = true;
                if (ref.indexOf('voucher:') === 0 && !voucherUsable(vouchers[ref.slice(8)], now)) return;
            }
            if (has[it.id]) return;

            var note = {
                type:      it.e.type || 'info',
                title:     it.e.title,
                body:      it.e.body,
                createdAt: Number(it.e.createdAt) || now,
                expiresAt: Number(it.e.expiresAt),
                logId:     it.id
            };
            if (ref) note.ref = ref;
            writes[userId + '/' + newInboxId()] = note;
            count++;
        });

        if (!count) return 0;
        return (await db.updatePath(INBOX_PATH, writes)) ? count : 0;
    } catch (e) {
        return 0;
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
                createdAt: Number(e.createdAt) || 0,
                expiresAt: Number(e.expiresAt) || 0
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

/* Hapus satu catatan riwayat sekaligus menarik pesannya dari riwayat
   notifikasi para penerima di HIDZPROJECT — yang sudah dibaca maupun belum
   (yang sudah dihapus penerimanya sendiri tentu tidak ada lagi).
   Balikan: null kalau id tidak valid, false kalau database gagal,
   selain itu { retracted } — jumlah pesan yang ditarik. */
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

/* Tarik semua pesan antrean bertanda salah satu `refs` dari riwayat HIDZPROJECT para penerima — yang sudah
   dibaca maupun belum. Catatan di Riwayat Notifikasi admin tidak disentuh (itu catatan apa yang pernah
   dikirim). Best-effort: tidak pernah melempar error, balikan jumlah pesan yang ditarik (0 kalau gagal). */
async function withdrawByRef(refs) {
    try {
        var wanted = {};
        (Array.isArray(refs) ? refs : [refs]).forEach(function (r) {
            if (REF_PATTERN.test(String(r || ''))) wanted[r] = true;
        });
        if (!Object.keys(wanted).length) return 0;

        var inbox = await db.fetchPath(INBOX_PATH);
        if (!inbox || typeof inbox !== 'object') return 0;

        var retract = {};
        Object.keys(inbox).forEach(function (uid) {
            var notes = inbox[uid];
            if (!ID_PATTERN.test(uid) || !notes || typeof notes !== 'object') return;
            Object.keys(notes).forEach(function (noteId) {
                if (notes[noteId] && wanted[notes[noteId].ref]) retract[uid + '/' + noteId] = null;
            });
        });

        var count = Object.keys(retract).length;
        if (count && !(await db.updatePath(INBOX_PATH, retract))) return 0;
        return count;
    } catch (e) {
        return 0;
    }
}

/* Hapus SELURUH riwayat: semua catatan di panel admin dan semua notifikasi di riwayat HIDZPROJECT
   milik semua akun. Dihapus tanpa melihat isinya dulu, jadi tetap tuntas walau pembacaan gagal.
   Balikan: false kalau database gagal, selain itu { deleted, retracted } — jumlah catatan riwayat
   dan jumlah notifikasi penerima yang terhapus. */
async function removeAllHistory() {
    try {
        var log   = await db.fetchPath(LOG_PATH);
        var inbox = await db.fetchPath(INBOX_PATH);

        var deleted = log && typeof log === 'object' ? Object.keys(log).length : 0;
        var retracted = 0;
        if (inbox && typeof inbox === 'object') {
            Object.keys(inbox).forEach(function (uid) {
                if (inbox[uid] && typeof inbox[uid] === 'object') retracted += Object.keys(inbox[uid]).length;
            });
        }

        if (!(await db.deletePath(INBOX_PATH))) return false;
        if (!(await db.deletePath(LOG_PATH))) return false;
        return { deleted: deleted, retracted: retracted };
    } catch (e) {
        return false;
    }
}

module.exports = {
    notifyUser: notifyUser,
    notifyChat: notifyChat,
    announce: announce,
    seedNewAccount: seedNewAccount,
    listHistory: listHistory,
    removeHistory: removeHistory,
    removeAllHistory: removeAllHistory,
    withdrawByRef: withdrawByRef,
    describeDuration: describeDuration
};
