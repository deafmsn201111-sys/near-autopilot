import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from './lib/csp';
import { LOOPBACK_HOST } from './lib/admin-host';

export const isAdminPath = (path: string) => path === '/admin' || path.startsWith('/admin/');

/** A fresh nonce per page response. Next reads it from the request's CSP header and stamps its own scripts. */
export function middleware(request: NextRequest) {
  // A real 404 status before any streaming: notFound() inside the streamed layout would answer 200.
  const admin = process.env.ADMIN_UI === '1';
  if (isAdminPath(request.nextUrl.pathname) && !admin)
    return new NextResponse('Not found', { status: 404 });
  // The admin is opened through an SSH tunnel on a loopback address; any other Host is a DNS-rebinding page.
  if (admin && !LOOPBACK_HOST.test(request.headers.get('host') ?? ''))
    return new NextResponse('Forbidden', { status: 403 });
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  // /api included: the admin container's loopback Host check must cover its route handlers too.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|healthz).*)'],
};
