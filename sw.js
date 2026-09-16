/* ============================================================
 * HidzProject — Service Worker
 * Fokusnya cuma dua: (1) biar hidzproject.html bisa di-"Add to
 * Home Screen" kayak app asli, (2) tetap bisa kebuka pas offline
 * (nampilin shell halaman terakhir yang sempat dimuat).
 *
 * SENGAJA nggak nge-cache Firebase/CDN/API sama sekali — semua
 * request selain navigasi halaman dibiarkan lewat apa adanya,
 * supaya data real-time (status login, maintenance, promo,
 * pengumuman, Konseling, dll) selalu ambil yang paling baru,
 * bukan versi basi dari cache.
 * ============================================================ */

var CACHE_NAME = 'hidzproject-shell-v1';
var SHELL_URL = './';

self.addEventListener('install', function (event) {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            return cache.addAll([SHELL_URL]).catch(function () {
                /* Offline pas pertama kali install service worker — gapapa,
                   nanti ke-cache otomatis begitu ada koneksi & halaman dibuka. */
            });
        })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(
                keys.filter(function (k) { return k !== CACHE_NAME; })
                    .map(function (k) { return caches.delete(k); })
            );
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    var req = event.request;

    /* Cuma tangani navigasi ke halaman utama. Semua request lain
       (Firebase SDK, Firebase Realtime Database, Font Awesome, Google
       Fonts, gambar, dll) dibiarkan lewat langsung tanpa disentuh. */
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then(function (res) {
                    var resClone = res.clone();
                    caches.open(CACHE_NAME).then(function (cache) { cache.put(SHELL_URL, resClone); });
                    return res;
                })
                .catch(function () {
                    return caches.match(SHELL_URL);
                })
        );
    }
});
