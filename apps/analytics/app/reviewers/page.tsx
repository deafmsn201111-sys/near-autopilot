import Link from 'next/link';
import { tryApi } from '../../lib/api';
import { system } from '../../lib/product';

export const dynamic = 'force-dynamic';

const PAGES = [
  [
    '/policy',
    'Safety policy',
    'Every proposal and its 12 checks: value limits, price freshness and agreement, slippage, recipients. The attack demo.',
  ],
  [
    '/audit',
    'Audit trail',
    'The hash-chained record of every decision and setting change, verified on load, with the external checkpoints.',
  ],
  [
    '/routes',
    'Execution routes',
    'Rhea vs NEAR Intents (1Click) quotes for allowed plans; nothing is executed.',
  ],
  [
    '/autopilot',
    'Controls',
    'Pause the analysis or put a portfolio into read-only mode; every change is audited.',
  ],
  [
    '/system',
    'System health',
    'API, database, collector and each data source, with reasons when one fails.',
  ],
  ['/rhea', 'Rhea pools', 'The full registry of 15,000+ pools, categories and fee windows.'],
  ['/burrow', 'Burrow markets', 'All markets: supply and borrow rates, utilisation, liquidity.'],
  ['/prices', 'Prices', 'Every price source per asset, quorum and disagreement over time.'],
  [
    '/portfolios',
    'Portfolio risk',
    'Stress tests and health factor history of the demo portfolios.',
  ],
  ['/strategies', 'Strategies', 'All strategies compared with their full cost breakdown.'],
  ['/lp', 'LP simulation', 'Every simulated liquidity position.'],
  [
    '/thesis',
    'Thesis data',
    'The research method, every pool, the falsification rules and raw data.',
  ],
  ['/collector', 'Collector', 'The log of every data collection cycle.'],
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
          reproduced. Mainnet is only read; there is no signer; every number on the product pages
          can be traced here.
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
          <span className="eyebrow">Mainnet signer</span>
          <b>None: read-only</b>
        </div>
      </div>
      <div className="link-grid">
        {PAGES.map(([href, title, text]) => (
          <Link key={href} href={href} className="link-card">
            <b>{title} →</b>
            <span>{text}</span>
          </Link>
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
