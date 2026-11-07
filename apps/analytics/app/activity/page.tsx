import { PortfolioSwitch, portfolioOf } from '../../components/PortfolioSwitch';
import { ErrorState } from '../../components/states';
import { agentActivity, type AgentEntry } from '../../lib/product';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });

function when(e: AgentEntry) {
  return e.count === 1 ? `${fmt(e.to)} UTC` : `${fmt(e.from)} – ${fmt(e.to)} UTC`;
}

function tone(e: AgentEntry) {
  if (e.policy.some((p) => p.verdict === 'BLOCK')) return 'warning';
  if (e.policy.some((p) => p.verdict === 'ALLOW')) return 'good';
  if (e.headline.startsWith('Skipped')) return 'warning';
  return 'neutral';
}

/** Every decision of the autopilot for one portfolio, in plain words, newest first. */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const id = portfolioOf((await searchParams).p);
  const { data, error } = await agentActivity(id);
  return (
    <>
      <div className="page-title">
        <h1>Activity</h1>
        <p>
          Every time the autopilot looked at the portfolio: what it saw, what it wanted to do, and
          why it did or did not. Identical checks in a row are grouped.
        </p>
      </div>
      <div className="hero-head">
        <PortfolioSwitch current={id} path="/activity" />
        <span className="muted-note">
          Shadow mode: proposals are checked and simulated, never sent.
        </span>
      </div>
      {!data ? (
        <ErrorState what="The activity" error={error} />
      ) : data.entries.length === 0 ? (
        <p className="muted-note">The autopilot has not analysed this portfolio yet.</p>
      ) : (
        <ol className="timeline">
          {data.entries.map((e) => (
            <li key={`${e.from}-${e.to}`} className={`tl ${tone(e)}`}>
              <span className="tl-dot" aria-hidden="true" />
              <div className="tl-body">
                <div className="tl-head">
                  <b>{e.headline}</b>
                  <span className="muted-note">
                    {when(e)}
                    {e.count > 1 && ` · ${e.count} checks`}
                  </span>
                </div>
                {e.notes.length > 0 && (
                  <ul>
                    {e.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
                {e.policy.map((p, i) => (
                  <p
                    key={`${p.verdict}-${i}`}
                    className={`verdict ${p.verdict === 'ALLOW' ? 'good' : 'warning'}`}
                  >
                    <i aria-hidden="true">{p.verdict === 'ALLOW' ? '✓' : '×'}</i>
                    {p.sentence}
                  </p>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
