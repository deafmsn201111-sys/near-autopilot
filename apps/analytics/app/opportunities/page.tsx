import Link from 'next/link';
import { OpportunityHead, OpportunityRow } from '../../components/OpportunityRow';
import { EmptyState, PageHeader } from '../../components/ui';
import { ErrorState } from '../../components/states';
import { int } from '../../lib/format';
import { opportunities } from '../../lib/product';
import { ProvenanceNote } from '../../components/ProvenanceNote';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

/** The three honest buckets (brief §8): what passes, what is held back and why, and what has no reliable data yet. */
const GROUPS = [
  {
    status: 'candidate',
    title: 'Recommended',
    note: 'Pass every filter — a shortlist to study, never an instruction. Nothing is executed.',
  },
  {
    status: 'watch',
    title: 'Watchlist',
    note: 'Promising, but one thing holds each back (shown on its row). Worth watching.',
  },
  {
    status: 'insufficient_data',
    title: 'Not enough data yet',
    note: 'No reliable yield measured, so no score is claimed.',
  },
] as const;

const SORTS = [
  ['score', 'Most attractive'],
  ['risk', 'Lowest risk'],
  ['net', 'Highest net yield'],
  ['liquidity', 'Deepest liquidity'],
  ['fresh', 'Freshest data'],
] as const;

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const q = {
    protocol: one(sp.protocol),
    status: one(sp.status),
    risk: one(sp.risk),
    minLiquidity: one(sp.minLiquidity),
    sort: one(sp.sort) || 'score',
  };
  const qs = new URLSearchParams(
    Object.entries({ ...q, limit: '200' }).filter(([, v]) => v !== ''),
  ).toString();
  const { data, error } = await opportunities(qs);
  const href = (patch: Partial<typeof q>) =>
    `/opportunities?${new URLSearchParams(Object.entries({ ...q, ...patch }).filter(([, v]) => v !== '' && v !== 'score')).toString()}`;
  const excluded = data ? Object.entries(data.excluded).sort((a, b) => b[1] - a[1]) : [];
  return (
    <>
      <PageHeader
        title="Opportunities"
        lead="Every Rhea pool and Burrow market with usable data, ranked by yield, risk and how much the numbers can be trusted. A high APR on thin liquidity does not make the top."
        meta={
          data
            ? `${int(data.total)} found · ${int(data.counts.candidate)} pass the filters`
            : undefined
        }
      />
      <div className="toolbar">
        <nav className="segmented" aria-label="Protocol">
          {[
            ['', 'All'],
            ['rhea', 'Rhea pools'],
            ['burrow', 'Burrow lending'],
          ].map(([v, l]) => (
            <Link
              key={v}
              href={href({ protocol: v ?? '' })}
              aria-current={q.protocol === v ? 'true' : undefined}
            >
              {l}
            </Link>
          ))}
        </nav>
        <nav className="segmented" aria-label="Status">
          {[
            ['', 'Any status'],
            ['candidate', `Pass the filters${data ? ` (${data.counts.candidate})` : ''}`],
            ['watch', `Watch only${data ? ` (${data.counts.watch})` : ''}`],
          ].map(([v, l]) => (
            <Link
              key={v}
              href={href({ status: v ?? '' })}
              aria-current={q.status === v ? 'true' : undefined}
            >
              {l}
            </Link>
          ))}
        </nav>
        <form method="get" className="filters" style={{ margin: 0 }}>
          {q.protocol && <input type="hidden" name="protocol" value={q.protocol} />}
          {q.status && <input type="hidden" name="status" value={q.status} />}
          {q.risk && <input type="hidden" name="risk" value={q.risk} />}
          {q.minLiquidity && <input type="hidden" name="minLiquidity" value={q.minLiquidity} />}
          <label>
            Sort
            <select name="sort" defaultValue={q.sort}>
              {SORTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Apply</button>
        </form>
      </div>
      <details
        className="more"
        open={Boolean(q.risk || q.minLiquidity)}
        style={{ marginBottom: 16 }}
      >
        <summary>More filters</summary>
        <form method="get" className="filters">
          {q.protocol && <input type="hidden" name="protocol" value={q.protocol} />}
          {q.status && <input type="hidden" name="status" value={q.status} />}
          <input type="hidden" name="sort" value={q.sort} />
          <label>
            Risk
            <select name="risk" defaultValue={q.risk}>
              <option value="">any</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </label>
          <label>
            Minimum liquidity (USD)
            <input
              name="minLiquidity"
              inputMode="numeric"
              placeholder="e.g. 100000"
              defaultValue={q.minLiquidity}
            />
          </label>
          <button type="submit">Apply</button>
          <Link href="/opportunities" className="dim" style={{ alignSelf: 'center' }}>
            Reset all
          </Link>
        </form>
      </details>

      {!data ? (
        <ErrorState what="Opportunities" error={error} />
      ) : data.opportunities.length === 0 ? (
        <EmptyState
          title="No opportunity matches these filters."
          action={
            <Link className="btn secondary" href="/opportunities">
              Clear the filters
            </Link>
          }
        >
          {data.total} opportunities exist in total; the current filters exclude all of them.
        </EmptyState>
      ) : (
        GROUPS.map((g) => {
          const items = data.opportunities.filter((o) => o.status === g.status);
          if (items.length === 0) return null;
          return (
            <section className="block" key={g.status}>
              <div className="block-head">
                <h2>
                  {g.title} <span className="count-badge">{items.length}</span>
                </h2>
                <p className="muted-note">{g.note}</p>
              </div>
              <div className="opp-list">
                <OpportunityHead />
                {items.map((o) => (
                  <OpportunityRow key={o.id} o={o} />
                ))}
              </div>
            </section>
          );
        })
      )}

      {data && (
        <details className="more" style={{ marginTop: 24 }}>
          <summary>How the ranking works, and what is left out</summary>
          <div className="card" style={{ marginTop: 10 }}>
            <p style={{ marginTop: 0 }}>{data.method}</p>
            <p className="note">
              <b>Pass the filters</b> means at least 1% yield a year, at least $50k liquidity,
              prices confirmed by two sources, a risk score under 50, and no simulated loss after
              costs. It is a shortlist to study, not advice and not an instruction: in shadow mode
              nothing is ever executed.
            </p>
            <p className="note">Not listed:</p>
            <ul className="note">
              {excluded.map(([why, n]) => (
                <li key={why}>
                  {why}: {int(n)}
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
      <ProvenanceNote />
    </>
  );
}
