import Link from 'next/link';
import { pct, usdCompact } from '../lib/format';
import type { Opportunity } from '../lib/product';
import { Level, Status } from './ui';

const PROTOCOL = { rhea: 'Rhea · liquidity pool', burrow: 'Burrow · lending' } as const;

export function OpportunityHead() {
  return (
    <div className="opp-head" aria-hidden="true">
      <span>Opportunity</span>
      <span>Yield (gross)</span>
      <span>Net after costs</span>
      <span>Liquidity</span>
      <span className="hide-md">Risk</span>
      <span className="hide-md">Status</span>
      <span />
    </div>
  );
}

/** One opportunity as a row on desktop and a card on a phone; the whole row opens its details. */
export function OpportunityRow({ o }: { o: Opportunity }) {
  return (
    <Link href={`/opportunities/${encodeURIComponent(o.id)}`} className="opp">
      <div className="name">
        <b>{o.title}</b>
        <span>
          {PROTOCOL[o.protocol]}
          {!o.fresh && ' · data out of date'}
        </span>
      </div>
      <div className="metric">
        <span className="k">Yield</span>
        <span className="v" data-tip={o.grossBasis}>
          {o.grossApr === null ? '—' : pct(o.grossApr, 1)}
        </span>
      </div>
      <div className="metric">
        <span className="k">Net</span>
        <span
          className={`v ${o.netApr === null ? 'dim' : o.netApr < 0 ? 'neg' : ''}`}
          data-tip={o.netBasis ?? 'not simulated: no stored cost simulation for this opportunity'}
        >
          {o.netApr === null ? 'not simulated' : pct(o.netApr, 1)}
        </span>
      </div>
      <div className="metric">
        <span className="k">Liquidity</span>
        <span className="v">{usdCompact(o.liquidityUsd)}</span>
      </div>
      <div className="metric hide-md">
        <span className="k">Risk</span>
        <span>
          <Level level={o.risk.level} score={o.risk.score} what="risk" />
        </span>
      </div>
      <div className="metric hide-md">
        <span className="k">Status</span>
        <span>
          <Status code={o.status} />
        </span>
      </div>
      <span className="chev" aria-hidden="true">
        ›
      </span>
      <p className="why" style={{ margin: 0 }}>
        {o.why}
      </p>
    </Link>
  );
}
