/* Firebase token helper for server-side admin authorization.
   Service-account credentials stay in server environment variables. */
var crypto = require('crypto');

var CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
var certCache = { keys: null, expiresAt: 0 };

function b64url(value) {
    return Buffer.from(value).toString('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function getServiceAccount() {
    var raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
    if (raw) {
        try {
            var parsed = JSON.parse(raw);
            if (parsed && parsed.client_email && parsed.private_key && parsed.project_id) return parsed;
        } catch (e) {}
    }
    var email = process.env.FIREBASE_CLIENT_EMAIL || '';
    var key = process.env.FIREBASE_PRIVATE_KEY || '';
    var projectId = process.env.FIREBASE_PROJECT_ID || 'hidzproject-8f335';
    if (!email || !key) return null;
    return { client_email: email, private_key: key.replace(/\\n/g, '\n'), project_id: projectId };
}

function createCustomToken(uid, claims) {
    return new Promise(function (resolve, reject) {
        var sa = getServiceAccount();
        if (!sa) return reject(new Error('FIREBASE_SERVICE_ACCOUNT_NOT_CONFIGURED'));
        if (!uid || String(uid).length > 128) return reject(new Error('INVALID_FIREBASE_UID'));
        var now = Math.floor(Date.now() / 1000);
        var header = { alg: 'RS256', typ: 'JWT' };
        var payload = {
            iss: sa.client_email,
            sub: sa.client_email,
            aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
            iat: now,
            exp: now + 3600,
            uid: String(uid)
        };
        if (claims && typeof claims === 'object') payload.claims = claims;
        var unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
        var signer = crypto.createSign('RSA-SHA256');
        signer.update(unsigned);
        signer.end();
        resolve(unsigned + '.' + b64url(signer.sign(sa.private_key)));
    });
}

async function getGoogleCerts() {
    var now = Date.now();
    if (certCache.keys && certCache.expiresAt > now) return certCache.keys;
    var response = await fetch(CERT_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('FIREBASE_CERT_FETCH_FAILED');
    var keys = await response.json();
    var cacheControl = String(response.headers.get('cache-control') || '');
    var match = cacheControl.match(/max-age=(\d+)/i);
    var ttl = match ? Number(match[1]) * 1000 : 3600000;
    certCache = { keys: keys, expiresAt: now + Math.max(60000, Math.min(ttl, 86400000)) };
    return keys;
}

function decodePart(part) {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function verifyIdToken(token) {
    if (!token || typeof token !== 'string') throw new Error('AUTH_REQUIRED');
    var parts = token.split('.');
    if (parts.length !== 3) throw new Error('INVALID_ID_TOKEN');
    var header = decodePart(parts[0]);
    var payload = decodePart(parts[1]);
    if (!header || header.alg !== 'RS256' || !header.kid) throw new Error('INVALID_ID_TOKEN');

    var projectId = (getServiceAccount() || {}).project_id || process.env.FIREBASE_PROJECT_ID || 'hidzproject-8f335';
    var now = Math.floor(Date.now() / 1000);
    if (payload.aud !== projectId || payload.iss !== 'https://securetoken.google.com/' + projectId ||
        !payload.sub || payload.sub !== payload.user_id || Number(payload.exp) <= now || Number(payload.iat) > now + 300) {
        throw new Error('INVALID_ID_TOKEN');
    }
    if (Number(payload.auth_time) > now + 300) throw new Error('INVALID_ID_TOKEN');

    var certs = await getGoogleCerts();
    var cert = certs[header.kid];
    if (!cert) {
        certCache.expiresAt = 0;
        certs = await getGoogleCerts();
        cert = certs[header.kid];
    }
    if (!cert) throw new Error('UNKNOWN_SIGNING_KEY');

    var verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(parts[0] + '.' + parts[1]);
    verifier.end();
    if (!verifier.verify(cert, Buffer.from(parts[2], 'base64url'))) throw new Error('INVALID_ID_TOKEN');
    return payload;
}

function bearerToken(req) {
    var value = req && req.headers ? req.headers.authorization : '';
    if (!value || !/^Bearer\s+/i.test(value)) return '';
    return value.replace(/^Bearer\s+/i, '').trim();
}

async function requireAdmin(req) {
    var claims = await verifyIdToken(bearerToken(req));
    if (claims.admin !== true || claims.role !== 'admin' || (claims.user_id || claims.sub) !== 'admin_hidz_protected') {
        throw new Error('ADMIN_REQUIRED');
    }
    return claims;
}

module.exports = {
    createCustomToken: createCustomToken,
    verifyIdToken: verifyIdToken,
    requireAdmin: requireAdmin,
    bearerToken: bearerToken
};
