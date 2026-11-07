import Link from 'next/link';
import { EmptyState, PageHeader } from '../../components/ui';
import { ErrorState } from '../../components/states';
import { ts } from '../../lib/format';
import { activity } from '../../lib/product';

export const dynamic = 'force-dynamic';

const KINDS: Record<string, string> = {
  snapshot: 'Market data',
  analysis: 'Analysis',
  decision: 'Proposal',
  verdict: 'Policy decision',
  execution: 'Dry run',
  alert: 'Alert',
  control: 'Settings',
};

/** What happened, in plain words. Each line keeps its source reference for checking against the audit trail. */
export default async function ActivityPage() {
  const { data, error } = await activity(120);
  return (
    <>
      <PageHeader
        title="Activity"
        lead="A readable log of what the system did: new market data, analyses, policy decisions, dry runs, alerts and setting changes. The full, tamper-evident record is on the Audit trail tab."
      />
      {!data ? (
        <ErrorState what="Activity" error={error} />
      ) : data.items.length === 0 ? (
        <EmptyState title="Nothing has happened yet.">
          The first collector cycle appears here within its interval.
        </EmptyState>
      ) : (
        <div className="card feed">
          {data.items.map((i) => (
            <div className="feed-item" key={`${i.ref}-${i.at}`}>
              <time dateTime={i.at}>{ts(i.at).slice(5, 16)}</time>
              <span className={`dot ${i.tone}`} aria-hidden="true" />
              <div>
                <div className="t">
                  {i.title} <span className="chip">{KINDS[i.kind] ?? i.kind}</span>
                  {i.environment && (
                    <span className="chip" style={{ marginLeft: 4 }}>
                      {i.environment}
                    </span>
                  )}
                </div>
                {i.result && <div className="r">{i.result}</div>}
                {i.explanation && <div className="e">{i.explanation}</div>}
                <div className="e" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                  {i.ref}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="note">
        Looking for a specific decision? <Link href="/policy">Policy decisions</Link> lists every
        check of every verdict; <Link href="/audit">Audit trail</Link> verifies the hash chain.
      </p>
    </>
  );
}
