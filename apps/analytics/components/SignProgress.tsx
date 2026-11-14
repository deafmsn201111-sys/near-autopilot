'use client';
import type { StepState } from '../lib/sign-progress';

const CHECK = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="m5 12.5 4.5 4.5L19 7.5"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const CROSS = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

const STATE_LABEL: Record<StepState['kind'], string> = {
  waiting: 'waiting',
  signing: 'waiting for your wallet',
  checking: 'executing on NEAR',
  stopped: 'not signed',
  sent: 'sent',
  done: 'confirmed',
  failed: 'failed',
  unknown: 'not confirmed yet',
};

function Marker({ s, n }: { s: StepState; n: number }) {
  if (s.kind === 'done' || s.kind === 'sent') return <span className="n ok">{CHECK}</span>;
  if (s.kind === 'failed' || s.kind === 'stopped') return <span className="n bad">{CROSS}</span>;
  if (s.kind === 'signing' || s.kind === 'checking')
    return (
      <span className="n run">
        <span className="spin" />
      </span>
    );
  return <span className="n">{n}</span>;
}

const explorer = (hash: string) => `https://nearblocks.io/txns/${hash}`;

function Detail({ s }: { s: StepState }) {
  if (s.kind === 'waiting') return <small>Waiting</small>;
  if (s.kind === 'signing') return <small>Approve it in your wallet…</small>;
  if (s.kind === 'checking') return <small>Executing on NEAR…</small>;
  if (s.kind === 'stopped') return <small>Not signed: {s.reason}</small>;
  if (s.kind === 'sent')
    return (
      <small>
        Sent; not checked here.{' '}
        <a href={explorer(s.hash)} target="_blank" rel="noreferrer">
          See it on NearBlocks
        </a>
      </small>
    );
  const r = s.result;
  const text =
    r.status === 'confirmed'
      ? ['Confirmed on NEAR', ...r.lines]
      : r.status === 'failed'
        ? ['Failed on NEAR', ...r.lines]
        : r.status === 'unknown'
          ? [r.reason]
          : [];
  return (
    <small>
      {text.length > 0 && `${text.join(' · ')} · `}
      <a href={explorer(s.hash)} target="_blank" rel="noreferrer">
        tx {s.hash.slice(0, 6)}…
      </a>
    </small>
  );
}

/** Each step of the cascade, in order: approved in the wallet, then executing, then what NEAR says happened. */
export function SignProgress({
  preview,
  steps,
}: {
  preview: readonly string[];
  steps: readonly StepState[];
}) {
  return (
    <ol className="sh-steps">
      {steps.map((s, i) => (
        <li key={`${i}-${preview[i] ?? ''}`} className="sh-step">
          <Marker s={s} n={i + 1} />
          <div>
            <span className="sr-only">
              Step {i + 1}, {STATE_LABEL[s.kind]}:{' '}
            </span>
            {preview[i] ?? `Step ${i + 1}`}
            <Detail s={s} />
          </div>
        </li>
      ))}
    </ol>
  );
}
