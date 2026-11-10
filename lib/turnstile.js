'use strict';
const crypto = require('crypto');
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/* Sama dengan masa simpan di browser (30 menit) + 1 menit toleransi, supaya pass yang
   masih dianggap berlaku oleh halaman tidak ditolak server. */
const PASS_TTL_MS = 31 * 60 * 1000;

function getSiteKey() { return String(process.env.TURNSTILE_SITE_KEY || '').trim(); }
function getSecretKey() { return String(process.env.TURNSTILE_SECRET_KEY || '').trim(); }

/* Site key itu publik. Disisipkan langsung ke HTML gate supaya browser tidak perlu
   satu panggilan API dulu sebelum bisa memuat widget. Kalau belum diatur, dibiarkan kosong
   dan halaman memakai jalur lama (turnstile-config) sehingga pesan galatnya tetap muncul. */
function injectSiteKey(html) {
    const key = getSiteKey().replace(/[^A-Za-z0-9_-]/g, '');
    return key ? String(html).replace('data-sitekey=""', 'data-sitekey="' + key + '"') : String(html);
}

function getClientIp(req) {
    const xff = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '';
    const first = String(xff).split(',')[0].trim();
    return first || String(req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '0.0.0.0').trim();
}

function getBody(req) {
    if (!req.body) return {};
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (e) { return {}; }
    }
    return {};
}

function decodeHexOrRaw(val) {
    const s = String(val || '').trim();
    if (s.length >= 32 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
        try { return Buffer.from(s, 'hex').toString('utf8'); } catch (e) { return s; }
    }
    return s;
}

function encodeHex(str) { return Buffer.from(String(str || ''), 'utf8').toString('hex'); }
function ipDigest(ip, secret) {
    return crypto.createHmac('sha256', secret).update(String(ip || '0.0.0.0')).digest('hex').slice(0, 24);
}

function createTurnstilePass(ip) {
    const secret = getSecretKey();
    if (!secret) return '';
    const iat = Date.now(), ipHash = ipDigest(ip, secret);
    const payload = `v1.${iat}.${ipHash}`;
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return encodeHex(`${payload}.${sig}`);
}

function verifyTurnstilePass(passInput, ip) {
    const secret = getSecretKey();
    if (!secret) return false;
    const parts = decodeHexOrRaw(passInput).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const iat = Number(parts[1]), ipHash = parts[2], sig = parts[3];
    if (!Number.isFinite(iat) || Math.abs(Date.now() - iat) > PASS_TTL_MS) return false;
    if (ipHash !== ipDigest(ip, secret)) return false;
    const expected = crypto.createHmac('sha256', secret).update(`v1.${iat}.${ipHash}`).digest('hex');
    try {
        const a = Buffer.from(sig, 'hex'), b = Buffer.from(expected, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) { return false; }
}

async function verifyTurnstileToken(tokenInput, ip) {
    const secret = getSecretKey();
    if (!secret) return { ok: false, reason: 'turnstile_unconfigured', message: 'TURNSTILE_SECRET_KEY belum diatur di Vercel.' };
    const token = decodeHexOrRaw(tokenInput);
    if (!token || token.length > 4096) return { ok: false, reason: 'turnstile_failed', message: 'Token verifikasi tidak ditemukan.' };
    const params = new URLSearchParams({ secret, response: token });
    if (ip && ip !== '0.0.0.0') params.set('remoteip', ip);
    try {
        const r = await fetch(SITEVERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const d = await r.json();
        if (d && d.success === true) return { ok: true };
        return { ok: false, reason: 'turnstile_failed', message: 'Verifikasi Cloudflare gagal atau kedaluwarsa. Silakan ulangi.' };
    } catch (e) {
        return { ok: false, reason: 'turnstile_failed', message: 'Gagal menghubungi server verifikasi Cloudflare.' };
    }
}

async function handleTurnstileGateActions(req, res) {
    const body = getBody(req), action = String(body.action || '').trim();
    if (action === 'turnstile-config') { res.status(200).json({ ok: true, siteKey: getSiteKey() }); return true; }
    if (action === 'verify-turnstile') {
        const ip = getClientIp(req), out = await verifyTurnstileToken(body.turnstileToken, ip);
        if (!out.ok) { res.status(403).json(out); return true; }
        res.status(200).json({ ok: true, turnstilePass: createTurnstilePass(ip) });
        return true;
    }
    return false;
}

async function requireTurnstileForLogin(req, res) {
    const body = getBody(req), ip = getClientIp(req);
    if (body.turnstilePass && verifyTurnstilePass(body.turnstilePass, ip)) return true;
    if (body.turnstileToken) {
        const check = await verifyTurnstileToken(body.turnstileToken, ip);
        if (check.ok) return true;
        res.status(403).json(check);
        return false;
    }
    res.status(403).json({ ok: false, reason: 'turnstile_failed', message: 'Verifikasi keamanan Cloudflare wajib diselesaikan.' });
    return false;
}

module.exports = { getSiteKey, getSecretKey, injectSiteKey, handleTurnstileGateActions, requireTurnstileForLogin };
