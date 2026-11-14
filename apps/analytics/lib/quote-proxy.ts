import { NextResponse } from 'next/server';
import { apiPost } from './api';
import { consume } from './rate-limit';

// Each quote mints a deposit address and a stored row: a person needs one or two, a bot is stopped here.
const LIMIT = { perVisitor: 5, overall: 100, windowMs: 10 * 60_000 };
// Above the API's worst case (token list + a real quote, 15 s each): a timeout here would hide a minted address.
const TIMEOUT_MS = 40_000;

function isJson(req: Request): boolean {
  const type = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

/**
 * Forwards exactly `fields` (all strings) of a REAL 1Click quote request to the API with the server-side token, under
 * one rate limit shared by deposits and withdrawals. The API checks every field, verifies the quote and stores it.
 */
export async function proxyQuote(
  req: Request,
  path: string,
  fields: readonly string[],
): Promise<NextResponse> {
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
  if (!fields.every((f) => typeof b[f] === 'string')) {
    return NextResponse.json({ error: `body must be { ${fields.join(', ')} }` }, { status: 400 });
  }
  if (!(await consume('deposit-quote', LIMIT))) {
    return NextResponse.json(
      { error: 'Too many quotes. Wait a few minutes and try again.' },
      { status: 429, headers: { 'retry-after': String(LIMIT.windowMs / 1000) } },
    );
  }
  const { status, body: out } = await apiPost(
    path,
    Object.fromEntries(fields.map((f) => [f, b[f]])),
    TIMEOUT_MS,
  );
  return NextResponse.json(out, { status: status || 502 });
}
