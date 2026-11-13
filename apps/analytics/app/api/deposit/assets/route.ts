import { NextResponse } from 'next/server';
import { tryApi } from '../../../../lib/api';

/** Server proxy for `GET /v1/deposit/assets`: the tokens a deposit may come from and arrive as (cached by the API). */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const { data, error, status } = await tryApi<unknown>('/v1/deposit/assets');
  return data ? NextResponse.json(data) : NextResponse.json({ error }, { status: status || 502 });
}
