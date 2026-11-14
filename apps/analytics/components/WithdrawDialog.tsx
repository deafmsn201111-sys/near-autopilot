'use client';
import { describeProvenance } from '@near-autopilot/core';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { shortHash } from '../lib/activity';
import {
  DEPOSIT_CHAINS,
  defaultOrigin,
  describeStatus,
  formatUnits,
  loadDepositAssets,
  walletChainOf,
  type DepositAssets,
  type DepositQuote,
} from '../lib/deposit';
import {
  CHAIN_LABEL,
  connectOriginWallet,
  watchOriginWallets,
  type OriginWallet,
} from '../lib/hot-kit';
import { withoutModal } from '../lib/modal';
import { plainQuoteError } from '../lib/plain-error';
import { useNow } from '../lib/use-now';
import {
  addressError,
  parseAmount,
  requestWithdrawQuote,
  shareOf,
  timelineOf,
  withdrawSources,
  WITHDRAW_CHAINS,
  type WalletBalance,
} from '../lib/withdraw';
import {
  checkAgain,
  forgetWithdrawal,
  trackWithdrawal,
  useWithdrawal,
  type Tracked,
} from '../lib/withdraw-tracker';
import { CopyButton } from './CopyButton';
import { PrepareDialog } from './PrepareDialog';
import { Button, ProvenanceMark, Segmented } from './primitives';
import { Sheet, useSheet } from './Sheet';
import { TokenButton, TokenPicker } from './TokenPicker';

// As the API's margin: the transfer must land well before 1Click's deadline.
const SEND_MARGIN_S = 120;
// The sheet names wNEAR "NEAR" (#237); either name finds the same token on the target chain.
const sameToken = (a: string, b: string | undefined) =>
  b !== undefined && a.replace(/^w(?=NEAR$)/, '') === b.replace(/^w(?=NEAR$)/, '');
const CHAINS = DEPOSIT_CHAINS.filter((c) => (WITHDRAW_CHAINS as readonly string[]).includes(c.id));
type ChainId = (typeof CHAINS)[number]['id'];

const remaining = (s: number) =>
  s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const minutes = (s: number) => `about ${Math.max(1, Math.round(s / 60))} min`;
const amountOf = (units: string, t: { decimals: number; symbol: string }) =>
  `${formatUnits(units, t.decimals)} ${t.symbol}`;

const STEP_DETAIL = ['Approved in your wallet', 'Your transfer reached 1Click', '', ''] as const;
const stepsOf = (q: DepositQuote) => [
  'Signed in your wallet',
  'Seen by 1Click',
  `Swapping to ${q.destination.symbol}`,
  `Arrived on ${q.to.chainName}`,
];

/** signed → seen by 1Click → swapping → arrived on a rail, then the outcome; polling runs in lib/withdraw-tracker. */
function Timeline({ t }: { t: Tracked }) {
  const q = t.quote;
  const line = timelineOf(t.status);
  const screen = describeStatus(t.status, q);
  return (
    <>
      <ol className="wd-rail" aria-label="Withdrawal progress">
        {stepsOf(q).map((label, i) => {
          const state = i < line.done ? 'done' : i === line.done && !line.end ? 'now' : '';
          return (
            <li
              key={label}
              className={`wd-tl ${state}`}
              aria-current={state === 'now' || undefined}
            >
              <i aria-hidden="true" />
              <span>
                {label}
                <span className="sr-only">
                  {state === 'done' ? ', done' : state === 'now' ? ', in progress' : ', waiting'}
                </span>
                {state === 'done' && STEP_DETAIL[i] && <small>{STEP_DETAIL[i]}</small>}
              </span>
            </li>
          );
        })}
      </ol>
      {line.end ? (
        <div className={`result ${line.end}`} role="status">
          <b>
            {line.end === 'ok'
              ? `${t.status?.amountOut ? amountOf(t.status.amountOut, q.destination) : 'Your money'} arrived on ${q.to.chainName}.`
              : screen.title}
          </b>
          <span>
            {line.end === 'ok'
              ? `At ${shortHash(q.recipient)}.`
              : (screen.detail ??
                `A refund comes back to ${q.refundTo}${q.origin.assetId === 'nep141:wrap.near' ? ' as wNEAR' : ''}.`)}
            {screen.txUrl && (
              <>
                {' '}
                <a href={screen.txUrl} target="_blank" rel="noreferrer">
                  See it on NearBlocks
                </a>
              </>
            )}
          </span>
        </div>
      ) : (
        <p className="wd-sub" role="status">
          {screen.title}. You can close this window: tracking goes on and shows by the Withdraw
          button.
        </p>
      )}
      {t.error && <p className="wd-err">{t.error}</p>}
      <div className="wd-row">
        <CopyButton text={q.recipient} label="Copy address" />
        {t.stopped && !line.end && (
          <Button size="sm" onClick={checkAgain}>
            Check again
          </Button>
        )}
      </div>
    </>
  );
}

/** "You receive" with minimum, fee, time and refund, as an `<output>` that says when it is updating or failed. */
function QuoteOutput({
  quote,
  left,
  busy,
  error,
  account,
}: {
  quote: DepositQuote | null;
  left: number;
  busy: boolean;
  error: string | null;
  account: string;
}) {
  return (
    <output className="wd-quote" aria-live="polite" aria-busy={busy}>
      {busy ? (
        <span className="sh-loading">
          <span className="spin" aria-hidden="true" />
          Getting a quote from 1Click…
        </span>
      ) : error ? (
        <span className="warn act">
          <span className="wt">The quote did not come through</span>
          <p>{error}</p>
        </span>
      ) : quote ? (
        <>
          <span className="wd-recv">
            <span className="wd-k">You receive</span>
            <b className="num">
              ≈ {amountOf(quote.amountOut, quote.destination)} on {quote.to.chainName}
            </b>
            <span className="wd-min num">
              at least {amountOf(quote.minAmountOut, quote.destination)} · ≈ $
              {Number(quote.amountOutUsd.value).toFixed(2)}{' '}
              <ProvenanceMark kind="estimate">
                {describeProvenance(quote.amountOutUsd.provenance).label}
              </ProvenanceMark>
            </span>
          </span>
          <span className="inline-kv">
            <span>
              1Click fee
              <b className="num">
                {quote.fee.bps === null ? 'not reported' : `${(quote.fee.bps / 100).toFixed(2)}%`}
              </b>
            </span>
            <span>
              Arrives in<b>{minutes(quote.timeEstimateSeconds)}</b>
            </span>
            <span>
              If it fails
              <b>
                refunded to {account}
                {quote.origin.assetId === 'nep141:wrap.near' ? ' as wNEAR' : ''}
              </b>
            </span>
            <span>
              Quote valid<b className="num">{left > SEND_MARGIN_S ? remaining(left) : 'expired'}</b>
            </span>
          </span>
        </>
      ) : (
        <span className="wd-sub">
          Get a quote to see what arrives. Next you review the exact NEAR transaction, same as every
          other action.
        </span>
      )}
    </output>
  );
}

/**
 * Withdraw a token from the connected NEAR account to another chain through 1Click (#171), in the review-and-sign
 * sheet (#255). The server verifies and stores the quote; the NEAR transfer is built from that stored quote, passes
 * validateCascade and is signed in the user's NEAR wallet. Closing the sheet keeps tracking the transfer.
 */
export function WithdrawDialog({
  account,
  balances,
  signingEnabled,
  label = 'Withdraw',
  className = 'ds-btn ds-btn-secondary ds-btn-sm',
}: {
  account: string;
  balances: readonly WalletBalance[];
  signingEnabled: boolean;
  label?: string;
  className?: string;
}) {
  const sheet = useSheet();
  const ids = useId();
  const tracked = useWithdrawal();
  const [assets, setAssets] = useState<DepositAssets | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainId>(CHAINS[0]?.id ?? 'base');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [quotedAt, setQuotedAt] = useState(0);
  // The quote under review: its sheet stays mounted even if the form's quote expires or is cleared meanwhile.
  const [reviewing, setReviewing] = useState<DepositQuote | null>(null);
  const now = useNow();
  const [picking, setPicking] = useState<'send' | 'receive' | null>(null);
  const [showStatus, setShowStatus] = useState(false);
  const [wallets, setWallets] = useState<OriginWallet[]>([]);
  const [connecting, setConnecting] = useState(false);
  // In the page body, so a non-modal moment (withoutModal) never lays it out inside a popover that opened it.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  useEffect(() => (sheet.isOpen ? watchOriginWallets(setWallets) : undefined), [sheet.isOpen]);

  const held = withdrawSources(assets?.destinations ?? [], balances);
  const chosen = held.find((d) => d.assetId === origin);
  const targets = (assets?.origins ?? []).filter((o) => o.chain === chain);
  const receive = targets.find((t) => t.assetId === destination);
  const chainName = CHAINS.find((c) => c.id === chain)?.name ?? chain;
  const chains = CHAINS.filter((c) => assets?.origins.some((o) => o.chain === c.id));
  const parsed = chosen ? parseAmount(amount, chosen.decimals, chosen.balance) : null;
  const amountError = parsed && 'error' in parsed ? parsed.error : null;
  const recipientError = addressError(chain, recipient);
  const canQuote =
    !busy &&
    !!receive &&
    parsed !== null &&
    !amountError &&
    recipient.trim() !== '' &&
    !recipientError;

  const walletChain = walletChainOf(chain);
  const walletAddress = wallets.find((w) => w.chain === walletChain)?.address ?? '';
  // The connected wallet of the chosen chain is the recipient, until the user types another address.
  const autoRecipient = useRef('');
  useEffect(() => {
    const before = autoRecipient.current;
    autoRecipient.current = walletAddress;
    setRecipient((now) => (now === '' || now === before ? walletAddress : now));
  }, [walletAddress]);
  // Any change of address, typed or from a wallet switch, voids a quote bound to the old one.
  useEffect(() => {
    setQuote(null);
    setQuoteError(null);
  }, [recipient]);

  const stale =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setQuote(null);
      setQuoteError(null);
    };

  function pickChain(id: ChainId, list = assets, symbol = chosen?.symbol) {
    stale(setChain)(id);
    const here = (list?.origins ?? []).filter((o) => o.chain === id);
    setDestination(
      (here.find((o) => sameToken(o.symbol, symbol)) ?? defaultOrigin(list?.origins ?? [], id))
        ?.assetId ?? '',
    );
  }

  async function loadAssets() {
    setLoadError(null);
    const r = await loadDepositAssets();
    if (!r.ok) return setLoadError(plainQuoteError(r.status, r.error));
    setAssets(r.data);
    const first = withdrawSources(r.data.destinations, balances)[0];
    setOrigin(first?.assetId ?? '');
    const c = CHAINS.find((x) => r.data.origins.some((o) => o.chain === x.id));
    if (c) pickChain(c.id, r.data, first?.symbol);
  }

  function open(status = false) {
    setShowStatus(status);
    sheet.show();
    if (!assets) void loadAssets();
  }

  async function getQuote() {
    if (!canQuote || !parsed || 'error' in parsed) return;
    setBusy(true);
    setQuoteError(null);
    const r = await requestWithdrawQuote({
      account,
      originAsset: origin,
      destinationAsset: destination,
      amount: parsed.amount,
      recipient: recipient.trim(),
    });
    setBusy(false);
    if (r.ok) {
      setQuote(r.data);
      setQuotedAt(Date.now());
    } else setQuoteError(plainQuoteError(r.status, r.error));
  }

  async function connectWallet() {
    if (!walletChain) return;
    setConnecting(true);
    try {
      await withoutModal(sheet.ref.current, () => connectOriginWallet(walletChain));
    } finally {
      setConnecting(false);
    }
  }

  const left = quote
    ? Math.max(0, Math.floor((quotedAt + quote.expiresInSeconds * 1000 - now) / 1000))
    : 0;
  const offered = reviewing ?? (quote && left > SEND_MARGIN_S ? quote : null);
  const trackedId = useRef<string | null>(null);
  trackedId.current = tracked?.quote.id ?? null;
  const following = showStatus && tracked !== null;
  const ended = tracked ? timelineOf(tracked.status).end : undefined;

  function closed() {
    setPicking(null);
    if (following && ended) {
      forgetWithdrawal();
      setQuote(null);
      setAmount('');
    }
    setShowStatus(false);
  }

  const amountId = `${ids}-amount`;
  const recipientId = `${ids}-recipient`;

  const form = (
    <>
      {loadError ? (
        <div className="warn act" role="alert">
          <span className="wt">The token list did not load</span>
          <p>{loadError}</p>
          <Button size="sm" onClick={() => void loadAssets()}>
            Try again
          </Button>
        </div>
      ) : (
        !assets && (
          <div className="wd-skel" aria-busy="true" aria-label="Loading tokens">
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        )
      )}
      {assets && held.length === 0 && (
        <div className="warn watch" role="note">
          <span className="wt">Nothing to withdraw here</span>
          <p>Your wallet holds none of the tokens 1Click can send to another chain.</p>
        </div>
      )}
      {assets && held.length > 0 && (
        <>
          <div className="wd-field">
            <label htmlFor={amountId}>From your NEAR wallet</label>
            <div className="wd-inbox" data-invalid={amountError ? '' : undefined}>
              <input
                id={amountId}
                className="num"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={amount}
                aria-invalid={amountError ? true : undefined}
                aria-describedby={`${amountId}-note`}
                onChange={(e) => stale(setAmount)(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void getQuote()}
              />
              {chosen && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => stale(setAmount)(shareOf(chosen.balance, 100, chosen.decimals))}
                >
                  Max
                </Button>
              )}
              <TokenButton
                label="Token to send"
                token={chosen}
                where="on NEAR"
                disabled={false}
                onClick={() => setPicking('send')}
              />
            </div>
            <span id={`${amountId}-note`} className={amountError ? 'wd-err' : 'wd-sub num'}>
              {amountError ??
                (chosen && (
                  <>
                    Balance {chosen.balance} {chosen.symbol}{' '}
                    <ProvenanceMark
                      kind={chosen.assetId === 'nep141:wrap.near' ? 'estimate' : 'on_chain'}
                    />
                    {chosen.assetId === 'nep141:wrap.near' &&
                      ' · native NEAR is wrapped in the same transaction, 1 NEAR stays for fees'}
                  </>
                ))}
            </span>
          </div>
          <div className="wd-field">
            <span className="wd-label">To</span>
            <Segmented
              legend="Network"
              name={`${ids}-chain`}
              value={chain}
              options={chains.map((c) => ({
                value: c.id,
                label: (
                  <>
                    <img src={`/chains/${c.id}.svg`} alt="" width={16} height={16} />
                    {c.name}
                  </>
                ),
              }))}
              onChange={(id) => pickChain(id)}
            />
            <TokenButton
              label="Token to receive"
              token={receive}
              where={`on ${chainName}`}
              disabled={false}
              onClick={() => setPicking('receive')}
            />
          </div>
          <div className="wd-field">
            <label htmlFor={recipientId}>Address on {chainName}</label>
            <input
              id={recipientId}
              className="wd-addr"
              autoComplete="off"
              spellCheck={false}
              placeholder={chain === 'sol' ? 'Your Solana address' : '0x…'}
              value={recipient}
              aria-invalid={recipientError ? true : undefined}
              aria-describedby={`${recipientId}-note`}
              onChange={(e) => stale(setRecipient)(e.target.value)}
            />
            <span id={`${recipientId}-note`} className={recipientError ? 'wd-err' : 'wd-sub'}>
              {recipientError ??
                (walletAddress && recipient === walletAddress
                  ? `Filled from your connected ${walletChain ? CHAIN_LABEL[walletChain] : ''} wallet. `
                  : '')}
              {!recipientError && 'Check it: a transfer to a wrong address cannot be undone.'}
            </span>
            {!walletAddress && walletChain && (
              <Button
                size="sm"
                variant="ghost"
                disabled={connecting}
                onClick={() => void connectWallet()}
              >
                Fill from your {CHAIN_LABEL[walletChain]} wallet
              </Button>
            )}
          </div>
          <QuoteOutput quote={quote} left={left} busy={busy} error={quoteError} account={account} />
        </>
      )}
    </>
  );

  const footer = following ? (
    <Button variant={ended === 'ok' ? 'primary' : 'secondary'} onClick={sheet.close}>
      {ended ? 'Back to portfolio' : 'Close and keep tracking'}
    </Button>
  ) : picking ? null : offered ? (
    <PrepareDialog
      key={offered.id}
      request={{ account, intent: { action: 'withdraw_1click', quoteId: offered.id } }}
      label="Review and sign"
      title={`Send ${amountOf(offered.amountIn, offered.origin)} to ${shortHash(offered.recipient)} on ${offered.to.chainName}`}
      context="Withdraw via 1Click"
      signingEnabled={signingEnabled}
      size="md"
      once
      onSpent={(sent) => sent && trackWithdrawal(offered)}
      onSheetOpened={() => setReviewing(offered)}
      onSheetClosed={() => {
        setReviewing(null);
        if (trackedId.current === offered.id) setShowStatus(true);
      }}
    />
  ) : (
    <Button
      variant="primary"
      disabled={!canQuote}
      aria-disabled={!canQuote}
      onClick={() => void getQuote()}
    >
      {busy ? 'Getting a quote…' : quote ? 'Get a new quote' : 'Get quote'}
    </Button>
  );

  return (
    <>
      <button type="button" className={className} onClick={() => open(false)}>
        {label}
      </button>
      {tracked && !sheet.isOpen && (
        <button type="button" className="wd-chip" onClick={() => open(true)}>
          <span className="sr-only">Withdrawal: </span>
          {describeStatus(tracked.status, tracked.quote).title}
        </button>
      )}
      {host &&
        createPortal(
          <Sheet
            sheet={sheet}
            context={`Withdraw from ${account} · via 1Click`}
            title={
              following
                ? `${amountOf(tracked.quote.amountIn, tracked.quote.origin)} → ${tracked.quote.to.chainName}`
                : 'Send money to another chain'
            }
            onEscape={() => {
              if (!picking) return false;
              setPicking(null);
              return true;
            }}
            onClosed={closed}
            footer={footer}
          >
            {following ? (
              <Timeline t={tracked} />
            ) : picking === 'send' ? (
              <TokenPicker
                title="Send from NEAR"
                tokens={held}
                selected={origin}
                note={() => 'on NEAR'}
                onPick={(id) => {
                  stale(setOrigin)(id);
                  setAmount('');
                  setPicking(null);
                }}
                onBack={() => setPicking(null)}
              />
            ) : picking === 'receive' ? (
              <TokenPicker
                title={`Receive on ${chainName}`}
                tokens={targets}
                selected={destination}
                note={() => `on ${chainName}`}
                onPick={(id) => {
                  stale(setDestination)(id);
                  setPicking(null);
                }}
                onBack={() => setPicking(null)}
              />
            ) : (
              form
            )}
          </Sheet>,
          host,
        )}
    </>
  );
}
