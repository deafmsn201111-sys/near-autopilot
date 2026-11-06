import Link from 'next/link';
import { Env } from '../../components/Env';
import { LineChart, type Series } from '../../components/LineChart';
import { Pair } from '../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { ts, usd2 } from '../../lib/format';

export const dynamic = 'force-dynamic';

interface Scored {
  quote: {
    venue: string;
    ok: boolean;
    amountOut?: string;
    feeBps?: number | null;
    settlement?: string;
    reason?: string;
  };
  outUsdMicro: string | null;
  gasUsdMicro: string | null;
  netUsdMicro: string | null;
  oracleDeviationBps: number | null;
  excluded: string | null;
}
interface Route {
  id: string;
  createdAt: string;
  origin: 'gateway' | 'probe';
  outcome: string;
  tokenIn: string | null;
  tokenOut: string | null;
  amountIn: string | null;
  chosenVenue: string | null;
  advantageBps: number | null;
  reason: string;
  quotes: { gasPriceYocto?: string | null; scored?: Scored[] };
  environment: string;
}

const VENUE: Record<string, string> = {
  rhea: 'Rhea',
  'near-intents-1click': 'NEAR Intents (1Click)',
};
const micro = (v: string | null | undefined) =>
  v === null || v === undefined ? null : Number(v) / 1e6;
const net = (r: Route, venue: string) =>
  micro(r.quotes.scored?.find((s) => s.quote.venue === venue)?.netUsdMicro);
/** Reference size of a probe in USD, from the output value (the probe sizes are $10 and $100). */
const size = (r: Route) => {
  const out = Math.max(...(r.quotes.scored ?? []).map((s) => micro(s.outUsdMicro) ?? 0));
  return out >= 50 ? 100 : out >= 5 ? 10 : Math.round(out);
};

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export default async function RoutesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const origin = one((await searchParams).origin);
  const { data, error } = await tryApi<{ routes: Route[] }>('/v1/analytics/routes?limit=500');
  if (!data) return <ApiError what="Routes" error={error} />;
  const all = data.routes;
  const probes = all.filter((r) => r.origin === 'probe' && r.outcome === 'routed');
  const wins = (v: string) => probes.filter((r) => r.chosenVenue === v).length;
  const oneClickFailed = all.filter((r) =>
    r.quotes.scored?.some((s) => s.quote.venue === 'near-intents-1click' && !s.quote.ok),
  ).length;
  const sizes = [...new Set(probes.map(size))].sort((a, b) => a - b).slice(0, 3);
  const series: Series[] = sizes.map((sz, i) => ({
    name: `≈$${sz}`,
    slot: (i + 1) as 1 | 2 | 3,
    points: probes
      .filter((r) => size(r) === sz)
      .map((r) => {
        const a = net(r, 'near-intents-1click');
        const b = net(r, 'rhea');
        return {
          t: Date.parse(r.createdAt),
          v: a !== null && b !== null && b > 0 ? (a - b) / b : null,
        };
      })
      .sort((x, y) => x.t - y.t),
  }));
  const latest = (sz: number) => probes.find((r) => size(r) === sz);
  const rows = all.filter((r) => !origin || r.origin === origin);
  return (
    <>
      <PageHeader
        title="Execution routes"
        lead="The Shadow Gateway quotes every approved swap on Rhea (the plan's own pool, get_return view) and on NEAR Intents (1Click dry quote, no deposit address) and records the best execution: net USD after each venue's fee and an upper bound on gas. Quotes only: nothing here was signed or sent."
        meta={`${all.length} records`}
      />
      <div className="kpis">
        <Tile
          label="Reference probes routed"
          value={probes.length}
          sub="$10 and $100 wNEAR → USDC, every collector cycle"
        />
        <Tile label="Rhea chosen" value={wins('rhea')} sub="atomic, one transaction" />
        <Tile
          label="NEAR Intents chosen"
          value={wins('near-intents-1click')}
          sub="deposit, then a solver settles"
        />
        <Tile label="1Click quote failed" value={oneClickFailed} sub="excluded, never patched" />
        {sizes.map((sz) => {
          const r = latest(sz);
          return (
            <Tile
              key={sz}
              label={`Latest ≈$${sz}`}
              value={r?.chosenVenue ? (r.chosenVenue === 'rhea' ? 'Rhea' : 'Intents') : '—'}
              sub={
                r
                  ? `by ${r.advantageBps ?? 0} bps · ${ts(r.createdAt).slice(11, 16)} UTC`
                  : undefined
              }
            />
          );
        })}
      </div>

      {series.length > 0 && (
        <Section
          title="NEAR Intents vs Rhea, net of fees and gas"
          note="(1Click net − Rhea net) / Rhea net, per probe. Above zero: Intents paid more after its app fee and gas; below: Rhea. Gas is an upper bound for both (attached gas × gas price), which weighs on Rhea's 180 Tgas swap at small sizes."
        >
          <div className="card">
            <LineChart unit="pct" series={series} />
          </div>
        </Section>
      )}

      <Section
        title="Routing records"
        aside={
          <div className="counts" style={{ margin: 0 }}>
            {['', 'probe', 'gateway'].map((o) => (
              <Link
                key={o}
                href={o ? `/routes?origin=${o}` : '/routes'}
                aria-current={origin === o ? 'true' : undefined}
              >
                <span className="chip">{o || 'All'}</span>
              </Link>
            ))}
          </div>
        }
      >
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Source</th>
                <th>Origin</th>
                <th>Trade</th>
                <th className="num">Rhea net</th>
                <th className="num">Intents net</th>
                <th>Chosen</th>
                <th className="num">Advantage</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r) => {
                const tip = (venue: string) => {
                  const s = r.quotes.scored?.find((x) => x.quote.venue === venue);
                  if (!s) return 'not quoted';
                  if (!s.quote.ok || s.excluded)
                    return `excluded: ${s.excluded ?? s.quote.reason ?? ''}`;
                  return [
                    `out ${usd2(micro(s.outUsdMicro))}, gas ${usd2(micro(s.gasUsdMicro))}`,
                    s.quote.feeBps !== null && s.quote.feeBps !== undefined
                      ? `venue fee ${s.quote.feeBps} bps (included)`
                      : 'pool fee included',
                    `oracle deviation ${s.oracleDeviationBps ?? '—'} bps`,
                    `settlement ${s.quote.settlement ?? '—'}`,
                  ].join('\n');
                };
                const cell = (venue: string) => {
                  const s = r.quotes.scored?.find((x) => x.quote.venue === venue);
                  const v = net(r, venue);
                  return (
                    <td className="num" data-tip={tip(venue)} tabIndex={0}>
                      {s && (!s.quote.ok || s.excluded) ? (
                        <span className="dim">excluded</span>
                      ) : v === null ? (
                        '—'
                      ) : (
                        usd2(v)
                      )}
                    </td>
                  );
                };
                return (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{ts(r.createdAt)}</td>
                    <td>
                      <Env env={r.environment} />
                    </td>
                    <td className="dim">{r.origin}</td>
                    <td>
                      {r.tokenIn && r.tokenOut ? (
                        <>
                          {r.origin === 'probe' && <span className="dim">≈${size(r)} </span>}
                          <Pair tokens={[r.tokenIn, r.tokenOut]} />
                        </>
                      ) : (
                        <span className="dim" data-tip={r.reason}>
                          {r.outcome.replace(/_/g, ' ')}
                        </span>
                      )}
                    </td>
                    {cell('rhea')}
                    {cell('near-intents-1click')}
                    <td data-tip={r.reason}>
                      {r.chosenVenue ? (
                        <Status code="OK" label={VENUE[r.chosenVenue] ?? r.chosenVenue} />
                      ) : (
                        <Status
                          code={r.outcome === 'refused' ? 'REFUSED' : 'NONE'}
                          label={r.outcome.replace(/_/g, ' ')}
                        />
                      )}
                    </td>
                    <td className="num">
                      {r.advantageBps === null ? '—' : `${r.advantageBps} bps`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      </Section>
    </>
  );
}
