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

export async function tokenIcons(ids: readonly string[]): Promise<Record<string, string | null>> {
  const unique = [...new Set(ids)].slice(0, 100);
  if (unique.length === 0) return {};
  const { data } = await tryApi<{ icons: Record<string, string | null> }>(
    `/v1/tokens/icons?ids=${unique.map(encodeURIComponent).join(',')}`,
  );
  return data?.icons ?? {};
}
