var crypto = require('crypto');
var db = require('./db');

var DAY_MS = 86400000;
var MIN_PROVIDER_AMOUNT = 1000;

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
        var vouchers = Object.values(rawVouchers).filter(function (v) { return v && v.code; }).sort(function (a, b) { return (Number(b.updatedAt || b.createdAt) || 0) - (Number(a.updatedAt || a.createdAt) || 0); });
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
            existing.expiresAt = newExp; existing.updatedAt = now;
            if (existing.status === 'deleted' && body.restoreIfDeleted) existing.status = 'active';
            await db.setPath('hidz_vouchers/' + code, existing);
            await logVoucherHistory({ code: code, action: 'expiry_updated', oldExpiresAt: oldExp, newExpiresAt: newExp, planId: existing.planId, planLabel: existing.planLabel, discountType: existing.discountType, percent: existing.percent, finalPrice: existing.finalPrice, snapshot: existing });
            res.status(200).json({ ok: true, voucher: existing });
            return;
        }

        var plan = plans.filter(function (p) { return p.id === String(body.planId || '').trim(); })[0];
        if (!plan) { res.status(200).json({ ok: false, message: 'Pilih salah satu dari 8 paket VIP.' }); return; }
        var normalPrice = Number(plan.price), discountType = body.discountType === 'custom' ? 'custom' : 'percent', finalPrice = 0, percent = 0;

        if (discountType === 'percent') {
            var rawPct = Number(body.percent);
            if (!isFinite(rawPct) || rawPct < 1 || rawPct > 99) { res.status(200).json({ ok: false, message: 'Diskon persen harus antara 1% sampai 99%.' }); return; }
            percent = Math.round(rawPct * 10) / 10;
            finalPrice = Math.round(normalPrice * (100 - percent) / 100);
        } else {
            finalPrice = Math.round(Number(body.finalPrice));
            if (!isFinite(finalPrice) || finalPrice >= normalPrice) { res.status(200).json({ ok: false, message: 'Harga akhir harus lebih kecil dari harga normal.' }); return; }
            percent = Math.round(((normalPrice - finalPrice) / normalPrice) * 1000) / 10;
            if (percent < 1 || percent > 99) { res.status(200).json({ ok: false, message: 'Persentase diskon harus antara 1%–99%.' }); return; }
        }

        if (finalPrice < MIN_PROVIDER_AMOUNT) {
            res.status(200).json({ ok: false, message: 'Harga akhir (Rp ' + finalPrice.toLocaleString('id-ID') + ') di bawah minimum QRIS (Rp ' + MIN_PROVIDER_AMOUNT.toLocaleString('id-ID') + ').' });
            return;
        }

        var expiresAt = Number(body.expiresAt || 0);
        if (!expiresAt || expiresAt <= now) { res.status(200).json({ ok: false, message: 'Waktu berakhir voucher harus di masa depan.' }); return; }
        var isReuse = !!body.isReuse;
        if (existing && existing.status === 'active' && existing.expiresAt > now && !isReuse) {
            res.status(200).json({ ok: false, message: 'Kode voucher ' + code + ' masih aktif. Gunakan kode lain atau hapus dulu.' }); return;
        }

        var voucherRecord = {
            code: code, planId: plan.id, planLabel: plan.label, normalPrice: normalPrice, discountType: discountType,
            percent: percent, discountAmount: normalPrice - finalPrice, finalPrice: finalPrice, expiresAt: expiresAt,
            status: 'active', createdAt: (existing && existing.createdAt) ? existing.createdAt : now, updatedAt: now,
            usedCount: (existing && typeof existing.usedCount === 'number') ? existing.usedCount : 0
        };
        await db.setPath('hidz_vouchers/' + code, voucherRecord);
        await logVoucherHistory({ code: code, action: (existing && isReuse) ? 'restored' : 'created', oldExpiresAt: existing ? existing.expiresAt : null, newExpiresAt: expiresAt, planId: plan.id, planLabel: plan.label, discountType: discountType, percent: percent, finalPrice: finalPrice, snapshot: voucherRecord });
        res.status(200).json({ ok: true, voucher: voucherRecord });
        return;
    }

    if (action === 'voucher-delete') {
        var delCode = String(body.code || '').trim().toUpperCase();
        var targetV = await db.fetchPath('hidz_vouchers/' + delCode);
        if (!targetV || !targetV.code) { res.status(200).json({ ok: false, message: 'Voucher tidak ditemukan.' }); return; }
        targetV.status = 'deleted'; targetV.deletedAt = now; targetV.updatedAt = now;
        await db.setPath('hidz_vouchers/' + delCode, targetV);
        await logVoucherHistory({ code: delCode, action: 'deleted', oldExpiresAt: targetV.expiresAt, newExpiresAt: targetV.expiresAt, planId: targetV.planId, planLabel: targetV.planLabel, discountType: targetV.discountType, percent: targetV.percent, finalPrice: targetV.finalPrice, snapshot: targetV });
        res.status(200).json({ ok: true, voucher: targetV });
        return;
    }

    if (action === 'vip-orders') {
        var rawOrders = (await db.fetchPath('hidz_vip_orders')) || {};
        var allList = Object.values(rawOrders).filter(function (o) { return o && o.orderId; });
        for (var i = 0; i < allList.length; i++) {
            var ord = allList[i];
            if (ord.status === 'PENDING' && now > Number(ord.expiresAt)) {
                ord.status = 'EXPIRED'; ord.expiredAt = now;
                await db.setPath('hidz_vip_orders/' + ord.orderId, ord);
            }
        }
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
