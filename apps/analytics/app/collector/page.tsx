import { tryApi } from '../../lib/api';
import { tone, ts } from '../../lib/format';
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

export default async function CollectorPage() {
  const { data, error } = await tryApi<{ cycles: Cycle[] }>('/v1/analytics/collector?limit=100');
  if (!data) return <p className="bad">Analytics API unavailable: {error}</p>;
  const last = data.cycles.find((c) => c.status !== 'running');
  const lastOkBySource = new Map<string, string>();
  for (const c of data.cycles)
    for (const s of c.sources)
      if (s.health === 'ok' && !lastOkBySource.has(s.source))
        lastOkBySource.set(s.source, c.startedAt);
  return (
    <>
      <h1>Collector Monitor</h1>
      <p className="small dim">
        The collector is a plain Node service (no LLM, no Claude Code). It runs on a schedule, never
        in parallel, and writes every cycle here, including partial and failed ones.
      </p>
      <section className="block">
        <h2>Sources in the last finished cycle</h2>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Health</th>
              <th className="num">Records</th>
              <th className="num">Duration</th>
              <th>Last OK</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {(last?.sources ?? []).map((s) => (
              <tr key={s.source}>
                <td>{s.source}</td>
                <td className={tone(s.health)}>{s.health}</td>
                <td className="num">{s.records ?? '—'}</td>
                <td className="num">
                  {s.durationMs !== undefined ? `${(s.durationMs / 1000).toFixed(1)} s` : '—'}
                </td>
                <td className="small">{ts(lastOkBySource.get(s.source))}</td>
                <td className="small">{s.detail ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="block">
        <h2>Cycles</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Trigger</th>
                <th>Status</th>
                <th className="num">Duration</th>
                <th className="num">Records</th>
                <th>Registry scan</th>
                <th>Not OK</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {data.cycles.map((c) => (
                <tr key={c.id}>
                  <td className="small">{ts(c.startedAt)}</td>
                  <td>{c.trigger}</td>
                  <td className={tone(c.status)}>{c.status}</td>
                  <td className="num">
                    {c.durationMs ? `${(c.durationMs / 1000).toFixed(1)} s` : '—'}
                  </td>
                  <td className="num">{c.records.toLocaleString('en-US')}</td>
                  <td>{c.registryScan ? 'yes' : 'no'}</td>
                  <td className="small">
                    {c.sources
                      .filter((s) => s.health !== 'ok')
                      .map((s) => `${s.source}: ${s.health}`)
                      .join('; ') || '—'}
                  </td>
                  <td className="small">{c.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
