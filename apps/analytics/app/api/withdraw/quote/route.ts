import type { NextResponse } from 'next/server';
import { proxyQuote } from '../../../../lib/quote-proxy';

/** Server proxy for `POST /v1/withdraw/quote`: a REAL 1Click quote from NEAR to another chain (#171). */
export const dynamic = 'force-dynamic';

export const POST = (req: Request): Promise<NextResponse> =>
  proxyQuote(req, '/v1/withdraw/quote', [
    'account',
    'originAsset',
    'destinationAsset',
    'amount',
    'recipient',
  ]);
