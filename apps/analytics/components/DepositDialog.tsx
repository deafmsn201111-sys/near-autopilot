'use client';
import { describeProvenance } from '@near-autopilot/core';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEPOSIT_CHAINS,
  defaultDestination,
  defaultOrigin,
  formatUnits,
  loadDepositAssets,
  requestDepositQuote,
  searchTokens,
  type DepositAsset,
  type DepositAssets,
  type DepositQuote,
} from '../lib/deposit';
import { TokenIcon } from './TokenIcon';

const REFUND_HINT: Record<string, string> = {
  eth: '0x…',
  base: '0x…',
  arb: '0x…',
  sol: 'Your Solana address',
  btc: 'bc1… , 1… or 3…',
};

/** Drawn locally from the address: no external QR service ever sees it. Black on white so it scans in dark mode. */
function Qr({ text }: { text: string }) {
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
      aria-label="QR code of the deposit address"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
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
  const [copied, setCopied] = useState(false);
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const expired = left === 0;
  const send = `${formatUnits(q.amountIn, q.origin.decimals)} ${q.origin.symbol}`;
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
      {!expired && (
        <div className="deposit-address">
          <Qr text={q.depositAddress} />
          <code>{q.depositAddress}</code>
          <button
            type="button"
            className="btn secondary small"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(q.depositAddress)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? 'Copied' : 'Copy address'}
          </button>
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
          about {Math.max(1, Math.round(q.timeEstimateSeconds / 60))} min after your deposit
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
            {t.assetId === selected && <span aria-hidden="true">✓</span>}
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
