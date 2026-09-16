/* Read-only security dashboard for the administrator. */
var db = require('../_lib/db');
module.exports = async function (req, res) {
    if (req.method !== 'POST') { res.status(405).json({ ok:false }); return; }
    var body = req.body || {};
    var username = typeof body.username === 'string' ? body.username : '';
    var password = typeof body.password === 'string' ? body.password : '';
    var auth = await db.verifyAdmin(req, username, password);
    if (!auth.ok) { res.status(auth.locked ? 429 : 403).json(auth.locked ? {ok:false,locked:true,retryAfterSec:auth.retryAfterSec} : {ok:false}); return; }
    var events = await db.fetchPath('hidz_security_events');
    var blocks = await db.fetchPath('hidz_security_ip_blocks');
    function vals(x){
        if (!x || typeof x !== 'object') return [];
        return Object.keys(x).map(function(k){ return Object.assign({id:k}, x[k] || {}); });
    }
    events = vals(events).sort(function(a,b){ return (b.attemptAt||0)-(a.attemptAt||0); }).slice(0,50);
    blocks = vals(blocks).filter(function(x){ return x.blocked && Number(x.blockedUntil||0) > Date.now(); }).sort(function(a,b){ return (b.blockedAt||0)-(a.blockedAt||0); });
    res.status(200).json({ ok:true, events:events, blocks:blocks });
};
