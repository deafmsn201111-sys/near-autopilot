import { NextResponse } from 'next/server';
import { forwardJson } from '../../../lib/json-proxy';

/**
 * Asks the API to check a signed step with NEAR RPC. The browser only names the hash; the API decides whether it
 * happened, so a page script cannot fake a confirmed transaction.
 */
export const dynamic = 'force-dynamic';

const LIMIT = { perVisitor: 60, overall: 1200, windowMs: 10 * 60_000 };

export async function POST(req: Request): Promise<NextResponse> {
  return forwardJson(req, 'confirm', LIMIT, '/v1/wallet/confirm', (b) => {
    const c = b as { account?: unknown; cascadeId?: unknown; step?: unknown; hash?: unknown } | null;
    return c &&
      typeof c.account === 'string' &&
      typeof c.cascadeId === 'string' &&
      typeof c.step === 'number' &&
      typeof c.hash === 'string'
      ? { account: c.account, cascadeId: c.cascadeId, step: c.step, hash: c.hash }
      : null;
  });
}
