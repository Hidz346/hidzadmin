import fs from 'fs';
import path from 'path';

let cachedHtml = null;
export async function getServerSideProps({ res }) {
  if (!cachedHtml) cachedHtml = fs.readFileSync(path.join(process.cwd(), 'server-views/index.html'), 'utf8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.write(cachedHtml);
  res.end();
  return { props: {} };
}
export default function AdminPage() { return null; }
