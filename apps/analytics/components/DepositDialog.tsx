'use client';
import { describeProvenance } from '@near-autopilot/core';
import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultDestination,
  formatUnits,
  loadDepositAssets,
  requestDepositQuote,
  type DepositAssets,
  type DepositQuote,
} from '../lib/deposit';

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

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function QuoteView({ q, onBack }: { q: DepositQuote; onBack: () => void }) {
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
          <b className="num">
            {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          </b>
          . Another token or another chain can be lost.
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
        <dd className="num">{send}</dd>
        <dt>Chain</dt>
        <dd>{q.chainName}</dd>
        <dt>You receive (estimate)</dt>
        <dd className="num">
          ≈ {formatUnits(q.amountOut, q.destination.decimals)} {q.destination.symbol}, at least{' '}
          {formatUnits(q.minAmountOut, q.destination.decimals)}
          <span className="muted-note">
            {' '}
            · ≈ ${q.amountOutUsd.value} ({describeProvenance(q.amountOutUsd.provenance).label})
          </span>
        </dd>
        <dt>1Click fee</dt>
        <dd>
          <span className="num">{(q.fee.bps / 100).toFixed(2)}%</span>
          <span className="muted-note"> · {fee}, 1Click&apos;s published rate</span>
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

/**
 * Fund the connected NEAR account from another chain through 1Click. The server checks the refund address, verifies
 * the 1Click quote and only then returns a deposit address; the user sends to it from their own wallet on that chain.
 * Nothing is signed here and no NEAR transaction is built.
 */
export function DepositDialog({ account, label = 'Deposit' }: { account: string; label?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [assets, setAssets] = useState<DepositAssets | null>(null);
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<DepositQuote | null>(null);

  const chosen = assets?.origins.find((o) => o.assetId === origin);
  const chains = useMemo(() => {
    const by = new Map<string, DepositAssets['origins'][number][]>();
    for (const o of assets?.origins ?? []) by.set(o.chainName, [...(by.get(o.chainName) ?? []), o]);
    return [...by];
  }, [assets]);

  function pickOrigin(id: string, list = assets) {
    setOrigin(id);
    const o = list?.origins.find((x) => x.assetId === id);
    setDestination(defaultDestination(o, list?.destinations ?? [])?.assetId ?? '');
  }

  async function open() {
    ref.current?.showModal();
    if (assets) return;
    setError(null);
    const r = await loadDepositAssets();
    if (!r.ok) return setError(r.error);
    setAssets(r.data);
    pickOrigin(r.data.origins[0]?.assetId ?? '', r.data);
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
      <dialog ref={ref} className="modal deposit">
        {quote ? (
          <QuoteView q={quote} onBack={() => setQuote(null)} />
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h3>Deposit from another chain</h3>
            <p>
              Through NEAR Intents 1Click. You get a one-time address on the chain you pick and send
              to it from your own wallet there; it arrives in <b>{account}</b>.
            </p>
            <label className="field">
              Send
              <select
                value={origin}
                onChange={(e) => pickOrigin(e.target.value)}
                disabled={!assets}
                required
              >
                {chains.map(([chainName, list]) => (
                  <optgroup key={chainName} label={chainName}>
                    {list.map((o) => (
                      <option key={o.assetId} value={o.assetId}>
                        {o.symbol} on {chainName}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="field">
              Amount{chosen ? ` (${chosen.symbol})` : ''}
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder="100"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </label>
            <label className="field">
              Receive on NEAR
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                disabled={!assets}
                required
              >
                {assets?.destinations.map((d) => (
                  <option key={d.assetId} value={d.assetId}>
                    {d.symbol}
                  </option>
                ))}
              </select>
            </label>
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
              <button type="submit" className="btn primary" disabled={!assets || busy}>
                {busy ? 'Getting a quote…' : 'Get deposit address'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
