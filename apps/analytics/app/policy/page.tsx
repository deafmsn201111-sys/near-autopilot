import Link from 'next/link';
import { Env } from '../../components/Env';
import { Token } from '../../components/Token';
import { ApiError, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { actionName } from '../../lib/activity';
import { tryApi } from '../../lib/api';
import { ts } from '../../lib/format';
import { gasToTgas, shortAccount, trimDecimals, yoctoToNear } from '../../lib/prepare-format';

export const dynamic = 'force-dynamic';

interface Check {
  rule: string;
  pass: boolean;
  messages: string[];
}
interface CascadeVerdict {
  id: number;
  at: string;
  account: string;
  action: string;
  verdict: 'ALLOW' | 'BLOCK';
  checks: Check[];
  summary: {
    signer: string;
    receivers: string[];
    methods: string[];
    gas: string;
    deposit: string;
  } | null;
  intent: { action?: string; token?: string; tokenOut?: string; poolId?: number } | null;
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

export default async function PolicyPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const verdictFilter = one(sp.verdict);
  const [{ data, error }, attacks] = await Promise.all([
    tryApi<{ verdicts: CascadeVerdict[] }>('/v1/analytics/policy/cascades?limit=300'),
    tryApi<{ label: string | null; file: string | null; entries: Attack[] }>(
      '/v1/analytics/policy/attacks',
    ),
  ]);
  if (!data) return <ApiError what="Safety checks" error={error} />;
  const all = data.verdicts;
  const rows = all.filter((v) => !verdictFilter || v.verdict === verdictFilter);
  const count = (x: string) => all.filter((v) => v.verdict === x).length;
  const atk = attacks.data?.entries ?? [];
  const stopped = atk.filter((a) => a.kind === 'attack' && a.outcome !== 'NOT_BLOCKED').length;
  const attackCount = atk.filter((a) => a.kind === 'attack').length;
  return (
    <>
      <PageHeader
        title="Safety checks"
        lead="Every cascade the prepare endpoint built for a real account, and the verdict of the independent validateCascade gate: signer, receivers, methods, gas, deposit and arguments. It is stored before anything is shown to sign; a blocked cascade is never shown."
        meta={`${all.length} stored verdicts`}
      />
      <div className="kpis">
        <Tile
          label="Allowed"
          value={count('ALLOW')}
          sub={<Status code="ALLOW" label="shown to sign" />}
          href="/policy?verdict=ALLOW"
        />
        <Tile
          label="Blocked"
          value={count('BLOCK')}
          sub={<Status code="BLOCK" label="never shown" />}
          href="/policy?verdict=BLOCK"
        />
        <Tile
          label="Attack demo"
          value={`${stopped} / ${attackCount}`}
          sub="attacks stopped (fixtures)"
        />
      </div>

      <Section
        title="Real cascades"
        note="Open a row for its checks and what the gate saw."
        aside={
          <div className="counts" style={{ margin: 0 }}>
            {['', 'ALLOW', 'BLOCK'].map((v) => (
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
        {rows.length === 0 ? (
          <p className="muted-note">No cascade has been prepared yet.</p>
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Checked</th>
                  <th>Account</th>
                  <th>Action</th>
                  <th>Verdict</th>
                  <th>Failed checks</th>
                </tr>
              </thead>
              {rows.map((v) => {
                const failed = v.checks.filter((c) => !c.pass);
                return (
                  <tbody key={v.id}>
                    <tr>
                      <td style={{ whiteSpace: 'nowrap' }}>{ts(v.at)}</td>
                      <td className="hash">{v.account}</td>
                      <td>
                        {actionName(v.action)} {v.intent?.token && <Token id={v.intent.token} />}
                        {v.intent?.tokenOut && (
                          <>
                            {' → '}
                            <Token id={v.intent.tokenOut} />
                          </>
                        )}
                        {v.intent?.poolId !== undefined && ` · pool #${v.intent.poolId}`}
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
                    </tr>
                    <tr className="detail">
                      <td colSpan={5}>
                        <details>
                          <summary className="dim" style={{ cursor: 'pointer' }}>
                            {v.checks.length} checks
                            {v.summary &&
                              ` · ${v.summary.receivers.length} receivers · ${gasToTgas(v.summary.gas)} · ${trimDecimals(yoctoToNear(v.summary.deposit))} NEAR attached`}
                          </summary>
                          <div className="checks" style={{ marginTop: 10 }}>
                            {v.checks.map((c) => (
                              <div key={c.rule}>
                                <Status code={c.pass ? 'PASS' : 'BLOCK'} label={c.rule} />
                                {c.messages.length > 0 && (
                                  <div style={{ marginLeft: 22 }}>{c.messages.join('; ')}</div>
                                )}
                              </div>
                            ))}
                            {v.summary && (
                              <p className="muted-note" style={{ marginTop: 8 }}>
                                Receivers: {v.summary.receivers.map(shortAccount).join(', ')} ·
                                methods: {v.summary.methods.join(', ')}
                              </p>
                            )}
                          </div>
                        </details>
                      </td>
                    </tr>
                  </tbody>
                );
              })}
            </table>
          </TableWrap>
        )}
      </Section>

      <Section
        title="Attack demo · fixtures, not live"
        note={
          <>
            <b>Fixtures, not live ({attacks.data?.label ?? 'FIXTURE'}).</b> Hand-written malicious
            inputs run through the real defences by <code>pnpm demo:attack</code>; log{' '}
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
