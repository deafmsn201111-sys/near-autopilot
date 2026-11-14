'use client';
import { useState } from 'react';
import { openDepositBridge } from '../lib/hot-kit';
import { bridgeOpenError, NO_NEAR_ACCOUNT } from '../lib/plain-error';
import { currentAccount } from '../lib/wallet';

/** Funds the connected NEAR account from another chain in HOT's bridge popup (D42); nothing is built or signed here. */
export function DepositButton({
  account,
  label = 'Add funds',
  className = 'ds-btn ds-btn-secondary ds-btn-sm',
  tokenId,
}: {
  account: string;
  label?: string;
  className?: string;
  /** A kit token to preselect as the source (Bring to NEAR). */
  tokenId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      if ((await currentAccount().catch(() => null)) !== account) return setError(NO_NEAR_ACCOUNT);
      await openDepositBridge(account, tokenId);
    } catch (e) {
      setError(bridgeOpenError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={() => void open()}>
        {label}
      </button>
      {error && (
        <span className="bridge-err" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
