import { Dumbbell } from '../../components/Dumbbell';
import { LineChart } from '../../components/LineChart';
import { Pair, Token } from '../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { pct, usdCompact } from '../../lib/format';

export const dynamic = 'force-dynamic';

interface PoolM {
  pool: number;
  other: string;
  feeBps: number;
  tvlUsdEnd: number | null;
  nominalApr24hEnd: number | null;
  nominalApr24hMin: number | null;
  nominalApr24hMax: number | null;
  feeAprRealized: number;
  ilWindow: number;
  lpVsHodlApr: number;
  lpVsHodlApr30: number | null;
  netApr500: number | null;
  netApr5000: number | null;
}
interface BurrowM {
  token: string;
  supplyAprEnd: number;
  supplyAprMin: number;
  supplyAprMax: number;
  supplyAprRealized: number;
  utilizationEnd: number;
}
interface Thesis {
  available: boolean;
  manifest: {
    end: string;
    days: number;
    blocks: number;
    first: { height: number; timestamp: string };
    last: { height: number; timestamp: string };
    universe: { rule: string; candidates: number };
  };
  rules: { closeEnoughPp: number; strongRho: number; burrowCloseEnoughPp: number };
  verdict: { counts: number; text: string; h1: boolean; h2: boolean; h3: boolean };
  evidence: {
    pools: number;
    withNominal: number;
    nominalAboveKept: number;
    within2pp: number;
    rho: number | null;
    negativeHodl: number;
    negative500: number;
    idle: number[];
    burrowMarkets: number;
    burrowWithin: number;
    priceCheck: { days: number; medianBps: number | null; maxBps: number | null };
  };
  pools: PoolM[];
  burrow: BurrowM[];
  daily: { pool: number; date: string; nominalApr24h: number | null }[];
}

const WNEAR = 'wrap.near';

export default async function ThesisPage() {
  const { data, error } = await tryApi<Thesis>('/v1/analytics/thesis');
  if (!data) return <ApiError what="Thesis" error={error} />;
  if (!data.available)
    return <div className="callout">No thesis data in this build (thesis/data/raw is missing).</div>;
  const e = data.evidence;
  const pools = [...data.pools].sort((a, b) => (b.tvlUsdEnd ?? 0) - (a.tvlUsdEnd ?? 0));
  const top3 = pools.slice(0, 3);
  const markets = [...data.burrow]
    .filter((b) => b.supplyAprEnd > 0 || b.supplyAprRealized > 0)
    .sort((a, b) => Math.abs(b.supplyAprEnd - b.supplyAprRealized) - Math.abs(a.supplyAprEnd - a.supplyAprRealized));
  const count = (h: boolean, label: string, sub: string) => (
    <Tile label={label} value={<Status code={h ? 'OK' : 'FAILED'} label={h ? 'holds' : 'falsified'} />} sub={sub} />
  );
  return (
    <>
      <PageHeader
        title="Investment thesis"
        lead="TVL and the displayed APR do not tell you the yield an LP or a lender keeps. Tested on 90 days of NEAR mainnet data read at one block per day, with the rules that would falsify it fixed in advance."
        meta={
          <>
            Blocks {data.manifest.first.height} → {data.manifest.last.height}
            <br />
            {data.manifest.first.timestamp.slice(0, 10)} → {data.manifest.last.timestamp.slice(0, 10)}
          </>
        }
      />
      <div className="kpis">
        <Tile hero label="Verdict" value={`${data.verdict.counts} / 3`} sub={data.verdict.text} />
        {count(data.verdict.h1, 'H1 · shown ≠ kept (Rhea)', `${e.nominalAboveKept} of ${e.withNominal} pools: nominal above what an LP kept; ${e.within2pp} within ${(data.rules.closeEnoughPp * 100).toFixed(0)} pp`)}
        {count(data.verdict.h2, 'H2 · TVL does not rank outcome', `Spearman ρ = ${e.rho === null ? 'n/a' : e.rho.toFixed(2)} (falsified at ≥ ${data.rules.strongRho})`)}
        {count(data.verdict.h3, 'H3 · shown ≠ accrued (Burrow)', `${e.burrowMarkets - e.burrowWithin} of ${e.burrowMarkets} markets off by > ${(data.rules.burrowCloseEnoughPp * 100).toFixed(1)} pp; the weakest count`)}
      </div>

      <Section
        title="What the pool list shows vs what an LP kept"
        note={`Top ${e.pools} wNEAR pools by reserve (${data.manifest.universe.candidates} candidates, chosen on chain). Annualised, valued in NEAR at each pool's own price. ${e.negativeHodl} of ${e.pools} pools left LPs behind simply holding the tokens.`}
      >
        <div className="card">
          <Dumbbell
            clamp={[-1, 1.5]}
            series={['Nominal APR (last 24h fees)', `LP vs HODL (${data.manifest.days}d: fees − IL)`, `Fee APR realized (${data.manifest.days}d)`]}
            rows={pools.map((p) => ({
              key: String(p.pool),
              label: (
                <>
                  <b>#{p.pool}</b> <Pair tokens={[p.other, WNEAR]} />
                </>
              ),
              values: [p.nominalApr24hEnd, p.lpVsHodlApr, p.feeAprRealized],
            }))}
          />
        </div>
      </Section>

      <Section
        title="The displayed number moves"
        note="Daily nominal APR (that day's fees / TVL × 365) of the three largest pools. The same pool shows a different 'APR' every day."
      >
        <div className="card">
          <LineChart
            unit="pct"
            zeroBased
            series={top3.map((p, i) => ({
              name: `#${p.pool}`,
              slot: (i + 1) as 1 | 2 | 3,
              points: data.daily
                .filter((d) => d.pool === p.pool)
                .map((d) => ({ t: Date.parse(`${d.date}T00:00:00Z`), v: d.nominalApr24h })),
            }))}
          />
        </div>
      </Section>

      <Section title="Burrow: supply APR shown vs accrued" note="Realized = growth of the supply share price over the window, annualised. Incentives excluded from both. Largest gap first.">
        <div className="card">
          <Dumbbell
            series={['Supply APR shown (end block)', `Realized (${data.manifest.days}d)`]}
            rows={markets.map((b) => ({ key: b.token, label: <Token id={b.token} />, values: [b.supplyAprEnd, b.supplyAprRealized] }))}
          />
        </div>
      </Section>

      <Section title="Pools" note="All figures annualised (simple). Net APR includes a round trip of two half-swaps through the pool and a gas upper bound.">
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Pool</th>
                <th className="num">TVL</th>
                <th className="num">Nominal 24h</th>
                <th className="num">Daily range</th>
                <th className="num">Fee APR realized</th>
                <th className="num">IL</th>
                <th className="num">LP vs HODL</th>
                <th className="num">30d</th>
                <th className="num">Net $500</th>
                <th className="num">Net $5,000</th>
              </tr>
            </thead>
            <tbody>
              {pools.map((p) => (
                <tr key={p.pool}>
                  <td>
                    <b>#{p.pool}</b> <Pair tokens={[p.other, WNEAR]} />
                    {e.idle.includes(p.pool) && (
                      <span className="chip" style={{ marginLeft: 6 }} data-tip="median daily nominal APR below 0.5%: reserves, almost no trading">
                        idle
                      </span>
                    )}
                  </td>
                  <td className="num">{usdCompact(p.tvlUsdEnd)}</td>
                  <td className="num">{pct(p.nominalApr24hEnd, 1)}</td>
                  <td className="num dim">
                    {pct(p.nominalApr24hMin, 1)} – {pct(p.nominalApr24hMax, 1)}
                  </td>
                  <td className="num">{pct(p.feeAprRealized, 1)}</td>
                  <td className="num">{pct(p.ilWindow, 1)}</td>
                  <td className={`num ${p.lpVsHodlApr < 0 ? 'neg' : 'pos'}`}>
                    <b>{pct(p.lpVsHodlApr, 1)}</b>
                  </td>
                  <td className="num">{pct(p.lpVsHodlApr30, 1)}</td>
                  <td className="num">{pct(p.netApr500, 1)}</td>
                  <td className="num">{pct(p.netApr5000, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Section>

      <Section title="Check it yourself">
        <div className="card" style={{ display: 'grid', gap: 8 }}>
          <div>
            <code>pnpm thesis:rebuild</code> rebuilds the CSV, charts and THESIS.md offline from <code>thesis/data/raw</code>;
            a clean clone gives byte-identical files (a test enforces it).
          </div>
          <div>
            Every raw point names its mainnet block; pool #4512 priced NEAR within a median {e.priceCheck.medianBps?.toFixed(0) ?? '—'} bps (max{' '}
            {e.priceCheck.maxBps?.toFixed(0) ?? '—'} bps) of the external two-source NEAR/USD on {e.priceCheck.days} days.
          </div>
          <div className="dim">
            Counterarguments, falsification rules and limitations: THESIS.md in the repository root.
          </div>
        </div>
      </Section>
    </>
  );
}
