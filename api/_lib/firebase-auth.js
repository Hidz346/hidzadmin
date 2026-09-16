/* Firebase Authentication custom-token helper.
   The private key is read only from server-side environment variables.
   Nothing from the service account is sent to the browser. */

var crypto = require('crypto');

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
        var signature = signer.sign(sa.private_key);
        resolve(unsigned + '.' + b64url(signature));
    });
}

module.exports = { createCustomToken: createCustomToken };
