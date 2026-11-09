import fs from 'fs';
import path from 'path';
import m from '../../server-views/api/admin-login.js';

export default async function handler(req, res) {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (body && body.ok && body.firebaseToken) {
      body.panelHtml = fs.readFileSync(path.join(process.cwd(), 'server-views/admin-panel.html'), 'utf8');
    }
    return origJson(body);
  };
  const fn = typeof m === 'function' ? m : (m && (m.default || m.handler));
  return await fn(req, res);
}
