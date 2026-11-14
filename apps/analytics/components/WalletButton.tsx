'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clearOwnershipProof, walletSummary } from '../app/account-actions';
import { reportConnect } from '../lib/events-client';
import { shortHash } from '../lib/activity';
import { money } from '../lib/format';
import {
  connectOriginWallet,
  watchOriginWallets,
  type OriginChain,
  type OriginWallet,
} from '../lib/hot-kit';
import { portfolioUrl } from '../lib/portfolio-mode';
import { connect, disconnect, watchAccount } from '../lib/wallet';
import type { WalletBalance } from '../lib/withdraw';
import { CHAIN_LABEL, DepositButton, ORIGIN_CHAINS } from './DepositDialog';
import { Icon } from './icons';
import { ProvenanceMark } from './primitives';
import { TokenIcon } from './TokenIcon';
import { WithdrawDialog } from './WithdrawDialog';

const WITHDRAW_TO: readonly OriginChain[] = ['evm', 'solana'];

export interface WalletPortfolio {
  account: string;
  netWorthUsd: number | null;
  balances: readonly WalletBalance[];
  signingEnabled: boolean;
  nearIcon: string | null;
}

function rememberAccount(id: string | null): boolean {
  const before = document.cookie.match(/(?:^|; )np_account=([^;]*)/)?.[1] ?? '';
  document.cookie = id
    ? `np_account=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`
    : 'np_account=; path=/; max-age=0; samesite=lax';
  return before !== (id ? encodeURIComponent(id) : '');
}

/**
 * Sign-in only: no access key, no signature (ownership for AI analysis is components/OwnershipCheck.tsx). A sign-in
 * opens that account with a full page load, the same way on the first and on every later connection.
 */
export function ConnectButton({
  className = 'ds-btn ds-btn-primary',
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const [opening, setOpening] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={opening}
      onClick={() => {
        const open = (id: string) => {
          reportConnect(id);
          rememberAccount(id);
          setOpening(true);
          window.location.assign(portfolioUrl(id));
        };
        connect(open)
          .then((id) => id && open(id))
          .catch(() => undefined); // the kit failed to load: stay here
      }}
    >
      {opening ? 'One moment…' : children}
    </button>
  );
}

const ChainMark = ({ chain }: { chain: OriginChain }) => (
  <span className="app-tok" aria-hidden="true">
    {CHAIN_LABEL[chain].slice(0, 1)}
  </span>
);

function WalletMenu({
  account,
  portfolio,
  wallets,
  onDisconnect,
}: {
  account: string;
  portfolio: WalletPortfolio | null;
  wallets: readonly OriginWallet[];
  onDisconnect: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const missing = ORIGIN_CHAINS.filter((c) => !wallets.some((w) => w.chain === c));
  return (
    <>
      <h4>Portfolio account</h4>
      <div className="row">
        <TokenIcon icon={portfolio?.nearIcon} symbol="NEAR" size={32} />
        <div>
          <b>{account}</b>
          <small>NEAR · analysed, signs every action</small>
        </div>
        {portfolio && portfolio.netWorthUsd !== null && (
          <span className="bal num">
            {money(portfolio.netWorthUsd, false)}
            <small>
              <ProvenanceMark kind="on_chain">net worth</ProvenanceMark>
            </small>
          </span>
        )}
      </div>
      <h4>Other chains · for deposits and withdrawals</h4>
      {wallets.map((w) => (
        <div key={w.chain} className="row">
          <ChainMark chain={w.chain} />
          <div>
            <b title={w.address}>{shortHash(w.address)}</b>
            <small>{CHAIN_LABEL[w.chain]} · not analysed</small>
          </div>
        </div>
      ))}
      {missing.map((c) => (
        <button
          key={c}
          type="button"
          className="row btnrow"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void connectOriginWallet(c).finally(() => setBusy(false));
          }}
        >
          <ChainMark chain={c} />
          <div>
            <b>Connect {CHAIN_LABEL[c]}</b>
            <small>
              {WITHDRAW_TO.includes(c)
                ? 'To add funds from it or withdraw to it'
                : 'To add funds from it'}
            </small>
          </div>
        </button>
      ))}
      <div className="sep" />
      <div className="acts">
        <DepositButton account={account} className="ds-btn ds-btn-secondary ds-btn-sm" />
        {portfolio && (
          <WithdrawDialog
            account={account}
            balances={portfolio.balances}
            signingEnabled={portfolio.signingEnabled}
            label="Withdraw"
            className="ds-btn ds-btn-secondary ds-btn-sm"
          />
        )}
      </div>
      <button type="button" className="row btnrow" onClick={onDisconnect}>
        <div>
          <b>Disconnect</b>
          <small>Signs out of NEAR and every other wallet connected here</small>
        </div>
      </button>
    </>
  );
}

/**
 * The menu stays mounted while closed: a HOT popup or the Withdraw dialog it opened keeps its state when a click
 * there closes the menu.
 */
export function WalletButton({ initialAccount }: { initialAccount: string | null }) {
  const [account, setAccount] = useState<string | null>(initialAccount);
  const [wallets, setWallets] = useState<OriginWallet[]>([]);
  const [portfolio, setPortfolio] = useState<WalletPortfolio | null>(null);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(
    () =>
      watchAccount((id) => {
        setAccount(id);
        if (rememberAccount(id)) router.refresh();
      }),
    [router],
  );
  useEffect(() => (account ? watchOriginWallets(setWallets) : undefined), [account]);

  useEffect(() => {
    if (!open || !account) return;
    let live = true;
    void walletSummary(account).then(
      (p) => live && p && setPortfolio(p),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, account]);

  useEffect(() => {
    if (!open) return;
    const inDialog = () => document.querySelector('dialog[open]') !== null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || inDialog()) return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (inDialog() || menu.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  if (leaving) return <span className="app-wallet-note">One moment…</span>;
  if (!account) return <ConnectButton>Connect wallet</ConnectButton>;
  const known = portfolio?.account === account ? portfolio : null;
  return (
    <div className="app-wallet-wrap">
      <button
        ref={button}
        type="button"
        className="app-wallet"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="stack">
          <TokenIcon icon={known?.nearIcon} symbol="NEAR" size={18} />
          {wallets.map((w) => (
            <ChainMark key={w.chain} chain={w.chain} />
          ))}
        </span>
        <span className="who">{account}</span>
        <Icon name="down" size={14} />
      </button>
      <div ref={menu} className="app-pop" role="dialog" aria-label="Wallets" hidden={!open}>
        <WalletMenu
          account={account}
          portfolio={known}
          wallets={wallets}
          onDisconnect={() => {
            setLeaving(true);
            void Promise.allSettled([disconnect(), clearOwnershipProof()]).finally(() => {
              rememberAccount(null);
              document.cookie = 'autopilot-mode=demo; path=/; max-age=31536000; samesite=lax';
              window.location.assign('/');
            });
          }}
        />
      </div>
    </div>
  );
}
