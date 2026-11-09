import { NextResponse } from 'next/server';

const BLOCKED_PATHS = /^\/(\.env|\.git|wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|server-status|cgi-bin)/i;
const BAD_BOTS = /(curl\/|wget\/|python-requests|httpx|libwww-perl|scrapy|httrack|go-http-client)/i;

export function middleware(req) {
  const { pathname } = req.nextUrl;
  const ua = req.headers.get('user-agent') || '';
  if (BLOCKED_PATHS.test(pathname)) return new NextResponse('Forbidden', { status: 403 });
  if (!pathname.startsWith('/api/') && BAD_BOTS.test(ua)) return new NextResponse('Forbidden', { status: 403 });
  return NextResponse.next();
}
