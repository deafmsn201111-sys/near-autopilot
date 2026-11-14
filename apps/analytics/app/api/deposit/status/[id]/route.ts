import { NextResponse } from 'next/server';
import { tryApi } from '../../../../../lib/api';
import { consume } from '../../../../../lib/rate-limit';

/**
 * Server proxy for `GET /v1/deposit/status/:id`: the browser sends only our quote id; the API looks up the deposit
 * address, asks 1Click (with the JWT, if set) and caches the answer for a few seconds.
 */
export const dynamic = 'force-dynamic';

// A tab backing off to 30 s checks about 25 times in 10 minutes; this leaves room for two tabs and "check again".
// The overall cap is loose: the API serves each quote from a 5 s cache, so 1Click sees one call per quote at most.
const STATUS_LIMIT = { perVisitor: 60, overall: 10_000, windowMs: 10 * 60_000 };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!/^[\w-]{1,64}$/.test(id))
    return NextResponse.json({ error: 'Bad quote id.' }, { status: 400 });
  if (!(await consume('deposit-status', STATUS_LIMIT))) {
    return NextResponse.json(
      { error: 'Too many status checks. Wait a few minutes and check again.' },
      { status: 429, headers: { 'retry-after': String(STATUS_LIMIT.windowMs / 1000) } },
    );
  }
  const { data, error, status } = await tryApi<unknown>(`/v1/deposit/status/${id}`);
  return data ? NextResponse.json(data) : NextResponse.json({ error }, { status: status || 502 });
}
