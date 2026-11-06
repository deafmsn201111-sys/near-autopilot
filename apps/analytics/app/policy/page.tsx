import Link from 'next/link';
import { Env } from '../../components/Env';
import { Token } from '../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { tryApi } from '../../lib/api';
import { ts, usd2 } from '../../lib/format';

export const dynamic = 'force-dynamic';

interface Check {
  rule: string;
  result: 'PASS' | 'WARN' | 'BLOCK';
  messages: string[];
}
interface Verdict {
  id: string;
  evaluatedAt: string;
  engine: string;
  runId: string | null;
  intentKind: string;
  intent: {
    kind?: string;
    token?: string;
    amount?: string;
    tokenIn?: string;
    tokenOut?: string;
    amountIn?: string;
  } | null;
  verdict: 'ALLOW' | 'WARN' | 'BLOCK';
  policyVersion: string;
  snapshotId: string;
  planHash: string;
  valueUsdMicro: string | null;
  checks: Check[];
  configStored: boolean;
  environment: string;
  fixture: boolean;
}
interface Attack {
  attack: string;
  kind: 'control' | 'attack';
  description: string;
  defence: string;
  outcome: string;
  verdict: string | null;
  failed: string[];
  reasons: string[];
  signed: number;
  broadcast: number;
}

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

async function IntentCell({ v }: { v: Verdict }) {
  const i = v.intent;
  if (!i) return <span className="dim">{v.intentKind}</span>;
  if (i.kind === 'swap' && i.tokenIn && i.tokenOut)
    return (
      <span className="pair">
        swap <Token id={i.tokenIn} /> → <Token id={i.tokenOut} />
      </span>
    );
  return (
    <span className="pair">
      {(i.kind ?? v.intentKind).replace('lending.', '')} {i.token ? <Token id={i.token} /> : null}
    </span>
  );
}

const SHORT = (s: string, n = 10) => (s.length > n + 8 ? `${s.slice(0, n)}…${s.slice(-4)}` : s);

export default async function PolicyPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const verdictFilter = one(sp.verdict);
  const [{ data, error }, attacks] = await Promise.all([
    tryApi<{ verdicts: Verdict[] }>('/v1/analytics/policy/verdicts?limit=300'),
    tryApi<{ label: string | null; file: string | null; entries: Attack[] }>(
      '/v1/analytics/policy/attacks',
    ),
  ]);
  if (!data) return <ApiError what="Policy verdicts" error={error} />;
  const all = data.verdicts;
  const rows = all.filter((v) => !verdictFilter || v.verdict === verdictFilter);
  const count = (x: string) => all.filter((v) => v.verdict === x).length;
  const versions = new Set(all.map((v) => v.policyVersion));
  const atk = attacks.data?.entries ?? [];
  const stopped = atk.filter((a) => a.kind === 'attack' && a.outcome !== 'NOT_BLOCKED').length;
  const attackCount = atk.filter((a) => a.kind === 'attack').length;
  return (
    <>
      <PageHeader
        title="Policy decisions"
        lead="Every decision of the deterministic policy engine, stored before anything is acted on: ALLOW (the dry-run gateway may proceed), WARN (a human must approve), BLOCK (nothing happens). All 12 checks run every time."
        meta={`${all.length} stored verdicts`}
      />
      <div className="kpis">
        <Tile
          label="Allowed"
          value={count('ALLOW')}
          sub={<Status code="ALLOW" label="gateway may simulate" />}
          href="/policy?verdict=ALLOW"
        />
        <Tile
          label="Held for a human"
          value={count('WARN')}
          sub={<Status code="WARN" label="never auto-executed" />}
          href="/policy?verdict=WARN"
        />
        <Tile
          label="Blocked"
          value={count('BLOCK')}
          sub={<Status code="BLOCK" label="nothing executed" />}
          href="/policy?verdict=BLOCK"
        />
        <Tile
          label="Attack demo"
          value={`${stopped} / ${attackCount}`}
          sub="attacks stopped (fixtures)"
        />
        <Tile label="Policy versions" value={versions.size} sub="rules + config hash" />
      </div>

      <Section
        title="Stored verdicts"
        note="Open a row for the 12 checks. Each verdict is replayable from its row: pnpm audit:replay recomputes it on the stored input and must give the same answer."
        aside={
          <div className="counts" style={{ margin: 0 }}>
            {['', 'ALLOW', 'WARN', 'BLOCK'].map((v) => (
              <Link
                key={v}
                href={v ? `/policy?verdict=${v}` : '/policy'}
                aria-current={verdictFilter === v ? 'true' : undefined}
              >
                <span className="chip">{v || 'All'}</span>
              </Link>
            ))}
          </div>
        }
      >
        <TableWrap>
          <table>
            <thead>
              <tr>
                <th>Evaluated</th>
                <th>Source</th>
                <th>Action</th>
                <th className="num">Value</th>
                <th>Verdict</th>
                <th>Failed checks</th>
                <th>Policy version</th>
                <th>Snapshot</th>
              </tr>
            </thead>
            {rows.map((v) => {
              const failed = v.checks.filter((c) => c.result !== 'PASS');
              return (
                <tbody key={v.id}>
                  <tr>
                    <td style={{ whiteSpace: 'nowrap' }}>{ts(v.evaluatedAt)}</td>
                    <td>
                      <Env env={v.environment} fixture={v.fixture} />
                    </td>
                    <td>
                      <IntentCell v={v} />
                    </td>
                    <td className="num">
                      {v.valueUsdMicro === null ? '—' : usd2(Number(v.valueUsdMicro) / 1e6)}
                    </td>
                    <td>
                      <Status code={v.verdict} label={v.verdict} />
                    </td>
                    <td className="wrap">
                      {failed.length === 0 ? (
                        <span className="dim">all {v.checks.length} passed</span>
                      ) : (
                        failed.map((c) => c.rule).join(', ')
                      )}
                    </td>
                    <td
                      className="hash"
                      data-tip={`${v.policyVersion}${v.configStored ? '\nconfig stored with the verdict' : '\nconfig not stored (row predates stage 4)'}`}
                    >
                      {v.policyVersion.replace('rules-', '')}
                    </td>
                    <td className="hash" data-tip={`${v.snapshotId}\nplan ${v.planHash}`}>
                      {SHORT(v.snapshotId.replace('sha256:', ''))}
                    </td>
                  </tr>
                  <tr className="detail">
                    <td colSpan={8}>
                      <details>
                        <summary className="dim" style={{ cursor: 'pointer' }}>
                          {v.checks.length} checks · {v.engine} engine · decision {SHORT(v.id, 8)}
                        </summary>
                        <div className="checks" style={{ marginTop: 10 }}>
                          {v.checks.map((c) => (
                            <div key={c.rule}>
                              <Status code={c.result} label={c.rule} />
                              {c.messages.length > 0 && (
                                <div style={{ marginLeft: 22 }}>{c.messages.join('; ')}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    </td>
                  </tr>
                </tbody>
              );
            })}
          </table>
        </TableWrap>
      </Section>

      <Section
        title="Attack demo"
        note={
          <>
            <b>{attacks.data?.label ?? 'FIXTURE'}.</b> Hand-written malicious inputs run through the
            real defences by <code>pnpm demo:attack</code>; log{' '}
            <code>{attacks.data?.file ?? 'docs/evidence/demo-attack.log.jsonl'}</code>{' '}
            (deterministic, checked by a test). Two legitimate controls must pass the same defences.
          </>
        }
      >
        {attacks.data ? (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>What it tries</th>
                  <th>Stopped by</th>
                  <th>Result</th>
                  <th>Failed</th>
                  <th className="num">Signed / sent</th>
                </tr>
              </thead>
              <tbody>
                {atk.map((a) => (
                  <tr key={a.attack}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Env env="" fixture /> <b>{a.attack}</b>
                    </td>
                    <td className="wrap">{a.description}</td>
                    <td className="wrap">{a.defence}</td>
                    <td data-tip={a.reasons.join('\n') || a.outcome}>
                      <Status
                        code={
                          a.kind === 'control'
                            ? a.outcome === 'ALLOWED'
                              ? 'ALLOWED'
                              : 'FAILED'
                            : a.outcome === 'NOT_BLOCKED'
                              ? 'FAILED'
                              : 'STOPPED'
                        }
                        label={
                          a.kind === 'control'
                            ? `control: ${a.outcome.toLowerCase()}`
                            : a.outcome.toLowerCase()
                        }
                      />
                    </td>
                    <td className="wrap">{a.failed.join(', ') || '—'}</td>
                    <td className="num">
                      {a.signed} / {a.broadcast}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        ) : (
          <ApiError what="Attack log" error={attacks.error} />
        )}
      </Section>
    </>
  );
}
