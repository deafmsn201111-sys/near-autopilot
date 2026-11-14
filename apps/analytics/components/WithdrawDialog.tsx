'use client';
import { describeProvenance } from '@near-autopilot/core';
import { useEffect, useRef, useState } from 'react';
import {
  DEPOSIT_CHAINS,
  defaultOrigin,
  formatUnits,
  loadDepositAssets,
  walletChainOf,
  type DepositAssets,
  type DepositQuote,
} from '../lib/deposit';
import { watchOriginWallets, type OriginWallet } from '../lib/hot-kit';
import { requestWithdrawQuote, shareOf, WITHDRAW_CHAINS } from '../lib/withdraw';
import {
  OriginWallets,
  REFUND_HINT,
  remaining,
  StatusLine,
  TokenButton,
  TokenPicker,
  useNow,
} from './DepositDialog';
import { PrepareDialog } from './PrepareDialog';

/** A token the connected NEAR wallet holds, as the portfolio reports it (floored to at most 6 decimals). */
export interface WalletBalance {
  readonly token: string;
  readonly amount: number;
}

const SHARES = [25, 50, 100] as const;
const CHAINS = DEPOSIT_CHAINS.filter((c) => (WITHDRAW_CHAINS as readonly string[]).includes(c.id));

function WithdrawQuote({
  q,
  account,
  signingEnabled,
  onBack,
}: {
  q: DepositQuote;
  account: string;
  signingEnabled: boolean;
  onBack: () => void;
}) {
  const now = useNow();
  const [expiresAt] = useState(() => Date.now() + q.expiresInSeconds * 1000);
  const left = Math.max(0, Math.floor((expiresAt - now) / 1000));
  const send = `${formatUnits(q.amountIn, q.origin.decimals)} ${q.origin.symbol}`;
  return (
    <>
      <h3>
        Send {send} to {q.to.chainName}
      </h3>
      {left === 0 ? (
        <p className="deposit-warn">This quote has expired. Do not send to it; get a new one.</p>
      ) : (
        <p>
          Sign one NEAR transaction within <b className="num">{remaining(left)}</b>: it sends {send}{' '}
          from <b>{account}</b> to the 1Click deposit address of this quote.
        </p>
      )}
      <StatusLine q={q} />
      {left > 0 && (
        <PrepareDialog
          request={{ account, intent: { action: 'withdraw_1click', quoteId: q.id } }}
          label="Build transaction"
          signingEnabled={signingEnabled}
          once
        />
      )}
      <dl className="deposit-facts">
        <dt>You send</dt>
        <dd className="num">{send} on NEAR</dd>
        <dt>You receive (estimate)</dt>
        <dd className="num">
          ≈ {formatUnits(q.amountOut, q.destination.decimals)} {q.destination.symbol} on{' '}
          {q.to.chainName}, at least {formatUnits(q.minAmountOut, q.destination.decimals)}
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
              <span className="muted-note">
                {' '}
                · {describeProvenance(q.fee.provenance).label}, already taken off what you receive
              </span>
            </>
          )}
        </dd>
        <dt>To address</dt>
        <dd>
          <code>{q.recipient}</code>
        </dd>
        <dt>Refund to</dt>
        <dd>{q.refundTo}</dd>
        <dt>Deposit address</dt>
        <dd>
          <code>{q.depositAddress}</code>
        </dd>
        <dt>Deadline</dt>
        <dd>{new Date(q.deadline).toLocaleString()}</dd>
        <dt>Arrives in</dt>
        <dd>
          usually about {Math.max(1, Math.round(q.timeEstimateSeconds / 60))} min after the
          transaction confirms
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
 * Withdraw a token from the connected NEAR account to another chain through 1Click (#171). The server verifies and
 * stores the quote; the NEAR transfer is then built from that stored quote and signed in the user's NEAR wallet.
 */
export function WithdrawDialog({
  account,
  balances,
  signingEnabled,
}: {
  account: string;
  balances: readonly WalletBalance[];
  signingEnabled: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [assets, setAssets] = useState<DepositAssets | null>(null);
  const [chain, setChain] = useState<string>(CHAINS[0]?.id ?? 'base');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<DepositQuote | null>(null);
  const [picking, setPicking] = useState<'send' | 'receive' | null>(null);
  const [opened, setOpened] = useState(false);
  const [wallets, setWallets] = useState<OriginWallet[]>([]);
  useEffect(() => (opened ? watchOriginWallets(setWallets) : undefined), [opened]);

  const held = (assets?.destinations ?? []).filter((d) =>
    balances.some((b) => `nep141:${b.token}` === d.assetId && b.amount > 0),
  );
  const chosen = held.find((d) => d.assetId === origin);
  const balance = balances.find((b) => `nep141:${b.token}` === origin)?.amount ?? 0;
  const targets = (assets?.origins ?? []).filter((o) => o.chain === chain);
  const receive = targets.find((t) => t.assetId === destination);
  const chainName = CHAINS.find((c) => c.id === chain)?.name ?? chain;
  const chains = CHAINS.filter((c) => assets?.origins.some((o) => o.chain === c.id));

  const walletAddress = wallets.find((w) => w.chain === walletChainOf(chain))?.address ?? '';
  // The connected wallet of the chosen chain is the recipient, until the user types another address.
  const autoRecipient = useRef('');
  useEffect(() => {
    const before = autoRecipient.current;
    autoRecipient.current = walletAddress;
    setRecipient((now) => (now === '' || now === before ? walletAddress : now));
  }, [walletAddress]);

  function pickChain(id: string, list = assets, symbol = chosen?.symbol) {
    setChain(id);
    const here = (list?.origins ?? []).filter((o) => o.chain === id);
    setDestination(
      (here.find((o) => o.symbol === symbol) ?? defaultOrigin(list?.origins ?? [], id))?.assetId ??
        '',
    );
  }

  async function open() {
    ref.current?.showModal();
    setOpened(true);
    if (assets) return;
    setError(null);
    const r = await loadDepositAssets();
    if (!r.ok) return setError(r.error);
    setAssets(r.data);
    const first = r.data.destinations.find((d) =>
      balances.some((b) => `nep141:${b.token}` === d.assetId && b.amount > 0),
    );
    setOrigin(first?.assetId ?? '');
    const c = CHAINS.find((x) => r.data.origins.some((o) => o.chain === x.id));
    if (c) pickChain(c.id, r.data, first?.symbol);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await requestWithdrawQuote({
      account,
      originAsset: origin,
      destinationAsset: destination,
      amount: amount.trim(),
      recipient: recipient.trim(),
    });
    setBusy(false);
    if (r.ok) setQuote(r.data);
    else setError(r.error);
  }

  return (
    <>
      <button type="button" className="btn secondary small" onClick={() => void open()}>
        Withdraw to another chain
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
          <WithdrawQuote
            q={quote}
            account={account}
            signingEnabled={signingEnabled}
            onBack={() => setQuote(null)}
          />
        ) : picking === 'send' ? (
          <TokenPicker
            title="Send from NEAR"
            tokens={held}
            selected={origin}
            note={() => 'on NEAR'}
            onPick={(id) => {
              setOrigin(id);
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
              setDestination(id);
              setPicking(null);
            }}
            onBack={() => setPicking(null)}
          />
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h3>Withdraw to another chain</h3>
            <p>
              Through NEAR Intents 1Click. You sign one transaction in your NEAR wallet; it arrives
              at the address you give on the chain you pick. A refund comes back to <b>{account}</b>
              .
            </p>
            {opened && <OriginWallets wallets={wallets} />}
            <div className="asset-box">
              <span className="asset-box-label">You send from NEAR</span>
              <div className="asset-box-row">
                <TokenButton
                  label="Token to send"
                  token={chosen}
                  where="on NEAR"
                  disabled={!assets || held.length === 0}
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
              {chosen && balance > 0 && (
                <div className="chain-chips" aria-label="Share of your balance">
                  <span className="muted-note">
                    Balance {balance} {chosen.symbol}
                  </span>
                  {SHARES.map((p) => (
                    <button
                      type="button"
                      key={p}
                      className="btn secondary small"
                      onClick={() => setAmount(shareOf(balance, p, chosen.decimals))}
                    >
                      {p === 100 ? 'Max' : `${p}%`}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {assets && held.length === 0 && (
              <p className="deposit-warn">
                Your wallet holds none of the tokens that can be withdrawn here.
              </p>
            )}
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
              <span className="asset-box-label">You receive on {chainName}</span>
              <div className="asset-box-row">
                <TokenButton
                  label="Token to receive"
                  token={receive}
                  where={`on ${chainName}`}
                  disabled={!assets}
                  onClick={() => setPicking('receive')}
                />
              </div>
            </div>
            <label className="field">
              Recipient address on {chainName}
              <input
                autoComplete="off"
                spellCheck={false}
                placeholder={REFUND_HINT[chain] ?? ''}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                required
              />
              <span className="muted-note">
                {walletAddress && recipient === walletAddress
                  ? 'Filled from your connected wallet. '
                  : ''}
                Check it: a transfer to a wrong address cannot be undone.
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
                {busy ? 'Getting a quote…' : 'Get quote'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
