import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { int, ts } from '../../lib/format';
import type { SourceRun } from '../../lib/types';

export const dynamic = 'force-dynamic';

interface Cycle {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  records: number;
  sources: SourceRun[];
  error: string | null;
  snapshotId: string | null;
  registryScan: boolean;
}

const secs = (ms: number | null | undefined) => (ms ? `${(ms / 1000).toFixed(1)} s` : '—');

export default async function CollectorPage() {
  const { data, error } = await tryApi<{ cycles: Cycle[] }>('/v1/analytics/collector?limit=100');
  if (!data) return <ApiError what="Collector" error={error} />;
  const last = data.cycles.find((c) => c.status !== 'running');
  const lastOkBySource = new Map<string, string>();
  for (const c of data.cycles)
    for (const s of c.sources)
      if (s.health === 'ok' && !lastOkBySource.has(s.source))
        lastOkBySource.set(s.source, c.startedAt);
  const by = (s: string) => data.cycles.filter((c) => c.status === s).length;
  return (
    <>
      <PageHeader
        title="Collector"
        lead="A plain Node service (no LLM): every 15 minutes it reads NEAR mainnet with view calls and public price APIs, never in parallel, and stores every cycle here, including partial and failed ones."
        meta={`Last ${data.cycles.length} cycles`}
      />
      <div className="kpis">
        <Tile
          label="Last cycle"
          value={last ? <Status code={last.status} /> : '—'}
          sub={last ? `${ts(last.startedAt)} · ${secs(last.durationMs)}` : undefined}
        />
        <Tile label="Success" value={by('success')} sub="every source ok" />
        <Tile label="Partial" value={by('partial')} sub="at least one source not ok" />
        <Tile label="Failed" value={by('failed')} sub="cycle aborted" />
      </div>
      <Section title="Sources in the last finished cycle">
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Health</th>
                <th className="num">Records</th>
                <th className="num">Duration</th>
                <th>Last ok</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {(last?.sources ?? []).map((s) => (
                <tr key={s.source}>
                  <td>
                    <b>{s.source}</b>
                  </td>
                  <td>
                    <Status code={s.health} />
                  </td>
                  <td className="num">{s.records ?? '—'}</td>
                  <td className="num">{secs(s.durationMs)}</td>
                  <td className="dim">{ts(lastOkBySource.get(s.source))}</td>
                  <td className="wrap">{s.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Section>
      <Section title="Cycles">
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Trigger</th>
                <th className="num">Duration</th>
                <th className="num">Records</th>
                <th>Registry scan</th>
                <th>Not ok</th>
              </tr>
            </thead>
            <tbody>
              {data.cycles.map((c) => (
                <tr key={c.id}>
                  <td>{ts(c.startedAt)}</td>
                  <td data-tip={c.error ?? c.id}>
                    <Status code={c.status} />
                  </td>
                  <td className="dim">{c.trigger}</td>
                  <td className="num">{secs(c.durationMs)}</td>
                  <td className="num">{int(c.records)}</td>
                  <td className="dim">{c.registryScan ? 'yes' : 'no'}</td>
                  <td className="wrap">
                    {c.error ??
                      (c.sources
                        .filter((s) => s.health !== 'ok')
                        .map((s) => `${s.source}: ${s.health}`)
                        .join('; ') ||
                        '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </Section>
    </>
  );
}
