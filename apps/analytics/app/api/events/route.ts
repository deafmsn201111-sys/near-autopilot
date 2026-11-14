import { type NextResponse } from 'next/server';
import { forwardJson } from '../../../lib/json-proxy';

/** The browser reports a wallet connect (stored as client-reported). Account id only; the visitor's IP is never sent. */
export const dynamic = 'force-dynamic';

const LIMIT = { perVisitor: 10, overall: 300, windowMs: 10 * 60_000 };

export async function POST(req: Request): Promise<NextResponse> {
  return forwardJson(req, 'events', LIMIT, '/v1/events', (b) => {
    const e = b as { kind?: unknown; account?: unknown } | null;
    return e?.kind === 'connect' && typeof e.account === 'string'
      ? { kind: 'connect', account: e.account }
      : null;
  });
}
