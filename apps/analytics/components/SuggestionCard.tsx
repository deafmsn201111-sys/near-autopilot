import type { CSSProperties, ReactNode } from 'react';
import { shortHash } from '../lib/activity';
import { leadAndDetail, type CardStage, type SkippedMove } from '../lib/suggestions';
import { Card, Chip, FactsStrip, Receipt, type Fact } from './primitives';
import { TokenIcons } from './TokenIcon';

const LIFE_CHIP: Partial<Record<CardStage['kind'], ReactNode>> = {
  signing: <Chip tone="ai">Signing</Chip>,
  done: <Chip tone="safe">✓ Done</Chip>,
  failed: <Chip tone="liq">Not done</Chip>,
};

/**
 * One suggestion, the same for every agent and context (demo or a real account). The top card is the first one not
 * done: raised, with the 2px rule, and the only one whose caller gives it the primary button.
 */
export function SuggestionCard({
  top = false,
  aiPick = false,
  urgent = false,
  agent,
  logos,
  title,
  facts = [],
  why,
  extra,
  tags,
  actions,
  stage,
  className,
  style,
}: {
  top?: boolean;
  aiPick?: boolean;
  urgent?: boolean;
  agent: string;
  logos: readonly { icon: string | null; symbol: string }[];
  title: string;
  facts?: readonly Fact[];
  why: string;
  /** Card-specific content under the explanation: a repay amount, a plan disclosure. */
  extra?: ReactNode;
  tags?: ReactNode;
  actions?: ReactNode;
  stage: CardStage;
  className?: string;
  style?: CSSProperties;
}) {
  const done = stage.kind === 'done';
  const { lead, detail } = leadAndDetail(why);
  return (
    <Card
      top={top && !done}
      urgent={urgent && !done}
      className={`sg${stage.kind === 'signing' ? ' sg-working' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <div className="sg-top">
        {top && !done && <span className="sg-rank">#1{aiPick && ' · AI pick'}</span>}
        {urgent ? <Chip tone="act">Act now</Chip> : <Chip>Worth doing</Chip>}
        <span className="sg-agent">{agent}</span>
        <span className="sg-life">{LIFE_CHIP[stage.kind]}</span>
      </div>
      <h3 className="sg-title">
        {logos.length > 0 && <TokenIcons tokens={logos} size={28} />}
        {title}
      </h3>
      <div aria-live="polite">
        {done ? (
          <Receipt>
            <span>
              <b>✓ Done just now.</b> {title}
            </span>
            <span className="sg-sub">
              {stage.confirmed
                ? 'Confirmed on NEAR'
                : 'Sent; not checked here, verify it on NearBlocks'}
              {stage.hash && (
                <>
                  {' · '}
                  <a
                    href={`https://nearblocks.io/txns/${stage.hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx {shortHash(stage.hash)} ↗
                  </a>
                </>
              )}
            </span>
          </Receipt>
        ) : (
          <div className="sg-body">
            {facts.length > 0 && <FactsStrip items={facts} />}
            <p className="sg-why">
              <b>{lead}</b>
              {detail && ` ${detail}`}
            </p>
            {extra}
            {stage.kind === 'signing' && (
              <p className="sg-progress">
                <span className="sg-spin" aria-hidden="true" />
                Waiting for your wallet · step {stage.step} of {stage.of}
              </p>
            )}
            {stage.kind === 'failed' && <p className="sg-failed">{stage.reason}</p>}
          </div>
        )}
      </div>
      {(tags || actions) && (
        // One slot for the actions in every stage: moving them would remount the sign flow and close its sheet.
        <div className={done ? 'sg-hold' : 'sg-foot'}>
          {!done && <div className="sg-tags">{tags}</div>}
          {actions}
        </div>
      )}
    </Card>
  );
}

const moves = (n: number) => `${n} ${n === 1 ? 'move' : 'moves'}`;

/** Every move the agents checked and did not suggest, with its number and the reason: nothing is hidden. */
export function CheckedAndSkipped({ items }: { items: readonly SkippedMove[] }) {
  if (items.length === 0) return null;
  return (
    <details className="ds-panel sg-skipped">
      <summary>
        <span className="sg-chev" aria-hidden="true">
          ›
        </span>
        Checked and skipped <span>· {moves(items.length)} not worth doing now</span>
      </summary>
      {items.map((s, i) => (
        <div className="sg-sk-row" key={i}>
          {s.title && <span className="sg-sk-t">{s.title}</span>}
          {s.number && <span className="sg-sk-n num">{s.number}</span>}
          <p>{s.reason}</p>
        </div>
      ))}
    </details>
  );
}

export function NothingToDo({ why }: { why: string }) {
  return (
    <p className="sg-empty">
      <b>Nothing to do right now.</b> {why}
    </p>
  );
}
