import Link from 'next/link';
import { OpportunityHead, OpportunityRow } from '../components/OpportunityRow';
import { EmptyState, PageHeader, Section, Status, Tile } from '../components/ui';
import { ErrorState } from '../components/states';
import { tryApi } from '../lib/api';
import { int, usd2 } from '../lib/format';
import { activity, ago, control, opportunities, scopeName, system } from '../lib/product';
import type { Overview } from '../lib/types';

export const dynamic = 'force-dynamic';

/**
 * The start page: in a few seconds, the state of the system, what it found, what deserves attention, what to do
 * next. Raw identifiers, hashes and long tables live on the detail pages.
 */
export default async function OverviewPage() {
  const [sys, opp, ctl, feed, ov] = await Promise.all([
    system(),
    opportunities('limit=5&status=candidate'),
    control(),
    activity(6),
    tryApi<Overview>('/v1/analytics/overview'),
  ]);
  if (!sys.data) return <ErrorState what="The system status" error={sys.error} />;
  const s = sys.data;
  const modes = ctl.data?.modes ?? [];
  const readOnly = modes.filter((m) => m.mode !== 'normal');
  const paused = ctl.data?.collector.paused ?? false;
  const failingSources = s.collector.sources.filter((x) => x.health !== 'ok');
  const near = ov.data?.snapshot?.summary.prices?.find((p) => p.token === 'wrap.near');
  const warnings: { tone: 'warning' | 'critical'; text: string; href: string }[] = [
    ...(s.collector.stale
      ? [
          {
            tone: 'critical' as const,
            text: `Market data is out of date (last collected ${ago(s.collector.lastSuccessAt, s.now)}). Opportunities and prices may not reflect the market.`,
            href: '/system',
          },
        ]
      : []),
    ...(paused
      ? [
          {
            tone: 'warning' as const,
            text: `Scheduled analysis is paused: ${ctl.data?.collector.reason ?? ''}`,
            href: '/autopilot',
          },
        ]
      : []),
    ...readOnly.map((m) => ({
      tone: 'warning' as const,
      text: `${scopeName(m.scope).name} (${scopeName(m.scope).env}) is in ${m.mode.replace(/_/g, ' ')} mode: ${m.reason}`,
      href: '/autopilot',
    })),
    ...failingSources.map((x) => ({
      tone: 'warning' as const,
      text: `Data source "${x.source}" is ${x.health}${x.detail ? `: ${x.detail}` : ''}.`,
      href: '/system',
    })),
  ];
  const counts = opp.data?.counts;
  return (
    <>
      <PageHeader
        title="Overview"
        lead="NEAR Autopilot watches Rhea and Burrow on NEAR mainnet, ranks the opportunities it finds, and runs every proposal through an independent safety policy. Shadow mode: it analyses and simulates, it never trades."
      />

      <div className="strip" role="status" aria-label="System status">
        <div>
          <span className="k">Autopilot</span>
          <span className="v">
            {readOnly.length === 0 ? (
              <Status code="normal" label="Running in shadow mode" />
            ) : (
              <Status code="read_only" label={`${readOnly.length} scope(s) restricted`} />
            )}
          </span>
          <span className="s">Analyses and simulates; never sends a transaction</span>
        </div>
        <div>
          <span className="k">Market data</span>
          <span className="v">
            <Status
              code={s.collector.stale ? 'STALE' : 'OK'}
              label={s.collector.stale ? 'Out of date' : 'Up to date'}
            />
          </span>
          <span className="s">
            Collected {ago(s.collector.lastSuccessAt, s.now)} ·{' '}
            {paused
              ? 'scheduled runs paused'
              : `every ${Math.round(s.collector.intervalSeconds / 60)} min`}
          </span>
        </div>
        <div>
          <span className="k">Data sources</span>
          <span className="v">
            <Status
              code={failingSources.length ? 'degraded' : 'OK'}
              label={
                failingSources.length
                  ? `${failingSources.length} of ${s.collector.sources.length} with problems`
                  : `All ${s.collector.sources.length} working`
              }
            />
          </span>
          <span className="s">Prices, Rhea, Burrow, routes</span>
        </div>
        <div>
          <span className="k">NEAR price</span>
          <span className="v">{near ? usd2(near.usd) : '—'}</span>
          <span className="s">
            {near
              ? `${near.quality === 'OK' ? 'confirmed by several sources' : near.quality}`
              : 'no confirmed price'}
          </span>
        </div>
      </div>

      <div className="kpis" style={{ marginTop: 16 }}>
        <Tile
          label="Opportunities found"
          value={counts ? int(opp.data?.total) : '—'}
          sub="Rhea pools and Burrow markets with usable data"
          href="/opportunities"
        />
        <Tile
          label="Pass the filters"
          value={counts ? int(counts.candidate) : '—'}
          sub="meaningful yield, deep liquidity, confirmed prices"
          href="/opportunities?status=candidate"
        />
        <Tile
          label="Watch only"
          value={counts ? int(counts.watch) : '—'}
          sub="measured, but a risk or data limit applies"
          href="/opportunities?status=watch"
        />
        <Tile
          label="Needs attention"
          value={warnings.length}
          sub={warnings.length ? 'see the warnings below' : 'nothing right now'}
        />
      </div>

      {warnings.length > 0 && (
        <Section title="Needs your attention">
          <div className="opp-list">
            {warnings.map((w) => (
              <Link
                key={w.text}
                href={w.href}
                className={`state ${w.tone === 'critical' ? 'error-state' : ''}`}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <Status
                  code={w.tone === 'critical' ? 'critical' : 'warn'}
                  label={w.tone === 'critical' ? 'Important' : 'Warning'}
                />
                <span>{w.text}</span>
              </Link>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="Best opportunities right now"
        aside={
          <Link href="/opportunities" className="btn secondary">
            See all opportunities
          </Link>
        }
        note="Ranked by yield, risk and data confidence together, not by APR alone. Yields are measured history, not a promise."
      >
        {!opp.data ? (
          <ErrorState what="Opportunities" error={opp.error} />
        ) : opp.data.opportunities.length === 0 ? (
          <EmptyState title="No opportunity passes the filters right now.">
            {opp.data.counts.watch} are on the watch list: they have a yield, but thin liquidity,
            unconfirmed prices or a simulated loss after costs keep them out.
          </EmptyState>
        ) : (
          <div className="opp-list">
            <OpportunityHead />
            {opp.data.opportunities.map((o) => (
              <OpportunityRow key={o.id} o={o} />
            ))}
          </div>
        )}
      </Section>

      <div className="grid-2">
        <Section
          title="Market at a glance"
          aside={
            <Link href="/rhea" className="dim">
              Analytics →
            </Link>
          }
        >
          {ov.data ? (
            <div className="kpis">
              <Tile
                label="Rhea pools discovered"
                value={int(ov.data.rhea.discovered)}
                sub={`${int(ov.data.rhea.liquid)} with real liquidity`}
                href="/rhea"
              />
              <Tile
                label="Burrow markets"
                value={`${ov.data.burrow.supported} / ${ov.data.burrow.markets}`}
                sub="with valid, priced data"
                href="/burrow"
              />
            </div>
          ) : (
            <ErrorState what="Market summary" error={ov.error} />
          )}
        </Section>
        <Section
          title="Latest activity"
          aside={
            <Link href="/activity" className="dim">
              All activity →
            </Link>
          }
        >
          {feed.data && feed.data.items.length > 0 ? (
            <div className="card feed">
              {feed.data.items.map((i) => (
                <div className="feed-item" key={`${i.ref}-${i.at}`}>
                  <time dateTime={i.at}>{ago(i.at, s.now)}</time>
                  <span className={`dot ${i.tone}`} aria-hidden="true" />
                  <div>
                    <div className="t">{i.title}</div>
                    <div className="r">{i.result}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : feed.data ? (
            <EmptyState title="No activity recorded yet.">
              The first collector cycle will appear here.
            </EmptyState>
          ) : (
            <ErrorState what="Activity" error={feed.error} />
          )}
        </Section>
      </div>

      <Section title="What you can do">
        <div className="actions">
          <Link href="/opportunities" className="btn primary">
            Explore opportunities
          </Link>
          <Link href="/autopilot" className="btn secondary">
            Run a market analysis
          </Link>
          <Link href="/portfolios" className="btn secondary">
            See the simulated portfolios
          </Link>
          <Link href="/policy" className="btn secondary">
            Why the autopilot said no
          </Link>
        </div>
        <p className="note">
          Every action here is read-only or a recorded operator setting. Nothing on this site can
          move funds.
        </p>
      </Section>
    </>
  );
}
