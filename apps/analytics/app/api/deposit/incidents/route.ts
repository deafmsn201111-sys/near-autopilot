import { NextResponse, type NextRequest } from 'next/server';
import { tryApi } from '../../../../lib/api';

/** Server proxy for `GET /v1/deposit/incidents`: 1Click SHIELD incidents on the chosen route. A failure is no incident. */
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = req.nextUrl.searchParams.get('origin') ?? '';
  const destination = req.nextUrl.searchParams.get('destination') ?? '';
  const query = new URLSearchParams({ origin, destination });
  const { data } = await tryApi<unknown>(`/v1/deposit/incidents?${query}`);
  return NextResponse.json(data ?? { incidents: [] });
}
