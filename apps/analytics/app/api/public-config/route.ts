import { NextResponse } from 'next/server';

/** Exposes only Reown's public project id, which WalletConnect requires for mobile EVM/TRON sessions. */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const projectId = process.env.WALLETCONNECT_PROJECT_ID?.trim();
  return NextResponse.json(
    {
      walletConnectProjectId:
        projectId && /^[a-zA-Z0-9-]{8,100}$/.test(projectId) ? projectId : null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
