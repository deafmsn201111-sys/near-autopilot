import { NextResponse } from 'next/server';
import { apiPost } from '../../../lib/api';
import { consume } from '../../../lib/rate-limit';

/**
 * Server proxy for `POST /v1/wallet/prepare`. The analytics API ASSEMBLES an unsigned, signable transaction cascade
 * for a recommendation's intent; this route forwards the request with the server-side API token (which never reaches
 * the browser) and returns the result verbatim. It is read-only: no key, no signature, nothing is sent on-chain.
 */
export const dynamic = 'force-dynamic';

const LIMIT = { perVisitor: 30, overall: 600, windowMs: 10 * 60_000 };

function isJson(req: Request): boolean {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!isJson(req)) {
    return NextResponse.json({ error: 'content-type must be application/json' }, { status: 415 });
  }
  if (!(await consume('prepare', LIMIT))) {
    return NextResponse.json(
      { error: 'Too many requests. Wait a few minutes and try again.' },
      { status: 429, headers: { 'retry-after': String(LIMIT.windowMs / 1000) } },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const b = body as { account?: unknown; intent?: { action?: unknown } } | null;
  if (!b || typeof b.account !== 'string' || !b.intent || typeof b.intent.action !== 'string') {
    return NextResponse.json(
      { error: 'body must be { account, intent: { action, … } }' },
      { status: 400 },
    );
  }
  const { status, body: out } = await apiPost('/v1/wallet/prepare', body);
  return NextResponse.json(out, { status: status || 502 });
}
