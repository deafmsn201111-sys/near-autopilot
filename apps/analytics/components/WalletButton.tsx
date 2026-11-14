'use client';
import { CONNECT_FAILED } from '../lib/plain-error';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clearOwnershipProof, walletSummary } from '../app/account-actions';
import { reportConnect } from '../lib/events-client';
import { shortHash } from '../lib/activity';
import { money } from '../lib/format';
import {
  CHAIN_LABEL,
  connectOriginWallet,
  ORIGIN_CHAINS,
  watchOriginWallets,
  type OriginChain,
  type OriginWallet,
  type OtherBalance,
} from '../lib/hot-kit';
import { useOtherBalances } from './OtherChains';
import { portfolioUrl } from '../lib/portfolio-mode';
import { connect, disconnect, watchAccount } from '../lib/wallet';
import type { WalletBalance } from '../lib/withdraw';
import { DepositButton } from './DepositButton';
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
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="connect-wrap">
      <button
        type="button"
        className={className}
        disabled={opening}
        onClick={() => {
          setNote(null);
          const open = (id: string) => {
            reportConnect(id);
            rememberAccount(id);
            setOpening(true);
            window.location.assign(portfolioUrl(id));
          };
          connect(open)
            .then((id) => id && open(id))
            .catch(() => setNote(CONNECT_FAILED));
        }}
      >
        {opening ? 'One moment…' : children}
      </button>
      {note && (
        <span className="connect-note" role="status">
          {note}
        </span>
      )}
    </span>
  );
}

const CHAIN_ICON: Record<OriginChain, string> = {
  evm: '/chains/eth.svg',
  solana: '/chains/sol.svg',
  tron: '/chains/tron.png',
  btc: '/chains/btc.svg',
};

const ChainMark = ({ chain }: { chain: OriginChain | 'hot' }) => (
  <img
    className="app-tok"
    src={chain === 'hot' ? '/chains/hot.png' : CHAIN_ICON[chain]}
    alt=""
    aria-hidden="true"
  />
);

const OtherUsd = ({ usd }: { usd: number | undefined }) =>
  usd === undefined ? null : (
    <span className="bal num">
      {money(usd, false)}
      <small>
        <ProvenanceMark kind="estimate">Estimate · HOT Kit</ProvenanceMark>
      </small>
    </span>
  );

function WalletMenu({
  account,
  portfolio,
  wallets,
  balances,
  onDisconnect,
}: {
  account: string;
  portfolio: WalletPortfolio | null;
  wallets: readonly OriginWallet[];
  balances: readonly OtherBalance[];
  onDisconnect: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const missing = ORIGIN_CHAINS.filter((c) => !wallets.some((w) => w.chain === c));
  const hot = balances.find((b) => b.chain === 'hot' && (b.usd ?? 0) > 0);
  return (
    <>
      <h4>Your NEAR account</h4>
      <div className="row">
        <TokenIcon icon={portfolio?.nearIcon} symbol="NEAR" size={32} />
        <div>
          <b>{account}</b>
          <small>Analysed · you sign every action</small>
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
      <h4>Other chains</h4>
      {wallets.map((w) => (
        <div key={w.chain} className="row">
          <ChainMark chain={w.chain} />
          <div>
            <b title={w.address}>{shortHash(w.address)}</b>
            <small>{CHAIN_LABEL[w.chain]} · not analysed</small>
          </div>
          <OtherUsd usd={balances.find((b) => b.key === `${w.chain}:${w.address}`)?.usd} />
        </div>
      ))}
      {hot && (
        <div className="row">
          <ChainMark chain="hot" />
          <div>
            <b>HOT Bridge balance</b>
            <small>Refunds from bridge swaps that did not go through</small>
          </div>
          <OtherUsd usd={hot.usd} />
        </div>
      )}
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
            <b>{CHAIN_LABEL[c]}</b>
            <small>{WITHDRAW_TO.includes(c) ? 'Add funds · Withdraw' : 'Add funds'}</small>
          </div>
          <span className="connect-pill">Connect</span>
        </button>
      ))}
      <div className="sep" />
      <div className="acts">
        <DepositButton account={account} className="ds-btn ds-btn-primary ds-btn-sm" />
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
      <div className="sep" />
      <button type="button" className="row btnrow danger" onClick={onDisconnect}>
        <span className="app-tok" aria-hidden="true">
          <Icon name="logout" size={16} />
        </span>
        <div>
          <b>Disconnect all</b>
          <small>NEAR and every other wallet connected here</small>
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
  const balances = useOtherBalances(account !== null);

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
          balances={balances}
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
