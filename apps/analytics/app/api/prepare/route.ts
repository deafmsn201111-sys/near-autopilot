import { NextResponse } from 'next/server';
import { apiPost } from '../../../lib/api';

/**
 * Server proxy for `POST /v1/wallet/prepare`. The analytics API ASSEMBLES an unsigned, signable transaction cascade
 * for a recommendation's intent; this route forwards the request with the server-side API token (which never reaches
 * the browser) and returns the result verbatim. It is read-only: no key, no signature, nothing is sent on-chain.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<NextResponse> {
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
