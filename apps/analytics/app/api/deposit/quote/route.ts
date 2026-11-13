import { NextResponse } from 'next/server';
import { apiPost } from '../../../../lib/api';
import { consume } from '../../../../lib/rate-limit';

/**
 * Server proxy for `POST /v1/deposit/quote`: a REAL 1Click quote whose deposit address receives real money (D19). The
 * API checks the refund address, verifies the quote and stores it; this route only forwards the five form fields with
 * the server-side API token and limits how often a visitor may ask.
 */
export const dynamic = 'force-dynamic';

// Each quote mints a deposit address and a stored row: a person needs one or two, a bot is stopped here.
const LIMIT = { perVisitor: 5, overall: 100, windowMs: 10 * 60_000 };
// Above the API's worst case (token list + a real quote, 15 s each): a timeout here would hide a minted address.
const TIMEOUT_MS = 40_000;
const FIELDS = ['account', 'originAsset', 'destinationAsset', 'amount', 'refundTo'] as const;

function isJson(req: Request): boolean {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!isJson(req)) {
    return NextResponse.json({ error: 'content-type must be application/json' }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!FIELDS.every((f) => typeof b[f] === 'string')) {
    return NextResponse.json({ error: `body must be { ${FIELDS.join(', ')} }` }, { status: 400 });
  }
  if (!(await consume('deposit-quote', LIMIT))) {
    return NextResponse.json(
      { error: 'Too many quotes. Wait a few minutes and try again.' },
      { status: 429, headers: { 'retry-after': String(LIMIT.windowMs / 1000) } },
    );
  }
  const fields = Object.fromEntries(FIELDS.map((f) => [f, b[f]]));
  const { status, body: out } = await apiPost('/v1/deposit/quote', fields, TIMEOUT_MS);
  return NextResponse.json(out, { status: status || 502 });
}
