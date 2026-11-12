import Link from 'next/link';
import { tryApi } from '../../lib/api';
import { system } from '../../lib/product';

export const dynamic = 'force-dynamic';

const GROUPS = [
  {
    title: 'Trust and verification',
    description:
      'Check the rules, the audit record and the health of the data behind each decision.',
    pages: [
      ['/policy', 'Safety policy', 'The checks applied before a proposal can proceed.'],
      ['/audit', 'Audit trail', 'The verifiable record of decisions and settings.'],
      ['/system', 'System health', 'API, database, collector and source status.'],
      ['/collector', 'Collector', 'Every data collection cycle.'],
    ],
  },
  {
    title: 'Market data',
    description: 'Trace prices, rates and liquidity to the underlying markets.',
    pages: [
      ['/rhea', 'Rhea pools', 'Pool registry, categories and fee windows.'],
      ['/burrow', 'Burrow markets', 'Supply and borrow rates, utilisation and liquidity.'],
      ['/prices', 'Prices', 'Sources, quorum and disagreement over time.'],
      ['/routes', 'Execution routes', 'Quote comparison for allowed plans.'],
    ],
  },
  {
    title: 'Research and models',
    description: 'Inspect the assumptions and outcomes behind the analysis.',
    pages: [
      ['/portfolios', 'Portfolio risk', 'Stress tests and health factor history.'],
      ['/strategies', 'Strategies', 'Net results after costs for each strategy.'],
      ['/lp', 'LP simulation', 'Simulated liquidity positions.'],
      ['/thesis', 'Thesis data', 'Method, falsification rules and raw data.'],
    ],
  },
] as const;

/** The entry point for judges and auditors: what to check, and where. */
export default async function ReviewersPage() {
  const [sys, audit] = await Promise.all([
    system(),
    tryApi<{ chains: { chain: string; entries: number; verification: { ok: boolean } }[] }>(
      '/v1/analytics/audit?limit=1',
    ),
  ]);
  const chains = audit.data?.chains ?? [];
  return (
    <>
      <div className="page-title">
        <h1>For reviewers</h1>
        <p>
          The technical evidence behind the product: how decisions are checked, recorded and
          reproduced. The server reads mainnet and never signs. Only you can sign a prepared
          transaction in your wallet.
        </p>
      </div>
      <div className="facts-row">
        <div>
          <span className="eyebrow">Audit chains</span>
          <b>
            {chains.length > 0 && chains.every((c) => c.verification.ok)
              ? `${chains.length} intact`
              : chains.length
                ? 'Broken!'
                : '—'}
          </b>
        </div>
        <div>
          <span className="eyebrow">Data</span>
          <b>{sys.data ? (sys.data.collector.stale ? 'Out of date' : 'Up to date') : '—'}</b>
        </div>
        <div>
          <span className="eyebrow">Database</span>
          <b>{sys.data?.database.ok ? `${sys.data.database.migrations} migrations` : '—'}</b>
        </div>
        <div>
          <span className="eyebrow">Server signer</span>
          <b>None</b>
        </div>
      </div>
      <div className="reviewer-directory">
        {GROUPS.map((group) => (
          <section key={group.title} className="reviewer-directory-group">
            <div className="reviewer-directory-intro">
              <h2>{group.title}</h2>
              <p>{group.description}</p>
            </div>
            <div className="reviewer-directory-links">
              {group.pages.map(([href, title, description]) => (
                <Link key={href} href={href}>
                  <b>{title}</b>
                  <span>{description}</span>
                  <span className="reviewer-directory-arrow" aria-hidden="true">
                    ↗
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className="muted-note" style={{ marginTop: 24 }}>
        Reproduce without the UI:{' '}
        <code>docker compose exec api node --import tsx src/evidence/cli.ts verify</code> and{' '}
        <code>… replay</code>. Source and documents: README.md, docs/, THESIS.md.
      </p>
    </>
  );
}
