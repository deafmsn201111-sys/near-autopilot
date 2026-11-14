import {
  BoundedMap,
  accountIdSchema,
  safeTokenIcon,
  type AccountId,
  type ContractViewer,
} from '@near-autopilot/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const NEAR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='50' fill='#000'/>" +
  "<path transform='translate(25 25) scale(.555)' fill='#fff' d='M72.2 4.6 53.4 32.5c-1.3 1.9 1.2 4.2 3 2.6L74.9 19c.5-.4 1.2-.1 1.2.6v50.3c0 .7-.9 1-1.3.5l-56-67C17 1.2 14.4 0 11.5 0h-2C4.3 0 0 4.3 0 9.6v70.8C0 85.7 4.3 90 9.6 90c3.3 0 6.4-1.7 8.2-4.6l18.8-27.9c1.3-1.9-1.2-4.2-3-2.6l-18.5 16c-.5.4-1.2.1-1.2-.6V20.1c0-.7.9-1 1.3-.5l56 67c1.8 2.2 4.5 3.4 7.3 3.4h2c5.3 0 9.6-4.3 9.6-9.6V9.6C90.1 4.3 85.8 0 80.5 0c-3.4 0-6.5 1.7-8.3 4.6z'/></svg>";

/** wrap.near has no `ft_metadata.icon` and native NEAR has no contract: both get this checked-in NEAR logo. */
export const NEAR_ICON = `data:image/svg+xml,${encodeURIComponent(NEAR_SVG)}`;
const CHECKED_IN: Readonly<Record<string, string>> = { near: NEAR_ICON, 'wrap.near': NEAR_ICON };

const metadataIcon = z.object({ icon: z.unknown().optional() });

/** Token logos from `ft_metadata.icon`, checked by `safeTokenIcon`. A failed read is not remembered, so it is retried. */
export class TokenIcons {
  private readonly cache: BoundedMap<string, string | null>;

  constructor(
    private readonly viewer: ContractViewer,
    limit = 500,
  ) {
    this.cache = new BoundedMap(limit);
  }

  async get(token: string): Promise<string | null> {
    const fixed = CHECKED_IN[token];
    if (fixed) return fixed;
    if (this.cache.has(token)) return this.cache.get(token) ?? null;
    const id = accountIdSchema.safeParse(token);
    if (!id.success) return null;
    try {
      const raw = metadataIcon.safeParse(await this.viewer.view(id.data as AccountId, 'ft_metadata'));
      const icon = raw.success ? safeTokenIcon(raw.data.icon) : null;
      this.cache.set(token, icon);
      return icon;
    } catch {
      return null;
    }
  }
}

const iconsQuery = z.object({
  ids: z
    .string()
    .max(10_000)
    .transform((s) => [...new Set(s.split(',').filter(Boolean))])
    .pipe(z.array(z.union([z.literal('near'), accountIdSchema])).min(1).max(100)),
});

/** Logos for the tokens a page shows, in one call: `{ icons: { [token]: dataUri | null } }`. */
export function registerTokenIcons(app: FastifyInstance, icons: TokenIcons) {
  app.get('/v1/tokens/icons', async (req) => {
    const { ids } = iconsQuery.parse(req.query);
    const entries = await Promise.all(ids.map(async (id) => [id, await icons.get(id)] as const));
    return { icons: Object.fromEntries(entries) };
  });
}
