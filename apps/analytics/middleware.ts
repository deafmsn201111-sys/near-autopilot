import { NextResponse, type NextRequest } from 'next/server';
import { contentSecurityPolicy } from './lib/csp';

export const isAdminPath = (path: string) => path === '/admin' || path.startsWith('/admin/');

/** A fresh nonce per page response. Next reads it from the request's CSP header and stamps its own scripts. */
export function middleware(request: NextRequest) {
  // A real 404 status before any streaming: notFound() inside the streamed layout would answer 200.
  if (isAdminPath(request.nextUrl.pathname) && process.env.ADMIN_UI !== '1')
    return new NextResponse('Not found', { status: 404 });
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
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|healthz).*)'],
};
