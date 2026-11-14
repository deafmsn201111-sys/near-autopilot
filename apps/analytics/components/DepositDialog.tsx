'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  describeStatus,
  loadDepositStatus,
  statusDelayMs,
  stopReason,
  searchTokens,
  type DepositAsset,
  type DepositQuote,
  type DepositStatus,
} from '../lib/deposit';
import { shortHash } from '../lib/activity';
import {
  connectOriginWallet,
  disconnectOriginWallet,
  openDepositBridge,
  type OriginWallet,
} from '../lib/hot-kit';
import { withoutModal } from '../lib/modal';
import { poll, tabHidden } from '../lib/polling';
import { currentAccount } from '../lib/wallet';
import { TokenIcon } from './TokenIcon';

export const REFUND_HINT: Record<string, string> = {
  eth: '0x…',
  base: '0x…',
  arb: '0x…',
  sol: 'Your Solana address',
  btc: 'bc1… , 1… or 3…',
};

export const remaining = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Polls the quote's 1Click status on a backoff until a final status, the deadline (unpaid only) or the check limit. */
function useDepositStatus(id: string) {
  const [status, setStatus] = useState<DepositStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [round, setRound] = useState(0);
  const sent = useRef(0);
  const shown = useRef(0);

  // Responses can overlap on a slow network: only one newer than what is on screen may replace it.
  const check = useCallback(async () => {
    const n = ++sent.current;
    const r = await loadDepositStatus(id);
    if (n < shown.current) return null;
    shown.current = n;
    setError(r.ok ? null : r.error);
    if (r.ok) setStatus(r.data);
    return r.ok ? r.data : null;
  }, [id]);

  // Each round checks at once, then on the backoff; "Check again" starts a new round.
  useEffect(() => {
    let alive = true;
    let checks = 0;
    let last: DepositStatus | null = null;
    setStopped(false);
    const tick = () => {
      checks++;
      void check().then((s) => {
        last = s ?? last;
        if (alive && stopReason(last, checks)) {
          stop();
          setStopped(true);
        }
      });
    };
    // No time window: the check limit bounds a round, and a hidden tab pauses it.
    const stop = poll(tick, { everyMs: statusDelayMs, forMs: Infinity, hidden: tabHidden });
    tick();
    return () => {
      alive = false;
      stop();
    };
  }, [check, round]);

  return { status, error, stopped, checkAgain: () => setRound((r) => r + 1) };
}

export function StatusLine({ q }: { q: DepositQuote }) {
  const { status, error, stopped, checkAgain } = useDepositStatus(q.id);
  const screen = describeStatus(status, q);
  return (
    <div className={`deposit-status ${screen.tone}`} role="status">
      <b>{screen.title}</b>
      {screen.detail && <p>{screen.detail}</p>}
      {screen.txUrl && (
        <p>
          <a href={screen.txUrl} target="_blank" rel="noreferrer">
            View the NEAR transaction
          </a>
        </p>
      )}
      {error && <p className="deposit-warn">{error}</p>}
      <p className="muted-note">
        {stopped ? 'Stopped checking automatically. ' : 'Checked automatically. '}
        <button type="button" className="btn secondary small" onClick={checkAgain}>
          Check again
        </button>
      </p>
    </div>
  );
}

const POPULAR = ['USDC', 'USDT', 'ETH', 'SOL', 'BTC'];

/**
 * Pick a token: search by symbol, popular chips, a list with its logos. Arrow keys move, Enter picks, Esc goes back.
 * Shown inside the deposit dialog in place of the form, never as a second dialog.
 */
export function TokenPicker<T extends DepositAsset>({
  title,
  tokens,
  selected,
  note,
  onPick,
  onBack,
}: {
  title: string;
  tokens: readonly T[];
  selected: string;
  note: (t: T) => string;
  onPick: (assetId: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const shown = searchTokens(tokens, query);
  const popular = POPULAR.flatMap((s) => tokens.find((t) => t.symbol === s) ?? []);
  const current = Math.min(active, Math.max(0, shown.length - 1));
  useEffect(() => {
    document.getElementById(`token-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(Math.min(shown.length - 1, Math.max(0, current + step)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = shown[current];
      if (t) onPick(t.assetId);
    }
  }

  return (
    <div className="token-picker">
      <div className="token-picker-head">
        <button type="button" className="btn secondary small" onClick={onBack}>
          ← Back
        </button>
        <h3>{title}</h3>
      </div>
      <input
        className="token-search"
        type="search"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder="Search by symbol"
        aria-label="Search by symbol"
        aria-controls="token-list"
        aria-activedescendant={shown[current] ? `token-${current}` : undefined}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKey}
      />
      {popular.length > 0 && !query && (
        <div className="token-chips">
          {popular.map((t) => (
            <button
              type="button"
              key={t.assetId}
              className={`token-chip${t.assetId === selected ? ' is-on' : ''}`}
              onClick={() => onPick(t.assetId)}
            >
              <TokenIcon icon={t.icon} symbol={t.symbol} size={20} />
              {t.symbol}
            </button>
          ))}
        </div>
      )}
      <ul className="token-list" id="token-list" role="listbox" aria-label={title}>
        {shown.map((t, i) => (
          <li
            key={t.assetId}
            id={`token-${i}`}
            role="option"
            aria-selected={t.assetId === selected}
            className={i === current ? 'is-active' : undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(t.assetId)}
          >
            <TokenIcon icon={t.icon} symbol={t.symbol} size={32} />
            <span className="token-list-name">
              <b>{t.symbol}</b>
              <span className="muted-note">{note(t)}</span>
            </span>
            {t.assetId === selected && (
              <span className="token-check" aria-hidden="true">
                ✓
              </span>
            )}
          </li>
        ))}
        {shown.length === 0 && <li className="muted-note">No token matches “{query.trim()}”.</li>}
      </ul>
    </div>
  );
}

/** The selected token as a large button that opens the picker: logo, symbol, and where it is. */
export function TokenButton({
  token,
  where,
  disabled,
  onClick,
  label,
}: {
  token: DepositAsset | undefined;
  where: string;
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className="token-button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`${label}: ${token ? `${token.symbol} ${where}` : 'choose a token'}`}
    >
      {token ? (
        <>
          <TokenIcon icon={token.icon} symbol={token.symbol} size={28} />
          <span className="token-button-name">
            <b>{token.symbol}</b>
            <span className="muted-note">{where}</span>
          </span>
        </>
      ) : (
        <span className="muted-note">Loading…</span>
      )}
      <span className="token-button-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}

const CHAIN_LABEL: Record<OriginWallet['chain'], string> = {
  evm: 'EVM',
  solana: 'Solana',
  btc: 'Bitcoin',
};
const ORIGIN_CHAINS = Object.keys(CHAIN_LABEL) as OriginWallet['chain'][];

/** EVM / Solana / Bitcoin wallets through HOT Kit, as connected in the dialog. */
export function OriginWallets({
  wallets,
  chains = ORIGIN_CHAINS,
}: {
  wallets: readonly OriginWallet[];
  chains?: readonly OriginWallet['chain'][];
}) {
  const [busy, setBusy] = useState(false);

  async function connect(chain: OriginWallet['chain'], dialog: HTMLDialogElement | null) {
    setBusy(true);
    try {
      await withoutModal(dialog, () => connectOriginWallet(chain));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="origin-wallets">
      {wallets.map((w) => (
        <span key={w.chain} className="origin-wallet">
          <span className="muted-note">{CHAIN_LABEL[w.chain]}</span>{' '}
          <code title={w.address}>{shortHash(w.address)}</code>{' '}
          <button
            type="button"
            className="btn secondary small"
            onClick={() => void disconnectOriginWallet(w).catch(() => undefined)}
          >
            Disconnect
          </button>
        </span>
      ))}
      {chains
        .filter((c) => !wallets.some((w) => w.chain === c))
        .map((c) => (
          <button
            key={c}
            type="button"
            className="btn secondary small"
            disabled={busy}
            onClick={(e) => void connect(c, e.currentTarget.closest('dialog'))}
          >
            Connect {CHAIN_LABEL[c]} wallet
          </button>
        ))}
    </div>
  );
}

/**
 * Fund the connected NEAR account from another chain through HOT's bridge popup (D42): one line on HOT's fee first,
 * then the popup with the account locked as the recipient. Nothing is built or signed here.
 */
export function DepositDialog({ account, label = 'Deposit' }: { account: string; label?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function continueInHot() {
    const dialog = ref.current;
    setBusy(true);
    setError(null);
    try {
      if ((await currentAccount().catch(() => null)) !== account)
        return setError(
          'Connect your NEAR wallet first: the deposit goes to the connected account.',
        );
      // A modal dialog would make HOT's popup inert.
      dialog?.close();
      await openDepositBridge(account);
    } catch {
      setError('HOT could not open the deposit. Check your connection and try again.');
      dialog?.showModal();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn primary small"
        onClick={() => {
          setError(null);
          ref.current?.showModal();
        }}
      >
        {label}
      </button>
      <dialog ref={ref} className="modal deposit">
        <h3>Deposit from another chain</h3>
        <p>
          Through HOT. Swaps between different tokens carry a fee up to 0.4%. It arrives in{' '}
          <b>{account}</b>; you sign the transfer in your wallet on the other chain.
        </p>
        {error && (
          <p className="deposit-warn" role="alert">
            {error}
          </p>
        )}
        <form method="dialog" className="modal-actions">
          <button className="btn secondary">Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => void continueInHot()}
          >
            {busy ? 'One moment…' : 'Continue in HOT'}
          </button>
        </form>
      </dialog>
    </>
  );
}
