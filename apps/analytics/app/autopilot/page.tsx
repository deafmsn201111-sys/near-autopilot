import Link from 'next/link';
import { ConfirmAction } from '../../components/ConfirmAction';
import { EmptyState, PageHeader, Section, Status, TableWrap, Tile } from '../../components/ui';
import { ErrorState } from '../../components/states';
import { tryApi } from '../../lib/api';
import { int, ts } from '../../lib/format';
import { ago, control, inTime, scopeName, system } from '../../lib/product';
import { runAnalysis, setCollectorPaused, setMode } from './actions';

export const dynamic = 'force-dynamic';

interface Cycle {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  records: number;
  error: string | null;
}

export default async function AutopilotPage() {
  const [ctl, sys, cycles, verdicts] = await Promise.all([
    control(),
    system(),
    tryApi<{ cycles: Cycle[] }>('/v1/analytics/collector?limit=8'),
    tryApi<{ verdicts: { verdict: string }[] }>('/v1/analytics/policy/verdicts?limit=500'),
  ]);
  if (!ctl.data) return <ErrorState what="Autopilot controls" error={ctl.error} />;
  const c = ctl.data.collector;
  const live = c.live;
  const v = verdicts.data?.verdicts ?? [];
  const history = ctl.data.modes
    .flatMap((m) => m.history.map((h) => ({ ...h, scope: m.scope })))
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 10);
  return (
    <>
      <PageHeader
        title="Autopilot"
        lead="Run and pause the market analysis, and put the autopilot into read-only mode when something looks wrong. Every change asks for confirmation and is written to the audit trail."
      />
      <div className="callout" style={{ marginBottom: 20 }}>
        <b>Shadow mode.</b> The autopilot reads NEAR mainnet, analyses two simulated demo portfolios
        and checks every proposal against the safety policy. It has no wallet and cannot send a
        transaction; there is deliberately no &ldquo;execute&rdquo; button. Real execution is a
        future stage.
      </div>

      <Section
        title="Market analysis"
        note="Each run reads prices, Rhea pools and Burrow markets from mainnet, re-ranks the opportunities and re-analyses the demo portfolios."
      >
        <div className="kpis">
          <Tile
            label="Status"
            value={
              live?.running ? (
                <Status code="running" label="Running now" />
              ) : c.paused ? (
                <Status code="paused" />
              ) : (
                <Status code="OK" label="Scheduled" />
              )
            }
            sub={
              c.paused
                ? `Paused ${ago(c.at)} by ${c.by ?? '—'}: ${c.reason}`
                : `every ${Math.round((sys.data?.collector.intervalSeconds ?? 900) / 60)} min`
            }
          />
          <Tile
            label="Last data"
            value={ago(sys.data?.collector.lastSuccessAt)}
            sub={sys.data?.collector.stale ? 'out of date' : 'up to date'}
          />
          <Tile
            label="Next scheduled run"
            value={c.paused ? 'paused' : live?.nextRunAt ? inTime(live.nextRunAt) : '—'}
            sub={live ? 'collector online' : 'collector status unavailable'}
          />
        </div>
        <div className="actions" style={{ marginTop: 14 }}>
          <ConfirmAction
            label="Run market analysis now"
            tone="primary"
            title="Run a market analysis now?"
            description="The collector reads mainnet (view calls only), re-ranks opportunities and re-analyses the demo portfolios. It takes about a minute. Nothing is signed or sent."
            confirmLabel="Run analysis"
            action={async () => {
              'use server';
              return runAnalysis();
            }}
          />
          {c.paused ? (
            <ConfirmAction
              label="Resume scheduled analysis"
              title="Resume the scheduled analysis?"
              description="Scheduled runs start again at the normal interval."
              confirmLabel="Resume"
              needsReason
              action={async (reason) => {
                'use server';
                return setCollectorPaused(false, reason);
              }}
            />
          ) : (
            <ConfirmAction
              label="Pause scheduled analysis"
              title="Pause the scheduled analysis?"
              description="Scheduled runs are skipped until you resume; data will become out of date. You can still run an analysis manually. Nothing else changes."
              confirmLabel="Pause"
              needsReason
              action={async (reason) => {
                'use server';
                return setCollectorPaused(true, reason);
              }}
            />
          )}
        </div>
      </Section>

      <Section
        title="Operating mode"
        note="Normal: the autopilot proposes and checks actions (dry run). Read-only: no plan may run at all, not even as a dry run; analysis continues. The system switches to read-only by itself on a safety trigger and never leaves it by itself."
      >
        {ctl.data.modes.length === 0 ? (
          <EmptyState title="No autopilot has started yet.">
            A mode appears here after the first autopilot cycle.
          </EmptyState>
        ) : (
          <div className="opp-list">
            {ctl.data.modes.map((m) => {
              const n = scopeName(m.scope);
              return (
                <div className="card" key={m.scope} style={{ display: 'grid', gap: 10 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 16,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <b>{n.name}</b> <span className="chip">{n.env}</span>
                      <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
                        since {ts(m.since)} · {m.reason} · by {m.changedBy}
                      </div>
                    </div>
                    <div className="actions">
                      <Status code={m.mode} />
                      {m.mode === 'normal' ? (
                        <ConfirmAction
                          label="Switch to read-only"
                          tone="danger"
                          title={`Switch ${n.name} to read-only?`}
                          description="No plan for this portfolio may run, not even as a dry run, until someone returns it to normal. Analysis continues. Use it when prices or behaviour look wrong."
                          confirmLabel="Switch to read-only"
                          needsReason
                          action={async (reason) => {
                            'use server';
                            return setMode(m.scope, 'read_only', reason);
                          }}
                        />
                      ) : (
                        <ConfirmAction
                          label="Return to normal"
                          title={`Return ${n.name} to normal?`}
                          description="Plans for this portfolio may again pass the safety policy and run as dry runs. Do this only after the cause of the restriction is understood."
                          confirmLabel="Return to normal"
                          needsReason
                          action={async (reason) => {
                            'use server';
                            return setMode(m.scope, 'normal', reason);
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <div className="grid-2">
        <Section
          title="Recent analysis runs"
          aside={
            <Link href="/collector" className="dim">
              Full log →
            </Link>
          }
        >
          {cycles.data ? (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Trigger</th>
                    <th>Result</th>
                    <th className="num">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {cycles.data.cycles.map((x) => (
                    <tr key={x.id}>
                      <td>{ago(x.startedAt)}</td>
                      <td className="dim">{x.trigger === 'on_demand' ? 'manual' : 'scheduled'}</td>
                      <td data-tip={x.error ?? 'no error'}>
                        <Status code={x.status} />
                      </td>
                      <td className="num">{int(x.records)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          ) : (
            <ErrorState what="Analysis runs" error={cycles.error} />
          )}
        </Section>
        <Section
          title="Safety policy"
          aside={
            <Link href="/policy" className="dim">
              All decisions →
            </Link>
          }
        >
          <div className="kpis">
            <Tile
              label="Decisions recorded"
              value={int(v.length)}
              sub="every proposal gets one"
              href="/policy"
            />
            <Tile
              label="Blocked"
              value={int(v.filter((x) => x.verdict === 'BLOCK').length)}
              sub="stopped by at least one of 12 checks"
              href="/policy?verdict=BLOCK"
            />
          </div>
          <p className="note">
            The policy engine is independent of the agents: no agent and no text input can change
            its limits (value per action and per day, price freshness, agreement between price
            sources, slippage).
          </p>
        </Section>
      </div>

      <Section
        title="Mode changes"
        note="Newest first. Each change is a numbered entry in the audit trail."
      >
        {history.length === 0 ? (
          <EmptyState title="No mode change recorded yet." />
        ) : (
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Portfolio</th>
                  <th>Change</th>
                  <th>Reason</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={`${h.scope}-${h.version}`}>
                    <td className="dim">{ts(h.at)}</td>
                    <td>
                      {scopeName(h.scope).name}{' '}
                      <span className="chip">{scopeName(h.scope).env}</span>
                    </td>
                    <td>
                      {(h.previousMode ?? 'new').replace(/_/g, ' ')} → <Status code={h.mode} />
                    </td>
                    <td className="wrap">{h.reason}</td>
                    <td className="dim">{h.changedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Section>
    </>
  );
}
