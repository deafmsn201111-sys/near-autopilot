'use client';

import type { HotKit } from '@hot-labs/kit';
import { nearConnectorForKit } from './wallet';

let kitPromise: Promise<HotKit> | undefined;

/** One browser Kit instance; chain connectors stay lazy so their SDKs load only when needed. */
export function getHotKit(): Promise<HotKit> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const { Buffer } = await import('buffer');
      if (!globalThis.Buffer) Object.assign(globalThis, { Buffer });

      const [{ HotKit }, { lazyConnector }] = await Promise.all([
        import('@hot-labs/kit'),
        import('@hot-labs/kit/defaults'),
      ]);
      const connectors = [
        lazyConnector(
          'evm',
          () => import('@hot-labs/kit/evm'),
          (m) => m.default(),
        ),
        lazyConnector(
          'near',
          () => import('@hot-labs/kit/near'),
          (m) => m.default(nearConnectorForKit() as unknown as Parameters<typeof m.default>[0]),
        ),
        lazyConnector(
          'solana',
          () => import('@hot-labs/kit/solana'),
          (m) => m.default(),
        ),
        lazyConnector(
          'tron',
          () => import('@hot-labs/kit/tron'),
          (m) => m.default(),
        ),
        lazyConnector(
          'utxo',
          () => import('@hot-labs/kit/utxo'),
          (m) => m.default(),
        ),
      ];
      const projectId = await fetch('/api/public-config', { cache: 'no-store' })
        .then((response) => response.json() as Promise<{ walletConnectProjectId?: string | null }>)
        .then((config) => config.walletConnectProjectId ?? undefined)
        .catch(() => undefined);
      return new HotKit({
        connectors,
        ...(projectId
          ? {
              walletConnect: {
                projectId,
                metadata: {
                  name: 'NEAR Autopilot',
                  description: 'Move assets from other networks into your NEAR account.',
                  url: window.location.origin,
                  icons: [`${window.location.origin}/favicon.ico`],
                },
              },
            }
          : {}),
        branding: {
          balanceName: 'NEAR Autopilot',
          balanceIcon: `${window.location.origin}/favicon.ico`,
        },
        ui: {
          presentation: 'sheet',
          theme: {
            colorScheme: 'dark',
            fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
            colors: {
              textPrimary: '#F4F6F2',
              textSecondary: '#9CAAA3',
              accent: '#00EC97',
              accentOn: '#0B0F0E',
              background: '#0B0F0E',
              surface: '#151C19',
              surfaceLow: '#111714',
              surfaceHigh: '#1B2420',
              surfaceHighest: '#25312B',
              border: '#25312B',
              borderFocus: '#00EC97',
            },
            buttons: { primary: '#00EC97' },
            radii: { popup: 24, card: 18, button: 14, input: 14 },
            safeArea: true,
          },
        },
      });
    })().catch((error) => {
      kitPromise = undefined;
      throw error;
    });
  }
  return kitPromise;
}

/** Open Kit's bridge with the connected Autopilot NEAR account locked as the destination. */
export async function openNearAutopilotBridge(account: string): Promise<void> {
  const [{ Network, Recipient }, kit] = await Promise.all([import('@hot-labs/kit'), getHotKit()]);
  const recipient = await Recipient.fromAddress(Network.Near, account);
  await kit.openBridge({
    setup: {
      title: 'Fund your NEAR account',
      recipient,
      lockRecipient: true,
      tokenFilter: {
        from: (token) =>
          typeof token.chain === 'number' ||
          token.chain === Network.Solana ||
          token.chain === Network.Tron ||
          token.chain === Network.Btc,
        to: (token) => token.chain === Network.Near,
      },
    },
  });
}
