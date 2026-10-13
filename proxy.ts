import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optimistic gate for the manager console: no Better Auth session cookie -> /app/login. This only checks that a
 * cookie exists (cheap, edge-safe); every page and API route still validates the session on the server.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === '/app/login') return NextResponse.next();
  const hasSession = request.cookies
    .getAll()
    .some((c) => c.name.endsWith('better-auth.session_token'));
  if (!hasSession) {
    const url = new URL('/app/login', request.url);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/app', '/app/:path*'] };
