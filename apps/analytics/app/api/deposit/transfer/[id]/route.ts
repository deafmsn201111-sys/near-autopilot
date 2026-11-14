import { NextResponse } from 'next/server';
import { tryApi } from '../../../../../lib/api';
import { consume } from '../../../../../lib/rate-limit';

/**
 * Server proxy for `GET /v1/deposit/transfer/:id`: the browser sends only our quote id; the API rebuilds the transfer
 * the origin wallet is asked for from the stored quote.
 */
export const dynamic = 'force-dynamic';

const LIMIT = { perVisitor: 30, overall: 1_000, windowMs: 10 * 60_000 };

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  if (!/^[\w-]{1,64}$/.test(id))
    return NextResponse.json({ error: 'Bad quote id.' }, { status: 400 });
  if (!(await consume('deposit-transfer', LIMIT))) {
    return NextResponse.json(
      { error: 'Too many requests. Wait a few minutes and try again.' },
      { status: 429, headers: { 'retry-after': String(LIMIT.windowMs / 1000) } },
    );
  }
  const { data, error, status } = await tryApi<unknown>(`/v1/deposit/transfer/${id}`);
  return data ? NextResponse.json(data) : NextResponse.json({ error }, { status: status || 502 });
}
