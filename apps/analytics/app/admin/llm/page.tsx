import { EmptyState, Facts, PageHeader, Section, TableWrap } from '../../../components/ui';
import { ErrorState } from '../../../components/states';
import { adminApi, type LlmQuality } from '../../../lib/admin';

const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);
const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const json = (v: unknown) => (v === null || v === undefined ? '—' : JSON.stringify(v, null, 1));

/** Admin screen 3: does the LLM help or mostly fall back. */
export default async function LlmQualityPage() {
  let q: LlmQuality;
  try {
    q = await adminApi<LlmQuality>('/llm');
  } catch (e) {
    return <ErrorState what="LLM quality" error={e instanceof Error ? e.message : null} />;
  }
  return (
    <>
      <PageHeader
        title="LLM quality"
        lead="Runs that reached the model, from llm_calls (kept 7 days). Fallbacks before the model (kill switch, cap check, nothing to rank) are not counted."
      />
      {q.calls === 0 ? (
        <EmptyState title="No data yet">
          No analysis reached the model in the last 7 days.
        </EmptyState>
      ) : (
        <>
          <Section title="Last 7 days" note="UTC days.">
            <Facts
              items={[
                ['Runs', String(q.calls)],
                ['Fallback rate', pct(q.fallbackRate)],
                ['Validation-error rate (invalid output)', pct(q.validationErrorRate)],
                ['Latency p50 / p95', `${secs(q.p50Ms)} / ${secs(q.p95Ms)}`],
              ]}
            />
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Fallback code</th>
                    <th className="num">Runs</th>
                    <th className="num">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {q.fallbacks.length === 0 ? (
                    <tr>
                      <td colSpan={3}>No fallbacks.</td>
                    </tr>
                  ) : (
                    q.fallbacks.map((f) => (
                      <tr key={f.code}>
                        <td>{f.code}</td>
                        <td className="num">{f.count}</td>
                        <td className="num">{pct(f.rate)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </TableWrap>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Recommendation type shown</th>
                    <th className="num">Times</th>
                  </tr>
                </thead>
                <tbody>
                  {q.topKinds.length === 0 ? (
                    <tr>
                      <td colSpan={2}>No recommendations from the model yet.</td>
                    </tr>
                  ) : (
                    q.topKinds.map((k) => (
                      <tr key={k.kind}>
                        <td>{k.kind}</td>
                        <td className="num">{k.count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </TableWrap>
          </Section>
          <Section title="Last 20 analyses" note="Newest first. Older than 7 days are purged.">
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>At (UTC)</th>
                    <th>Wallet</th>
                    <th>Outcome</th>
                    <th className="num">Latency</th>
                    <th>Agents called</th>
                    <th>Input</th>
                    <th>Output</th>
                  </tr>
                </thead>
                <tbody>
                  {q.last.map((r, i) => (
                    <tr key={i}>
                      <td>{r.at.slice(0, 19).replace('T', ' ')}</td>
                      <td>{r.accountId}</td>
                      <td>{r.outcome}</td>
                      <td className="num">{secs(r.latencyMs)}</td>
                      <td>{r.tools.join(', ') || '—'}</td>
                      <td>
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{json(r.input)}</pre>
                      </td>
                      <td>
                        <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{json(r.output)}</pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Section>
        </>
      )}
    </>
  );
}
