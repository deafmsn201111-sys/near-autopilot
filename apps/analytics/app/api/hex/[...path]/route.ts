import { NextResponse } from 'next/server';
import { consume, RATE_LIMITED } from '../../../../lib/rate-limit';

/**
 * Same-origin proxy for HOT Kit's bridge popup (D42): hex-api.app answers browsers only from its own origins, so the
 * kit's 1Click and market calls come here and go on server-side, without the visitor's origin or cookies. Only the
 * paths the bridge needs pass; the kit verifies every 1Click quote signature itself.
 */
export const dynamic = 'force-dynamic';

const HEX_API = 'https://hex-api.app/';
const SEGMENT = '[A-Za-z0-9%_:-][A-Za-z0-9%_:.-]*';
const ROUTES = {
  GET: new RegExp(
    `^market/v1/(prices|tokens/${SEGMENT}|trending|trending/${SEGMENT}|1click/v0/tokens|1click/v0/status)$`,
  ),
  POST: /^market\/v1\/1click\/v0\/(quote|deposit\/submit)$/,
};
const LIMITS = {
  GET: { perVisitor: 600, overall: 30_000, windowMs: 10 * 60_000 },
  POST: { perVisitor: 120, overall: 5_000, windowMs: 10 * 60_000 },
};
const MAX_BODY = 16_384;
const TIMEOUT_MS = 20_000;

async function forward(req: Request, method: 'GET' | 'POST'): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/hex\//, '');
  if (!ROUTES[method].test(path))
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  if (!(await consume(`hex-${method}`, LIMITS[method])))
    return NextResponse.json(
      { error: RATE_LIMITED },
      { status: 429, headers: { 'retry-after': String(LIMITS[method].windowMs / 1000) } },
    );
  let body: string | undefined;
  if (method === 'POST') {
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
      return NextResponse.json({ error: 'content-type must be application/json' }, { status: 415 });
    const length = Number(req.headers.get('content-length') ?? NaN);
    if (!(length <= MAX_BODY)) return NextResponse.json({ error: 'Too large.' }, { status: 413 });
    body = await req.text();
    if (body.length > MAX_BODY) return NextResponse.json({ error: 'Too large.' }, { status: 413 });
  }
  try {
    const res = await fetch(`${HEX_API}${path}${url.search}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ error: 'HOT is unreachable right now.' }, { status: 502 });
  }
}

export const GET = (req: Request) => forward(req, 'GET');
export const POST = (req: Request) => forward(req, 'POST');
