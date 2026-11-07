import Link from 'next/link';
import { Facts, PageHeader, Section, Status, TableWrap } from '../../components/ui';
import { ErrorState } from '../../components/states';
import { tryApi } from '../../lib/api';
import { ts } from '../../lib/format';
import { ago, system } from '../../lib/product';

export const dynamic = 'force-dynamic';

/** Diagnostics: is every part up, how old is the data, which source fails and why. */
export default async function SystemPage() {
  const [{ data, error }, audit] = await Promise.all([
    system(),
    tryApi<{ chains: { chain: string; entries: number; verification: { ok: boolean } }[] }>(
      '/v1/analytics/audit?limit=1',
    ),
  ]);
  if (!data)
    return (
      <ErrorState
        what="System health"
        error={error}
        hint="The analytics API did not answer: the dashboard can show nothing until it does. Check that the analytics-api container is running."
      />
    );
  const c = data.collector;
  return (
    <>
      <PageHeader
        title="System Health"
        lead="The technical state of each part, for diagnosis. Every check here is a read."
        meta={`Checked ${ts(data.now)}`}
      />
      <div className="strip">
        <div>
          <span className="k">Analytics API</span>
          <span className="v">
            <Status code="OK" label="Answering" />
          </span>
          <span className="s">this page was served by it</span>
        </div>
        <div>
          <span className="k">PostgreSQL</span>
          <span className="v">
            <Status
              code={data.database.ok ? 'OK' : 'failed'}
              label={data.database.ok ? 'Connected' : 'Unreachable'}
            />
          </span>
          <span className="s">
            {data.database.ok
              ? `${data.database.latencyMs} ms · ${data.database.migrations} migrations applied`
              : data.database.error}
          </span>
        </div>
        <div>
          <span className="k">Collector</span>
          <span className="v">
            <Status code={c.lastStatus ?? 'unknown'} />
          </span>
          <span className="s">last run started {ago(c.lastStartedAt, data.now)}</span>
        </div>
        <div>
          <span className="k">Data freshness</span>
          <span className="v">
            <Status code={c.stale ? 'STALE' : 'OK'} label={c.stale ? 'Out of date' : 'Fresh'} />
          </span>
          <span className="s">
            {c.dataAgeSeconds === null
              ? 'no data yet'
              : `${Math.round(c.dataAgeSeconds / 60)} min old`}{' '}
            · limit {Math.round((c.intervalSeconds * 2 + 300) / 60)} min
          </span>
        </div>
      </div>

      <Section
        title="Data sources, last successful cycle"
        note="A failing source is reported with its reason; the price service decides per asset whether the remaining sources are enough."
      >
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>State</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {c.sources.map((s) => (
                <tr key={s.source}>
                  <td>
                    <code>{s.source}</code>
                  </td>
                  <td>
                    <Status code={s.health} />
                  </td>
                  <td className="wrap dim">{s.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Section>

      <div className="grid-2">
        <Section
          title="Collector, last 50 runs"
          aside={
            <Link href="/collector" className="dim">
              Run log →
            </Link>
          }
        >
          <div className="card">
            <Facts
              items={[
                ['Successful', c.last50.success],
                ['Partial (a source failed)', c.last50.partial],
                ['Failed', c.last50.failed],
                ['Interval', `${Math.round(c.intervalSeconds / 60)} min`],
              ]}
            />
          </div>
        </Section>
        <Section
          title="Audit chains"
          aside={
            <Link href="/audit" className="dim">
              Audit trail →
            </Link>
          }
        >
          {audit.data ? (
            <div className="card">
              <Facts
                items={audit.data.chains.map((ch) => [
                  ch.chain,
                  <span key={ch.chain}>
                    <Status
                      code={ch.verification.ok ? 'OK' : 'BROKEN'}
                      label={ch.verification.ok ? 'Intact' : 'Broken'}
                    />{' '}
                    <span className="dim">{ch.entries} entries</span>
                  </span>,
                ])}
              />
            </div>
          ) : (
            <ErrorState what="Audit chains" error={audit.error} />
          )}
        </Section>
      </div>
    </>
  );
}
