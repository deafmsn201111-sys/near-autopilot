'use client';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type PointerEvent } from 'react';
import { refreshAccount } from '../app/account-actions';
import { refreshPortfolio } from '../lib/portfolio-refresh';
import { prepareIntent } from '../lib/prepare-client';
import {
  gasToTgas,
  shortAccount,
  totalDepositNear,
  trimDecimals,
  yoctoToNear,
} from '../lib/prepare-format';
import type { PrepareRequest, PreparedCascade } from '../lib/prepare-types';
import { confirmStep } from '../lib/events-client';
import { mayContinue, progressResult, stepAfterCheck, type StepState } from '../lib/sign-progress';
import {
  balanceChanges,
  swapImpactTier,
  plainError,
  signLock,
  swapLossUsd,
  type BalanceChange,
} from '../lib/sign-review';
import { money, plural } from '../lib/format';
import { withoutModal } from '../lib/modal';
import { signCascade } from '../lib/wallet-sign';
import { stageAfterSign, type CardStage } from '../lib/suggestions';
import { SignProgress } from './SignProgress';
import { Button, ProvenanceMark, SignButton } from './primitives';
import { TokenIcon } from './TokenIcon';

const EXIT_MS = 150;
const DISMISS_DRAG_PX = 100;

const tokens = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 1 ? 6 : 4 });

const ALERT = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const CHECK = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="m5 12.5 4.5 4.5L19 7.5"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

function Change({ c }: { c: BalanceChange }) {
  const out = c.dir === 'out';
  return (
    <div className="chg">
      <span className={`sgn ${c.dir}`} aria-hidden="true">
        {out ? '−' : '+'}
      </span>
      <span className="amt num">
        <span className="sr-only">{out ? 'You send' : 'You receive'} </span>
        <TokenIcon icon={null} symbol={c.symbol} size={20} />
        {c.min !== undefined ? `≥ ${tokens(c.min)}` : tokens(c.human)} {c.symbol}
      </span>
      <span className="usd num">
        {c.min !== undefined
          ? `expected ≈ ${tokens(c.human)}${c.usd !== undefined ? ` · ${money(c.usd, false)}` : ''}`
          : c.usd !== undefined && `≈ ${money(c.usd, false)}`}
      </span>
    </div>
  );
}

function Review({
  cascade,
  ack,
  onAck,
}: {
  cascade: PreparedCascade;
  ack: boolean;
  onAck: (v: boolean) => void;
}) {
  const changes = balanceChanges(cascade);
  const swap = cascade.cost?.swap ?? null;
  const impact = swap?.priceImpactPct ?? null;
  const tier = swapImpactTier(cascade);
  const loss = swapLossUsd(cascade);
  const lossText = loss !== null ? ` · about ${money(loss, false)} lost to the pool` : '';
  const attached = trimDecimals(totalDepositNear(cascade.transactions), 4);
  const facts: [string, string][] = [];
  if (swap) facts.push(['Max slippage', `${(swap.slippageBps / 100).toFixed(2)}%`]);
  if (impact !== null && tier === 'none') facts.push(['Price impact', `${impact.toFixed(2)}%`]);
  if (attached !== '0') facts.push(['NEAR attached', attached]);
  if (cascade.cost) facts.push(['Network fee', `up to ${cascade.cost.networkFeeMaxNear} NEAR`]);
  const calls = cascade.transactions.flatMap((tx) =>
    tx.actions.map((a, i) => ({ key: `${tx.intentId}-${i}`, tx, a })),
  );
  return (
    <>
      {changes.length > 0 && (
        <section className="changes" aria-label="Balance changes">
          <h3>
            <span>Balance changes</span>
            <ProvenanceMark kind="estimate">Estimate at current prices</ProvenanceMark>
          </h3>
          {changes.map((c) => (
            <Change key={`${c.dir}-${c.symbol}`} c={c} />
          ))}
        </section>
      )}
      {tier !== 'none' && (
        <div className={`warn ${tier === 'watch' ? 'watch' : tier}`} role="note">
          <span className="wt">
            {ALERT}
            {impact === null
              ? 'Price impact could not be measured'
              : `Price impact ${impact.toFixed(1)}%${lossText}`}
          </span>
          <p>
            {tier === 'unknown'
              ? 'We could not read this pool’s depth, so the loss to the pool is unknown. The minimum you receive is still enforced on-chain.'
              : tier === 'watch'
                ? 'You receive a little less than the market price because of the pool’s depth.'
                : tier === 'block'
                  ? 'The pool is far too thin for this size, so it is not offered for signing. Swap a smaller part, or split it over several days.'
                  : 'The pool is too thin for this size. Swap a smaller part, or split it over several days.'}
          </p>
          {(tier === 'act' || tier === 'unknown') && (
            <label className="ack">
              <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} />
              <span>
                {impact === null
                  ? 'I understand I may receive less than the market price.'
                  : `I understand I receive ${loss !== null ? `about ${money(loss, false)}` : `${impact.toFixed(1)}%`} less than the market price.`}
              </span>
            </label>
          )}
        </div>
      )}
      {facts.length > 0 && (
        <div className="inline-kv">
          {facts.map(([k, v]) => (
            <span key={k}>
              {k}
              <b className="num">{v}</b>
            </span>
          ))}
        </div>
      )}
      <div className="sign-block">
        <h3>What you will sign · {plural(cascade.transactions.length, 'transaction')}</h3>
        <ol className="sh-steps">
          {cascade.preview.map((line, i) => (
            <li className="sh-step" key={`${i}-${line.slice(0, 16)}`}>
              <span className="n">{i + 1}</span>
              <div>
                {line}
                {cascade.transactions[i] && (
                  <small>to {shortAccount(cascade.transactions[i].receiverId)}</small>
                )}
              </div>
            </li>
          ))}
        </ol>
        <details className="raw">
          <summary>Exact calls ({calls.length})</summary>
          <table>
            <tbody>
              {calls.map(({ key, tx, a }) => (
                <tr key={key}>
                  <td title={tx.receiverId}>{shortAccount(tx.receiverId)}</td>
                  <td>{a.methodName}</td>
                  <td>
                    {trimDecimals(yoctoToNear(a.deposit))} NEAR · {gasToTgas(a.gas)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <div className="safety-line">
          <span>{CHECK}Signer is you</span>
          <span>{CHECK}Receivers on the allowlist</span>
          <span>{CHECK}Methods allowed</span>
          <span>{CHECK}Gas and NEAR attached within limits</span>
          {swap && <span>{CHECK}Minimum received is enforced on-chain</span>}
          <a href="/policy" target="_blank" rel="noreferrer">
            How we check
          </a>
        </div>
      </div>
    </>
  );
}

/**
 * One-click: ask the server to ASSEMBLE the exact transaction cascade for a recommendation and review it in a sheet —
 * what leaves and comes back first, then any price-impact warning, the steps, the exact calls and the checks they
 * passed. "Sign" hands the cascade to the connected wallet (only when signing is enabled and this is the owner's
 * account); the wallet shows every action again. The server holds no key and sends nothing.
 */
export function PrepareDialog({
  request,
  label,
  title,
  context,
  signingEnabled = false,
  blocked = null,
  once = false,
  variant = 'primary',
  onStage,
  onSheetClosed,
}: {
  request: PrepareRequest;
  label: string;
  title?: string;
  context?: string;
  signingEnabled?: boolean;
  /** Why this view cannot sign at all (read-only, signing off), shown before the user tries. */
  blocked?: string | null;
  /** One payment (a 1Click withdrawal): after one signing attempt it is never offered to sign or build again. */
  once?: boolean;
  variant?: 'primary' | 'secondary';
  /** Where the signing stands, for the card around it. The card keeps this dialog mounted, so its sheet stays open. */
  onStage?: (stage: CardStage) => void;
  onSheetClosed?: () => void;
}) {
  const router = useRouter();
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const build = useRef(0);
  const signing = useRef(false);
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);
  const [state, setState] = useState<'idle' | 'loading' | 'signing'>('idle');
  const [cascade, setCascade] = useState<PreparedCascade | null>(null);
  const [ack, setAck] = useState(false);
  const [spent, setSpent] = useState<'sent' | 'tried' | null>(null);
  const [error, setError] = useState<{ message: string; reasons?: readonly string[] } | null>(null);
  const [progress, setProgress] = useState<{
    preview: readonly string[];
    steps: StepState[];
  } | null>(null);
  const busy = state === 'signing';
  const result = progress && progressResult(progress.steps, busy);
  const lock = signLock({
    blocked: blocked ?? (signingEnabled ? null : 'Signing is off on this server.'),
    tier: cascade ? swapImpactTier(cascade) : 'none',
    ack,
  });

  async function run() {
    setOpen(true);
    setEntered(false);
    setClosing(false);
    setState('loading');
    setError(null);
    setCascade(null);
    setAck(false);
    setProgress(null);
    requestAnimationFrame(() => {
      if (!ref.current?.open) ref.current?.showModal();
      document.getElementById(titleId)?.focus({ preventScroll: true });
    });
    const id = ++build.current;
    const r = await prepareIntent(request);
    if (id !== build.current) return;
    if (r.ok) setCascade(r.cascade);
    else
      setError({
        message: plainError(r.error, r.status),
        ...(r.reasons ? { reasons: r.reasons } : {}),
      });
    setState('idle');
  }

  function close() {
    if (busy || closing) return;
    setClosing(true);
    setTimeout(() => ref.current?.close(), EXIT_MS);
  }

  function closed() {
    // Signing drops the sheet to non-modal and back (lib/modal.ts): that close is not the user's.
    if (ref.current?.open) return;
    build.current++;
    setOpen(false);
    setClosing(false);
    const signed = progress !== null;
    setProgress(null);
    onSheetClosed?.();
    if (!signed) return;
    // The portfolio changes only once the sheet is gone: changed rows flash while this refresh runs.
    document.documentElement.dataset.refreshing = '';
    void refreshPortfolio(request.account, refreshAccount, () => router.refresh()).finally(() =>
      setTimeout(() => delete document.documentElement.dataset.refreshing, 1_600),
    );
  }

  async function sign() {
    if (!cascade || !lock.ready || closing || signing.current) return;
    signing.current = true;
    const { cascadeId, transactions, preview } = cascade;
    setState('signing');
    setProgress({ preview, steps: transactions.map(() => ({ kind: 'waiting' })) });
    const setStep = (i: number, s: StepState) =>
      setProgress((p) => p && { ...p, steps: p.steps.map((x, j) => (j === i ? s : x)) });
    let at = 0;
    let confirmed = true;
    let through = 0;
    // Inside another modal (the withdraw dialog) both step down, or the wallet's popup stays inert behind them.
    const outer = ref.current?.parentElement?.closest('dialog') ?? null;
    const r = await withoutModal(ref.current, () =>
      withoutModal(outer, () =>
        signCascade(transactions, request.account, signingEnabled, {
          onSigning: (i) => {
            at = i;
            setStep(i, { kind: 'signing' });
            onStage?.({ kind: 'signing', step: i + 1, of: transactions.length });
          },
          onSent: async (i, hash) => {
            setStep(i, { kind: 'checking', hash });
            const checked = cascadeId
              ? await confirmStep({ account: request.account, cascadeId, step: i, hash })
              : ({ status: 'unknown', reason: 'This server cannot confirm steps.' } as const);
            const next = stepAfterCheck(hash, checked);
            if (next.kind !== 'done') confirmed = false;
            if (mayContinue(next)) through += 1;
            setStep(i, next);
            return mayContinue(next);
          },
        }),
      ),
    );
    if (!r.ok && r.hashes.length === at)
      setStep(at, { kind: 'stopped', reason: r.reason ?? 'declined in the wallet' });
    onStage?.(stageAfterSign(r, { confirmed, through, steps: transactions.length }));
    // A wallet may broadcast and still fail or return no hash: any attempt spends a one-payment cascade.
    if (once) setSpent(r.hashes.length > 0 ? 'sent' : 'tried');
    signing.current = false;
    setState('idle');
  }

  function grab(e: PointerEvent<HTMLDivElement>) {
    if (busy) return;
    drag.current = { y: e.clientY, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || !ref.current) return;
    d.dy = Math.max(0, e.clientY - d.y);
    ref.current.style.transform = `translateY(${d.dy}px)`;
  }
  function release() {
    const d = drag.current;
    drag.current = null;
    if (!d || !ref.current) return;
    ref.current.style.transform = '';
    if (d.dy > DISMISS_DRAG_PX) close();
  }

  return (
    <div className="prepare">
      {spent ? (
        <p className="muted-note">
          {spent === 'sent'
            ? 'Sent from your wallet. Do not send it again; the status above follows it.'
            : 'Not sent, as far as the wallet reported. Check your wallet activity; to try again, get a new quote.'}
        </p>
      ) : (
        <Button variant={variant} size="sm" onClick={() => void run()}>
          {label}
        </Button>
      )}

      {open && (
        <dialog
          ref={ref}
          className={`sheet${entered ? ' entered' : ''}${closing ? ' closing' : ''}`}
          aria-labelledby={titleId}
          aria-busy={state !== 'idle'}
          onAnimationEnd={(e) =>
            e.target === e.currentTarget && !e.pseudoElement && setEntered(true)
          }
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
          onClose={closed}
        >
          <div
            className="grab"
            aria-hidden="true"
            onPointerDown={grab}
            onPointerMove={move}
            onPointerUp={release}
            onPointerCancel={release}
          />
          <header className="sh-head">
            {context && <span className="ctxl">{context}</span>}
            <h2 id={titleId} tabIndex={-1}>
              {title ?? label}
            </h2>
            {!busy && (
              <button type="button" className="x" aria-label="Close" onClick={close}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M6 6l12 12M18 6 6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
          </header>

          <div className="sh-body">
            {state === 'loading' && (
              <p className="sh-loading" role="status">
                <span className="spin" aria-hidden="true" />
                Building the exact transaction…
              </p>
            )}
            {error && (
              <div className="warn act" role="alert">
                <span className="wt">{ALERT}Can’t build this safely</span>
                <p>{error.message}</p>
                {error.reasons && error.reasons.length > 0 && (
                  <ul>
                    {error.reasons.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {progress ? (
              <SignProgress preview={progress.preview} steps={progress.steps} />
            ) : (
              cascade && <Review cascade={cascade} ack={ack} onAck={setAck} />
            )}
          </div>

          <footer className="sh-foot">
            <div role="status" className="sh-status">
              {busy && (
                <span className="why-off">
                  Keep this window open until every step is confirmed on NEAR.
                </span>
              )}
              {result && (
                <div className={`result ${result.tone}`}>
                  <b>{result.title}</b>
                  <span>{result.detail}</span>
                </div>
              )}
            </div>
            {result ? (
              <Button variant={result.tone === 'ok' ? 'primary' : 'secondary'} onClick={close}>
                {result.tone === 'ok' ? 'Back to portfolio' : 'Close'}
              </Button>
            ) : (
              cascade &&
              !progress && (
                <SignButton
                  ready={lock.ready}
                  gate={!lock.ready && lock.gate}
                  reason={lock.ready ? undefined : lock.reason}
                  onClick={() => void sign()}
                >
                  {!lock.ready && lock.gate
                    ? 'Confirm the price impact to sign'
                    : 'Sign in your wallet'}
                </SignButton>
              )
            )}
            {cascade && !progress && lock.ready && (
              <span className="why-off">
                Your wallet will show the same {plural(cascade.transactions.length, 'transaction')}.
                Nothing is sent until you approve there.
              </span>
            )}
          </footer>
        </dialog>
      )}
    </div>
  );
}
