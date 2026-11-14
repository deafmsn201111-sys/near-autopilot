import { z } from 'zod';
import type { HttpJsonClient } from '../market-data/http';

/**
 * NEAR Intents SHIELD Incident API: live incidents on chains, bridges and tokens, with a text meant for partners to
 * show users. Display only: it never changes a quote, and a feed that fails or answers oddly means "no incident".
 */
export const SHIELD_BASE_URL = 'https://shield.chaindefuser.com';
export const SHIELD_TTL_MS = 60_000;
const MAX_TEXT = 280;

export interface ShieldIncident {
  readonly scopeType: 'chain' | 'bridge' | 'token';
  readonly scopeValue: string;
  /** `deposit`, `withdraw`, or null when SHIELD gives none; other values are kept and match both sides. */
  readonly direction: string | null;
  /** SHIELD's public description as plain text, null when empty. */
  readonly text: string | null;
}

const plainText = (s: string) => {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join('')}…` : t || null;
};

const incident = z.object({
  scopeType: z.enum(['chain', 'bridge', 'token']),
  scopeValue: z.string().min(1).max(200),
  direction: z.string().max(20).nullish(),
  publicDescription: z.string().max(10_000).nullish(),
});
const answer = z.discriminatedUnion('status', [
  z.object({ status: z.literal('operational') }),
  z.object({ status: z.literal('incidents'), incidents: z.array(z.unknown()).max(500) }),
]);

export class ShieldClient {
  private cached: { at: number; incidents: Promise<ShieldIncident[]> } | null = null;

  constructor(
    private readonly o: {
      readonly http: Pick<HttpJsonClient, 'getJson'>;
      /** SHIELD_JWT: sent only to SHIELD as a bearer header; never logged, never returned. */
      readonly jwt: string;
      readonly baseUrl?: string | undefined;
      readonly now?: () => number;
      readonly onError?: (err: unknown) => void;
    },
  ) {}

  /** Never rejects. One request a minute at most: concurrent callers share it, and a failure is cached too. */
  incidents(): Promise<ShieldIncident[]> {
    const now = (this.o.now ?? Date.now)();
    if (this.cached && now - this.cached.at < SHIELD_TTL_MS) return this.cached.incidents;
    const incidents = this.fetch().catch((err: unknown) => {
      this.o.onError?.(err);
      return [];
    });
    this.cached = { at: now, incidents };
    return incidents;
  }

  private async fetch(): Promise<ShieldIncident[]> {
    const raw = await this.o.http.getJson(`${this.o.baseUrl ?? SHIELD_BASE_URL}/incident`, {
      authorization: `Bearer ${this.o.jwt}`,
    });
    const parsed = answer.parse(raw);
    if (parsed.status === 'operational') return [];
    return parsed.incidents.flatMap((i) => {
      const p = incident.safeParse(i);
      if (!p.success) return [];
      const { scopeType, scopeValue, direction, publicDescription } = p.data;
      return [
        {
          scopeType,
          scopeValue: scopeValue.toLowerCase(),
          direction: direction?.toLowerCase() || null,
          text: plainText(publicDescription ?? ''),
        },
      ];
    });
  }
}

export interface RouteAsset {
  readonly assetId: string;
  readonly blockchain: string;
}

// SHIELD names no bridges in its docs: these are the two 1Click carries our origin tokens over. Others match nothing.
const bridgeOf = (assetId: string) =>
  assetId.endsWith('.omft.near')
    ? 'poa'
    : assetId.startsWith('nep245:v2_1.omni.hot.tg:')
      ? 'hot'
      : null;

const touches = (i: ShieldIncident, t: RouteAsset) =>
  i.scopeType === 'chain'
    ? i.scopeValue === t.blockchain
    : i.scopeType === 'token'
      ? i.scopeValue === t.assetId.toLowerCase()
      : i.scopeValue === bridgeOf(t.assetId);

/** The incidents on this route: deposits into 1Click on the sending side, withdrawals to NEAR on the receiving side. */
export function incidentsFor(
  incidents: readonly ShieldIncident[],
  route: { readonly origin: RouteAsset; readonly destination: RouteAsset },
): ShieldIncident[] {
  return incidents.filter((i) =>
    i.direction === 'deposit'
      ? touches(i, route.origin)
      : i.direction === 'withdraw'
        ? touches(i, route.destination)
        : touches(i, route.origin) || touches(i, route.destination),
  );
}
