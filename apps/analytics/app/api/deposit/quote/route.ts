import type { NextResponse } from 'next/server';
import { proxyQuote } from '../../../../lib/quote-proxy';

/** Server proxy for `POST /v1/deposit/quote`: a REAL 1Click quote whose deposit address receives real money (D19). */
export const dynamic = 'force-dynamic';

export const POST = (req: Request): Promise<NextResponse> =>
  proxyQuote(req, '/v1/deposit/quote', [
    'account',
    'originAsset',
    'destinationAsset',
    'amount',
    'refundTo',
  ]);
