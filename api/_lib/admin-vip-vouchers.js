var crypto = require('crypto');
var db = require('./db');

var DAY_MS = 86400000;
var MIN_PROVIDER_AMOUNT = 1000;
var MAX_VOUCHER_USES = 1000;
/* Dua angka ini sama dengan yang dipakai alur pembayaran di HIDZPROJECT (api/_lib/vip-vouchers.js) */
var RESERVE_GRACE_MS = 60 * 1000;
var LATE_PAY_GRACE_MS = 15 * 1000;

var DEFAULT_VIP_PLANS = [
    { id: '1d',  label: '1 Day',   days: 1,   price: 3000,   durationMs: 1 * DAY_MS,   durationLabel: '1 HARI' },
    { id: '3d',  label: '3 Day',   days: 3,   price: 5000,   durationMs: 3 * DAY_MS,   durationLabel: '3 HARI' },
    { id: '7d',  label: '7 Day',   days: 7,   price: 10000,  durationMs: 7 * DAY_MS,   durationLabel: '7 HARI' },
    { id: '14d', label: '14 Day',  days: 14,  price: 15000,  durationMs: 14 * DAY_MS,  durationLabel: '14 HARI' },
    { id: '1m',  label: '1 Month', days: 30,  price: 20000,  durationMs: 30 * DAY_MS,  durationLabel: '1 BULAN' },
    { id: '3m',  label: '3 Month', days: 90,  price: 30000,  durationMs: 90 * DAY_MS,  durationLabel: '3 BULAN' },
    { id: '5m',  label: '5 Month', days: 150, price: 50000,  durationMs: 150 * DAY_MS, durationLabel: '5 BULAN' },
    { id: '1y',  label: '1 Year',  days: 365, price: 100000, durationMs: 365 * DAY_MS, durationLabel: '1 TAHUN' }
];

async function getPlans() {
    var stored = await db.fetchPath('hidz_vip_plans');
    if (Array.isArray(stored) && stored.length === 8) return stored;
    await db.setPath('hidz_vip_plans', DEFAULT_VIP_PLANS);
    return DEFAULT_VIP_PLANS;
}

async function logVoucherHistory(entry) {
    var now = Date.now();
    var id = 'vh_' + now + '_' + crypto.randomBytes(3).toString('hex');
    var record = Object.assign({ id: id, timestamp: now, actor: 'Admin' }, entry);
    await db.setPath('hidz_voucher_history/' + id, record);
    return record;
}

/* Paket yang dicakup voucher: { idPaket: { planLabel, normalPrice, finalPrice, discountAmount, percent } }.
   Voucher lama hanya mencatat satu paket di kolom planId/finalPrice, jadi dibaca lewat sini juga. */
function voucherPlans(v) {
    if (v.plans && typeof v.plans === 'object' && Object.keys(v.plans).length) return v.plans;
    var map = {};
    if (v.planId) {
        var normal = Number(v.normalPrice), fin = Number(v.finalPrice);
        map[v.planId] = { planLabel: v.planLabel || v.planId, normalPrice: normal, finalPrice: fin, discountAmount: Math.max(0, normal - fin), percent: Number(v.percent) || 0 };
    }
    return map;
}

/* Voucher untuk dikirim ke panel atau disimpan sebagai snapshot riwayat: paket sudah seragam dan
   data akun pemakai (reserved/usedBy) tidak ikut. */
function publicVoucher(v, holding) {
    var copy = Object.assign({}, v);
    delete copy.reserved;
    delete copy.usedBy;
    copy.plans = voucherPlans(v);
    copy.planIds = Object.keys(copy.plans);
    copy.maxUses = Math.floor(Number(v.maxUses)) > 0 ? Math.floor(Number(v.maxUses)) : 0;
    copy.usedCount = Number(v.usedCount) || 0;
    copy.holding = holding || 0;
    return copy;
}

/* Jumlah slot yang sedang ditahan pesanan QRIS yang belum selesai (pesanan PENDING atau sudah dibayar
   tetapi belum dihitung). Aturannya sama dengan freedReservations di HIDZPROJECT. */
async function holdingCount(v, now) {
    var reserved = v.reserved || {}, held = 0;
    await Promise.all(Object.keys(reserved).map(async function (id) {
        var r = reserved[id] || {};
        if (now > Number(r.expiresAt) + LATE_PAY_GRACE_MS) return;
        var ord = await db.fetchPath('hidz_vip_orders/' + id);
        if (!ord || typeof ord !== 'object') { if (now - Number(r.createdAt) <= RESERVE_GRACE_MS) held++; return; }
        if (ord.status === 'PENDING' || ord.status === 'SUCCESS') held++;
    }));
    return held;
}

function planNames(ids, allPlans) {
    if (ids.length === allPlans.length) return 'Semua Paket';
    return allPlans.filter(function (p) { return ids.indexOf(p.id) !== -1; }).map(function (p) { return p.label; }).join(', ');
}

function rupiah(n) { return 'Rp ' + Number(n).toLocaleString('id-ID'); }

/* Hapus permanen voucher beserta seluruh riwayatnya. Riwayat dihapus lebih dulu:
   kalau langkah kedua gagal, voucher masih tampil di daftar dan bisa dihapus ulang,
   bukan meninggalkan riwayat yatim yang tidak bisa dibersihkan dari panel. */
async function purgeVouchers(codes, rawHistory) {
    var histWipe = {}, vchWipe = {};
    codes.forEach(function (c) { vchWipe[c] = null; });
    Object.keys(rawHistory).forEach(function (id) {
        var h = rawHistory[id];
        if (h && codes.indexOf(String(h.code || '').toUpperCase()) !== -1) histWipe[id] = null;
    });
    if (Object.keys(histWipe).length && !(await db.updatePath('hidz_voucher_history', histWipe))) return false;
    if (!(await db.updatePath('hidz_vouchers', vchWipe))) return false;
    Object.keys(histWipe).forEach(function (id) { delete rawHistory[id]; });
    return true;
}

function expectedVerificationCode(order) {
    var secret = process.env.VIP_RECEIPT_HMAC_SECRET || process.env.FIREBASE_DB_SECRET || 'hidz_default_hmac';
    var payload = [order.orderId, order.accountId, order.username, order.planId, order.totalAmount, order.paidAt || order.createdAt].join('|');
    return 'HZV-' + crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16).toUpperCase();
}

async function handleAdminAction(action, body, res) {
    var now = Date.now();
    var plans = await getPlans();

    if (action === 'vouchers') {
        var rawVouchers = (await db.fetchPath('hidz_vouchers')) || {};
        var rawHistory = (await db.fetchPath('hidz_voucher_history')) || {};

        /* Voucher yang dulu cuma ditandai "deleted" ikut dibersihkan bersama riwayatnya. */
        var staleCodes = Object.keys(rawVouchers).filter(function (k) { return rawVouchers[k] && rawVouchers[k].status === 'deleted'; });
        if (staleCodes.length && await purgeVouchers(staleCodes, rawHistory)) {
            staleCodes.forEach(function (c) { delete rawVouchers[c]; });
        }

        var vouchers = Object.values(rawVouchers).filter(function (v) { return v && v.code; }).sort(function (a, b) { return (Number(b.updatedAt || b.createdAt) || 0) - (Number(a.updatedAt || a.createdAt) || 0); });
        vouchers = await Promise.all(vouchers.map(async function (v) { return publicVoucher(v, await holdingCount(v, now)); }));
        var history = Object.values(rawHistory).filter(function (h) { return h && h.id; }).sort(function (a, b) { return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0); }).slice(0, 120);
        res.status(200).json({ ok: true, serverNow: now, plans: plans, vouchers: vouchers, history: history });
        return;
    }

    if (action === 'voucher-save') {
        var code = String(body.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,20}$/.test(code)) { res.status(200).json({ ok: false, message: 'Kode voucher wajib 4–20 karakter huruf/angka.' }); return; }
        var existing = await db.fetchPath('hidz_vouchers/' + code);

        if (body.mode === 'update-expiry') {
            if (!existing || !existing.code) { res.status(200).json({ ok: false, message: 'Voucher tidak ditemukan.' }); return; }
            var newExp = Number(body.expiresAt || 0);
            if (!newExp || isNaN(newExp) || newExp <= 0) { res.status(200).json({ ok: false, message: 'Masa berlaku baru tidak valid.' }); return; }
            var oldExp = Number(existing.expiresAt || 0);
            /* Hanya field masa berlaku yang diubah (PATCH). Menimpa seluruh voucher bisa menghapus slot
               yang baru saja dikunci pembeli, karena kuota voucher ditulis oleh alur pembayaran. */
            var expiryPatch = { expiresAt: newExp, updatedAt: now };
            if (existing.status === 'deleted' && body.restoreIfDeleted) expiryPatch.status = 'active';
            if (!(await db.updatePath('hidz_vouchers/' + code, expiryPatch))) { res.status(200).json({ ok: false, message: 'Gagal menyimpan masa berlaku. Coba lagi.' }); return; }
            var updated = Object.assign({}, existing, expiryPatch);
            var updatedView = publicVoucher(updated, 0);
            await logVoucherHistory({ code: code, action: 'expiry_updated', oldExpiresAt: oldExp, newExpiresAt: newExp, planId: updatedView.planIds[0], planIds: updatedView.planIds, planLabel: planNames(updatedView.planIds, plans), discountType: updated.discountType, percent: updated.percent, finalPrice: updated.finalPrice, maxUses: updatedView.maxUses, snapshot: updatedView });
            res.status(200).json({ ok: true, voucher: updatedView });
            return;
        }

        /* Paket: daftar planIds (satu, beberapa, atau semua). planId tunggal tetap diterima (panel versi lama). */
        var wantedIds = (Array.isArray(body.planIds) ? body.planIds : (body.planId ? [body.planId] : [])).map(function (id) { return String(id).trim(); });
        var chosen = plans.filter(function (p) { return wantedIds.indexOf(p.id) !== -1; });
        if (!chosen.length) { res.status(200).json({ ok: false, message: 'Pilih minimal satu paket VIP untuk voucher ini.' }); return; }
        if (chosen.length !== wantedIds.filter(function (id, i) { return wantedIds.indexOf(id) === i; }).length) {
            res.status(200).json({ ok: false, message: 'Ada paket VIP yang tidak dikenali.' }); return;
        }

        var discountType = body.discountType === 'custom' ? 'custom' : 'percent', percent = 0, planData = {}, tooLow = [];
        var rawPct = Number(body.percent);
        if (discountType === 'percent') {
            if (!isFinite(rawPct) || rawPct < 1 || rawPct > 99) { res.status(200).json({ ok: false, message: 'Diskon persen harus antara 1% sampai 99%.' }); return; }
            percent = Math.round(rawPct * 10) / 10;
        }
        var customPrices = (body.finalPrices && typeof body.finalPrices === 'object') ? body.finalPrices : {};
        for (var pi = 0; pi < chosen.length; pi++) {
            var pl = chosen[pi], normal = Number(pl.price), fin, pct;
            if (discountType === 'percent') {
                fin = Math.round(normal * (100 - percent) / 100);
                pct = percent;
            } else {
                var rawFin = customPrices[pl.id] !== undefined ? customPrices[pl.id] : (chosen.length === 1 ? body.finalPrice : undefined);
                fin = Math.round(Number(rawFin));
                if (rawFin === undefined || rawFin === null || String(rawFin).trim() === '' || !isFinite(fin)) { res.status(200).json({ ok: false, message: 'Isi harga akhir untuk paket ' + pl.label + '.' }); return; }
                if (fin >= normal) { res.status(200).json({ ok: false, message: 'Harga akhir paket ' + pl.label + ' harus lebih kecil dari harga normal (' + rupiah(normal) + ').' }); return; }
                pct = Math.round(((normal - fin) / normal) * 1000) / 10;
                if (pct < 1 || pct > 99) { res.status(200).json({ ok: false, message: 'Diskon paket ' + pl.label + ' harus antara 1%–99%.' }); return; }
            }
            if (fin < MIN_PROVIDER_AMOUNT) tooLow.push(pl.label + ' ' + rupiah(fin));
            planData[pl.id] = { planLabel: pl.label, normalPrice: normal, finalPrice: fin, discountAmount: normal - fin, percent: pct };
        }
        if (tooLow.length) {
            res.status(200).json({ ok: false, message: 'Harga akhir di bawah minimum QRIS (' + rupiah(MIN_PROVIDER_AMOUNT) + '): ' + tooLow.join(', ') + '. Kurangi diskonnya atau lepas paket itu.' });
            return;
        }

        /* Batas orang: kosong/0 = semua orang sampai voucher berakhir. */
        var maxUses = 0, rawMax = body.maxUses;
        if (rawMax !== undefined && rawMax !== null && String(rawMax).trim() !== '' && Number(rawMax) !== 0) {
            maxUses = Number(rawMax);
            if (!isFinite(maxUses) || maxUses < 1 || maxUses > MAX_VOUCHER_USES || Math.floor(maxUses) !== maxUses) {
                res.status(200).json({ ok: false, message: 'Batas orang harus bilangan bulat 1–' + MAX_VOUCHER_USES + ', atau kosongkan untuk semua orang.' }); return;
            }
        }

        var expiresAt = Number(body.expiresAt || 0);
        if (!expiresAt || expiresAt <= now) { res.status(200).json({ ok: false, message: 'Waktu berakhir voucher harus di masa depan.' }); return; }
        var isReuse = !!body.isReuse;
        if (existing && existing.status === 'active' && existing.expiresAt > now && !isReuse) {
            res.status(200).json({ ok: false, message: 'Kode voucher ' + code + ' masih aktif. Gunakan kode lain atau hapus dulu.' }); return;
        }

        var chosenIds = chosen.map(function (p) { return p.id; }), firstPlan = planData[chosenIds[0]];
        var voucherRecord = {
            code: code, planIds: chosenIds, planLabel: planNames(chosenIds, plans), plans: planData,
            /* Kolom satu-paket (paket pertama) tetap diisi supaya halaman user versi lama masih bisa membacanya. */
            planId: chosenIds[0], normalPrice: firstPlan.normalPrice, discountType: discountType, percent: percent,
            discountAmount: firstPlan.discountAmount, finalPrice: firstPlan.finalPrice, maxUses: maxUses, expiresAt: expiresAt,
            status: 'active', createdAt: (existing && existing.createdAt) ? existing.createdAt : now, updatedAt: now,
            /* Voucher berbatas orang mulai dengan kuota baru; voucher tanpa batas meneruskan hitungan pemakaian lamanya. */
            usedCount: (!maxUses && existing && typeof existing.usedCount === 'number') ? existing.usedCount : 0
        };
        /* Slot yang masih dikunci pesanan lama dibawa terus; slot itu lepas sendiri begitu pesanannya selesai atau kedaluwarsa. */
        if (existing && existing.reserved && typeof existing.reserved === 'object') voucherRecord.reserved = existing.reserved;
        if (!(await db.setPath('hidz_vouchers/' + code, voucherRecord))) { res.status(200).json({ ok: false, message: 'Gagal menyimpan voucher ke database. Coba lagi.' }); return; }
        var savedView = publicVoucher(voucherRecord, 0);
        await logVoucherHistory({ code: code, action: (existing && isReuse) ? 'restored' : 'created', oldExpiresAt: existing ? existing.expiresAt : null, newExpiresAt: expiresAt, planId: chosenIds[0], planIds: chosenIds, planLabel: voucherRecord.planLabel, discountType: discountType, percent: percent, finalPrice: firstPlan.finalPrice, maxUses: maxUses, snapshot: savedView });
        res.status(200).json({ ok: true, voucher: savedView });
        return;
    }

    if (action === 'voucher-delete') {
        var delCode = String(body.code || '').trim().toUpperCase();
        var targetV = await db.fetchPath('hidz_vouchers/' + delCode);
        if (!targetV || !targetV.code) { res.status(200).json({ ok: false, message: 'Voucher tidak ditemukan.' }); return; }
        var allHistory = (await db.fetchPath('hidz_voucher_history')) || {};
        if (!(await purgeVouchers([delCode], allHistory))) {
            res.status(200).json({ ok: false, message: 'Gagal menghapus voucher dari database. Coba lagi.' });
            return;
        }
        res.status(200).json({ ok: true, code: delCode });
        return;
    }

    if (action === 'vip-orders') {
        var rawOrders = (await db.fetchPath('hidz_vip_orders')) || {};
        /* Hanya mengubah tampilan: status di database dipindah oleh alur pembayaran (webhook / order-status)
           secara atomik. Menulis ulang pesanan dari sini bisa menimpa pembayaran yang baru masuk
           dan membuat pelanggan yang sudah bayar tidak ter-upgrade. */
        var allList = Object.values(rawOrders).filter(function (o) { return o && o.orderId; }).map(function (o) {
            if (o.status === 'PENDING' && now > Number(o.expiresAt)) return Object.assign({}, o, { status: 'EXPIRED' });
            return o;
        });
        allList.sort(function (a, b) { return (Number(b.paidAt || b.createdAt) || 0) - (Number(a.paidAt || a.createdAt) || 0); });
        var verifyCodeInput = String(body.verifyCode || '').trim().toUpperCase();
        var verifiedOrder = null;
        if (verifyCodeInput) {
            for (var j = 0; j < allList.length; j++) {
                var c = allList[j];
                if (c.status === 'SUCCESS') {
                    var expCode = expectedVerificationCode(c);
                    if ((c.verificationCode && c.verificationCode.toUpperCase() === verifyCodeInput) || expCode === verifyCodeInput) { verifiedOrder = c; break; }
                }
            }
        }
        res.status(200).json({ ok: true, serverNow: now, orders: allList, verifiedOrder: verifiedOrder });
        return;
    }

    res.status(200).json({ ok: false, message: 'Aksi admin VIP tidak dikenali.' });
}

module.exports = { handleAdminAction: handleAdminAction };
