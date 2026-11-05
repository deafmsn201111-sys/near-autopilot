import 'server-only';
import { cache } from 'react';
import { tryApi } from './api';

export * from './token-label';

/** One registry fetch per request (React cache), shared by every token on the page. */
export const tokenRegistry = cache(async (): Promise<Map<string, string>> => {
  const { data } = await tryApi<{ tokens: { token: string; symbol: string }[] }>(
    '/v1/analytics/tokens',
  );
  return new Map((data?.tokens ?? []).map((t) => [t.token, t.symbol]));
});
