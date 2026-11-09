import m from "../../../server-views/api/admin/security-alerts.js";
export default async function handler(req,res){const fn=typeof m==="function"?m:(m&&(m.default||m.handler));return await fn(req,res);}
