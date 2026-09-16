var db = require('../_lib/db');
module.exports = async function (req, res) {
    if (req.method !== 'POST') { res.status(405).json({ok:false}); return; }
    var body=req.body||{};
    var auth=await db.verifyAdmin(req, typeof body.username==='string'?body.username:'', typeof body.password==='string'?body.password:'');
    if(!auth.ok){res.status(auth.locked?429:403).json(auth.locked?{ok:false,locked:true,retryAfterSec:auth.retryAfterSec}:{ok:false});return;}
    var ip=typeof body.ip==='string'?body.ip.trim():'';
    if(!ip){res.status(400).json({ok:false});return;}
    var crypto=require('crypto');
    var key=crypto.createHash('sha256').update(ip).digest('hex').slice(0,48);
    var ok=await db.deletePath('hidz_security_ip_blocks/'+key);
    res.status(200).json({ok:ok});
};
