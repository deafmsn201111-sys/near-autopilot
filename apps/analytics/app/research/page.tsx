import Link from 'next/link';
import { ErrorState } from '../../components/states';
import { tryApi } from '../../lib/api';

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

export const dynamic = 'force-dynamic';

interface Thesis {
  available: boolean;
  manifest?: { days: number; universe: { pools: number[]; candidates: number; rule: string } };
  verdict?: { text: string; h1: boolean; h2: boolean; h3: boolean };
  evidence?: {
    pools: number;
    nominalAboveKept: number;
    negativeHodl: number;
    negative500: number;
    rho: number;
    idle: number[];
    burrowMarkets: number;
    burrowWithin: number;
  };
  survivorship?: { included: number; text: string } | null;
  cohorts?: {
    key: string;
    label: string;
    pools: number[];
    medianFeeApr: number | null;
    medianLpVsHodlApr: number | null;
    medianNetApr5000: number | null;
    negativeNet5000: number;
  }[];
}

/** The research behind the autopilot, in three findings a person can read in a minute. */
export default async function ResearchPage() {
  const { data, error } = await tryApi<Thesis>('/v1/analytics/thesis');
  if (!data) return <ErrorState what="The research" error={error} />;
  if (!data.available || !data.evidence || !data.manifest)
    return <p className="muted-note">The research data is not part of this build.</p>;
  const e = data.evidence;
  const days = data.manifest.days;
  return (
    <>
      <div className="page-title">
        <h1>Why the autopilot does not chase APR</h1>
        <p>
          We followed {e.pools} of the largest NEAR pools on Rhea and {e.burrowMarkets} Burrow
          lending markets for {days} days, block by block, and compared the yield a pool list
          advertises with what people actually kept.
        </p>
      </div>

      <div className="findings">
        <article className="finding">
          <span className="finding-num">
            {e.nominalAboveKept} of {e.pools}
          </span>
          <h3>The advertised APR was higher than what liquidity providers kept</h3>
          <p>
            Pool lists show yesterday&apos;s fees, annualised. What a provider keeps is fees minus
            the loss from prices moving apart (impermanent loss) and the cost of getting in and out.
          </p>
        </article>
        <article className="finding">
          <span className="finding-num">
            {e.negativeHodl} of {e.pools}
          </span>
          <h3>Pools left providers worse off than simply holding the two tokens</h3>
          <p>
            Fees did not cover impermanent loss. With a $500 position, {e.negative500} of {e.pools}{' '}
            were negative after costs. That is why the autopilot ranks by the result after costs,
            not by APR.
          </p>
        </article>
        <article className="finding">
          <span className="finding-num">
            {e.idle.length} of {e.pools}
          </span>
          <h3>Of the biggest pools hardly traded at all</h3>
          <p>
            A big pool is not a better pool: size barely predicts what providers kept (rank
            correlation {e.rho.toFixed(2)}, where 1 would be a perfect match). Much of that capital
            is parked, not earning.
          </p>
        </article>
        <article className="finding">
          <span className="finding-num">
            {e.burrowWithin} of {e.burrowMarkets}
          </span>
          <h3>Burrow&apos;s displayed rate mostly matches what lenders earned</h3>
          <p>
            Our weakest point, stated plainly: lending rates are far more honest than pool APRs. In
            the other {e.burrowMarkets - e.burrowWithin} markets the rate moved enough that the
            number shown today was not what accrued.
          </p>
        </article>
      </div>

      {data.cohorts && data.cohorts.length > 0 && (
        <section className="block">
          <h2>Where the money went, by pool type</h2>
          <p className="muted-note">
            Medians, per year. &ldquo;Earned in fees&rdquo; is what a pool list shows; &ldquo;after
            price moves&rdquo; subtracts impermanent loss; &ldquo;after costs&rdquo; also subtracts
            getting in and out with $5,000.
          </p>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>Pools</th>
                  <th className="num">Earned in fees</th>
                  <th className="num">After price moves</th>
                  <th className="num">After costs</th>
                  <th className="num">Lost money</th>
                </tr>
              </thead>
              <tbody>
                {data.cohorts.map((c) => (
                  <tr key={c.key}>
                    <td>
                      {c.label.charAt(0).toUpperCase() + c.label.slice(1)}{' '}
                      <span className="muted-note">({c.pools.length})</span>
                    </td>
                    <td className="num">{pct(c.medianFeeApr)}</td>
                    <td className={`num ${(c.medianLpVsHodlApr ?? 0) < 0 ? 'neg' : ''}`}>
                      {pct(c.medianLpVsHodlApr)}
                    </td>
                    <td className={`num ${(c.medianNetApr5000 ?? 0) < 0 ? 'neg' : ''}`}>
                      {pct(c.medianNetApr5000)}
                    </td>
                    <td className="num">
                      {c.negativeNet5000} of {c.pools.length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="block">
        <h2>What this means for you</h2>
        <ul className="plain-list">
          <li>
            Judge an opportunity by what is left after costs and impermanent loss, never by the
            advertised APR.
          </li>
          <li>Position size matters: fixed costs eat small positions.</li>
          <li>
            The highest fees came with the biggest losses: NEAR/stablecoin pools earned the most in
            fees and lost the most once NEAR&apos;s price moved.
          </li>
          <li>
            Lending is simpler to read than liquidity provision; it still has rate and
            smart-contract risk.
          </li>
        </ul>
      </section>

      <section className="block">
        <h2>How it was tested</h2>
        <p className="muted-note">
          Each claim had a rule, fixed in advance, that would prove it wrong. Every number is
          recomputed from raw mainnet data committed with the code (one block per day). Verdict:{' '}
          {data.verdict?.text}.{data.survivorship ? ` ${data.survivorship.text}` : ''}
        </p>
        <Link className="link" href="/thesis">
          Full method, every pool and the raw data →
        </Link>
      </section>
    </>
  );
}
