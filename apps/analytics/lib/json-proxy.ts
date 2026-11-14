import 'server-only';
import { NextResponse } from 'next/server';
import { apiPost } from './api';
import { consume, type Limit } from './rate-limit';

const isJson = (req: Request) =>
  req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json';

/**
 * A public JSON-only, rate-limited POST forwarded to the API with the server-side token. `pick` keeps only the known
 * fields (null = refuse), so nothing else from the browser, its headers included, reaches the API.
 */
export async function forwardJson(
  req: Request,
  kind: string,
  limit: Limit,
  path: string,
  pick: (body: unknown) => Record<string, unknown> | null,
): Promise<NextResponse> {
  if (!isJson(req))
    return NextResponse.json({ error: 'content-type must be application/json' }, { status: 415 });
  if (!(await consume(kind, limit)))
    return NextResponse.json(
      { error: 'Too many requests. Wait a few minutes and try again.' },
      { status: 429, headers: { 'retry-after': String(limit.windowMs / 1000) } },
    );
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const picked = pick(body);
  if (!picked) return NextResponse.json({ error: 'invalid request' }, { status: 400 });
  const { status, body: out } = await apiPost(path, picked);
  return NextResponse.json(out, { status: status || 502 });
}
