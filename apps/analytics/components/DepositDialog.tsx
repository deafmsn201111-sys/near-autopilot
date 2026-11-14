'use client';
import { describeProvenance } from '@near-autopilot/core';
import qrcode from 'qrcode-generator';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEPOSIT_CHAINS,
  defaultDestination,
  describeStatus,
  defaultOrigin,
  formatUnits,
  loadDepositAssets,
  loadDepositIncidents,
  loadDepositStatus,
  requestDepositQuote,
  statusDelayMs,
  stopReason,
  searchTokens,
  type DepositAsset,
  type DepositAssets,
  type DepositQuote,
  type DepositStatus,
} from '../lib/deposit';
import { shortHash } from '../lib/activity';
import {
  connectOriginWallet,
  disconnectOriginWallet,
  watchOriginWallets,
  type OriginWallet,
} from '../lib/hot-kit';
import { paymentUri } from '../lib/payment-uri';
import { poll, tabHidden } from '../lib/polling';
import { TokenIcon } from './TokenIcon';

const REFUND_HINT: Record<string, string> = {
  eth: '0x…',
  base: '0x…',
  arb: '0x…',
  sol: 'Your Solana address',
  btc: 'bc1… , 1… or 3…',
};

/** Drawn locally: no external QR service ever sees it. Black on white so it scans in dark mode. */
function Qr({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { size: n + 8, path: d };
  }, [text]);
  return (
    <svg
      className="deposit-qr"
      viewBox={`0 0 ${size} ${size}`}
      width={192}
      height={192}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn secondary small"
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => undefined)
      }
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

const remaining = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function useNow() {
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

function StatusLine({ q }: { q: DepositQuote }) {
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

function QuoteView({
  q,
  originIcon,
  destinationIcon,
  onBack,
}: {
  q: DepositQuote;
  originIcon: string | null | undefined;
  destinationIcon: string | null | undefined;
  onBack: () => void;
}) {
  const now = useNow();
  // The server's seconds-left, counted from when the answer arrived: the browser clock may be off.
  const [expiresAt] = useState(() => Date.now() + q.expiresInSeconds * 1000);
  const [addressOnly, setAddressOnly] = useState(false);
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const expired = left === 0;
  const amount = formatUnits(q.amountIn, q.origin.decimals);
  const send = `${amount} ${q.origin.symbol}`;
  const uri = paymentUri(q);
  const link = addressOnly ? null : uri;
  const fee = describeProvenance(q.fee.provenance).label;
  return (
    <>
      <h3>
        Send {send} on {q.chainName}
      </h3>
      {expired ? (
        <p className="deposit-warn">This address has expired. Do not send to it; get a new one.</p>
      ) : (
        <p>
          Send exactly this amount from your own wallet on {q.chainName}, to this address, within{' '}
          <b className="num">{remaining(left)}</b>. Another token or another chain can be lost.
        </p>
      )}
      <StatusLine q={q} />
      {!expired && (
        <div className="deposit-address">
          <Qr
            text={link ?? q.depositAddress}
            label={
              link
                ? `QR code of a payment of ${send} on ${q.chainName}`
                : 'QR code of the deposit address'
            }
          />
          {link && (
            <a className="btn primary small" href={link}>
              Open in wallet
            </a>
          )}
          {uri ? (
            <label className="muted-note">
              <input
                type="checkbox"
                checked={addressOnly}
                onChange={(e) => setAddressOnly(e.target.checked)}
              />{' '}
              Address only, for wallets that do not read payment links
            </label>
          ) : (
            <p className="deposit-warn">
              Your wallet will not fill in the amount for {q.chainName}: send exactly {send}.
            </p>
          )}
          <code>{q.depositAddress}</code>
          <CopyButton text={q.depositAddress} label="Copy address" />
          <p>
            <b className="num">{send}</b> on {q.chainName}{' '}
            <CopyButton text={amount} label="Copy amount" />
          </p>
        </div>
      )}
      <dl className="deposit-facts">
        <dt>You send</dt>
        <dd className="num deposit-token">
          <TokenIcon icon={originIcon} symbol={q.origin.symbol} size={20} />
          {send}
        </dd>
        <dt>Chain</dt>
        <dd>{q.chainName}</dd>
        <dt>You receive (estimate)</dt>
        <dd className="num deposit-token">
          <TokenIcon icon={destinationIcon} symbol={q.destination.symbol} size={20} />≈{' '}
          {formatUnits(q.amountOut, q.destination.decimals)} {q.destination.symbol}, at least{' '}
          {formatUnits(q.minAmountOut, q.destination.decimals)}
          <span className="muted-note">
            {' '}
            · ≈ ${Number(q.amountOutUsd.value).toFixed(2)} (
            {describeProvenance(q.amountOutUsd.provenance).label})
          </span>
        </dd>
        <dt>1Click fee</dt>
        <dd>
          {q.fee.bps === null ? (
            'not reported by 1Click'
          ) : (
            <>
              <span className="num">{(q.fee.bps / 100).toFixed(2)}%</span>
              <span className="muted-note"> · {fee}, already taken off what you receive</span>
            </>
          )}
        </dd>
        <dt>To NEAR account</dt>
        <dd>{q.recipient}</dd>
        <dt>Refund to</dt>
        <dd>
          <code>{q.refundTo}</code>
        </dd>
        <dt>Deadline</dt>
        <dd>{new Date(q.deadline).toLocaleString()}</dd>
        <dt>Arrives in</dt>
        <dd>
          usually about {Math.max(1, Math.round(q.timeEstimateSeconds / 60))} min after your deposit
          confirms
        </dd>
      </dl>
      <form method="dialog" className="modal-actions">
        <button type="button" className="btn secondary" onClick={onBack}>
          New quote
        </button>
        <button className="btn primary">Close</button>
      </form>
    </>
  );
}

const POPULAR = ['USDC', 'USDT', 'ETH', 'SOL', 'BTC'];

/**
 * Pick a token: search by symbol, popular chips, a list with its logos. Arrow keys move, Enter picks, Esc goes back.
 * Shown inside the deposit dialog in place of the form, never as a second dialog.
 */
function TokenPicker<T extends DepositAsset>({
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
function TokenButton({
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

const CHAIN_LABEL: Record<OriginWallet['chain'], string> = { evm: 'EVM', solana: 'Solana' };
const ORIGIN_CHAINS = Object.keys(CHAIN_LABEL) as OriginWallet['chain'][];

/** EVM / Solana wallets through HOT Kit; mounted only once the dialog has opened, so the kit loads only then. */
function OriginWallets() {
  const [wallets, setWallets] = useState<OriginWallet[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => watchOriginWallets(setWallets), []);

  // A modal <dialog> sits in the top layer and makes the kit's picker inert: drop to non-modal while it is open.
  async function connect(chain: OriginWallet['chain'], dialog: HTMLDialogElement | null) {
    setBusy(true);
    dialog?.close();
    dialog?.show();
    try {
      await connectOriginWallet(chain);
    } finally {
      if (dialog?.open && dialog.isConnected) {
        dialog.close();
        dialog.showModal();
      }
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
      {ORIGIN_CHAINS.filter((c) => !wallets.some((w) => w.chain === c)).map((c) => (
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
 * Fund the connected NEAR account from another chain through 1Click. The server checks the refund address, verifies
 * the 1Click quote and only then returns a deposit address; the user sends to it from their own wallet on that chain.
 * Nothing is signed here and no NEAR transaction is built.
 */
export function DepositDialog({ account, label = 'Deposit' }: { account: string; label?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [assets, setAssets] = useState<DepositAssets | null>(null);
  const [chain, setChain] = useState<string>(DEPOSIT_CHAINS[0].id);
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [picking, setPicking] = useState<'send' | 'receive' | null>(null);
  const [incidents, setIncidents] = useState<string[]>([]);

  useEffect(() => {
    setIncidents([]);
    if (!origin || !destination) return;
    let alive = true;
    const load = () =>
      void loadDepositIncidents(origin, destination).then((list) => alive && setIncidents(list));
    load();
    // The server asks SHIELD once a minute; a long stay on the address screen still sees a new incident.
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [origin, destination]);
  const [opened, setOpened] = useState(false);

  const chosen = assets?.origins.find((o) => o.assetId === origin);
  const receive = assets?.destinations.find((d) => d.assetId === destination);
  const chains = DEPOSIT_CHAINS.filter((c) => assets?.origins.some((o) => o.chain === c.id));
  const onChain = assets?.origins.filter((o) => o.chain === chain) ?? [];

  function pickOrigin(id: string, list = assets) {
    setOrigin(id);
    const o = list?.origins.find((x) => x.assetId === id);
    setDestination(defaultDestination(o, list?.destinations ?? [])?.assetId ?? '');
  }

  function pickChain(id: string, list = assets) {
    setChain(id);
    pickOrigin(defaultOrigin(list?.origins ?? [], id)?.assetId ?? '', list);
  }

  async function open() {
    ref.current?.showModal();
    setOpened(true);
    if (assets) return;
    setError(null);
    const r = await loadDepositAssets();
    if (!r.ok) return setError(r.error);
    setAssets(r.data);
    const first = DEPOSIT_CHAINS.find((c) => r.data.origins.some((o) => o.chain === c.id));
    if (first) pickChain(first.id, r.data);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await requestDepositQuote({
      account,
      originAsset: origin,
      destinationAsset: destination,
      amount: amount.trim(),
      refundTo: refundTo.trim(),
    });
    setBusy(false);
    if (r.ok) setQuote(r.data);
    else setError(r.error);
  }

  return (
    <>
      <button type="button" className="btn primary small" onClick={() => void open()}>
        {label}
      </button>
      <dialog
        ref={ref}
        className="modal deposit"
        onCancel={(e) => {
          if (!picking) return;
          e.preventDefault();
          setPicking(null);
        }}
      >
        {!picking &&
          incidents.map((text) => (
            <p key={text} className="deposit-incident" role="alert">
              <b>1Click reports an incident:</b> {text}
            </p>
          ))}
        {quote ? (
          <QuoteView
            q={quote}
            originIcon={chosen?.icon}
            destinationIcon={receive?.icon}
            onBack={() => setQuote(null)}
          />
        ) : picking === 'send' ? (
          <TokenPicker
            title={`Send from ${chosen?.chainName ?? 'another chain'}`}
            tokens={onChain}
            selected={origin}
            note={(t) => `on ${t.chainName}`}
            onPick={(id) => {
              pickOrigin(id);
              setPicking(null);
            }}
            onBack={() => setPicking(null)}
          />
        ) : picking === 'receive' ? (
          <TokenPicker
            title="Receive on NEAR"
            tokens={assets?.destinations ?? []}
            selected={destination}
            note={() => 'on NEAR'}
            onPick={(id) => {
              setDestination(id);
              setPicking(null);
            }}
            onBack={() => setPicking(null)}
          />
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h3>Deposit from another chain</h3>
            <p>
              Through NEAR Intents 1Click. You get a one-time address on the chain you pick and send
              to it from your own wallet there; it arrives in <b>{account}</b>.
            </p>
            {opened && <OriginWallets />}
            <div className="chain-chips" role="radiogroup" aria-label="Network">
              {chains.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  role="radio"
                  aria-checked={c.id === chain}
                  className={`chain-chip${c.id === chain ? ' is-on' : ''}`}
                  onClick={() => pickChain(c.id)}
                >
                  <img src={`/chains/${c.id}.svg`} alt="" width={20} height={20} />
                  {c.name}
                </button>
              ))}
            </div>
            <div className="asset-box">
              <span className="asset-box-label">You send</span>
              <div className="asset-box-row">
                <TokenButton
                  label="Token to send"
                  token={chosen}
                  where={chosen ? `on ${chosen.chainName}` : ''}
                  disabled={!assets}
                  onClick={() => setPicking('send')}
                />
                <input
                  className="asset-amount num"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  aria-label={`Amount${chosen ? ` of ${chosen.symbol}` : ''}`}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="asset-box">
              <span className="asset-box-label">You receive on NEAR</span>
              <div className="asset-box-row">
                <TokenButton
                  label="Token to receive"
                  token={receive}
                  where="on NEAR"
                  disabled={!assets}
                  onClick={() => setPicking('receive')}
                />
              </div>
            </div>
            <label className="field">
              Your refund address{chosen ? ` on ${chosen.chainName}` : ''}
              <input
                autoComplete="off"
                spellCheck={false}
                placeholder={REFUND_HINT[chosen?.chain ?? ''] ?? ''}
                value={refundTo}
                onChange={(e) => setRefundTo(e.target.value)}
                required
              />
              <span className="muted-note">
                If the swap fails, 1Click sends your deposit back here. It must be your own address.
              </span>
            </label>
            {error && (
              <p className="deposit-warn" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn secondary" onClick={() => ref.current?.close()}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={!assets || busy || !origin || !destination}
              >
                {busy ? 'Getting a quote…' : 'Get deposit address'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
