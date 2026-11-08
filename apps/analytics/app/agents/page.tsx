import { ErrorState } from '../../components/states';
import { tryApi } from '../../lib/api';
import { ago } from '../../lib/product';
import { ProvenanceNote } from '../../components/ProvenanceNote';

export const dynamic = 'force-dynamic';

interface AgentDescriptor {
  id: string;
  title: string;
  responsibility: string;
  version: string;
  proposalKinds: string[];
  advisoryOnly: boolean;
}

interface AgentActivity {
  agent: string;
  event: string;
  suspicious: boolean;
  conclusions: { kind: string; text: string }[];
}
interface DecisionSummary {
  id: string;
  outcome: string;
  expiresAt: string;
  reasons: string[];
}
interface LatestActivity {
  run: { id: string; at: string } | null;
  decision: DecisionSummary | null;
  agents: AgentActivity[];
}

const OUTCOME_LABEL: Record<string, string> = {
  no_action: 'No action needed',
  act: 'Action proposed',
};

/** HH:MM UTC for a timestamp, or '' if absent/invalid. */
const hhmm = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
};

/** Plain-language label for each proposal kind an agent may emit. */
const KIND_LABEL: Record<string, string> = {
  no_action: 'hold (no action)',
  'market.signal': 'market caution',
  'portfolio.signal': 'concentration signal',
  'lp.reposition': 'liquidity reposition',
  'lending.repay': 'repay loan',
  'lending.supply_collateral': 'add collateral',
  'lending.supply': 'supply to earn',
  'allocation.swap': 'swap',
};

/**
 * The multi-agent roster. Honest identity of the agents that actually run the decision cycle (the demo uses the
 * orchestrator engine): what each is responsible for, the version of its logic, and what it is allowed to propose.
 * No agent can act on its own — every proposal is checked by the policy engine, and nothing is signed or sent.
 */
export default async function AgentsPage() {
  const [{ data, error }, latestRes] = await Promise.all([
    tryApi<{ agents: AgentDescriptor[] }>('/v1/analytics/agents'),
    tryApi<LatestActivity>('/v1/analytics/agents/latest'),
  ]);
  if (!data) return <ErrorState what="The agent roster" error={error} />;
  const latest = latestRes.data ?? null;
  const activityOf = new Map((latest?.agents ?? []).map((a) => [a.agent, a]));

  return (
    <>
      <div className="hero-head">
        <h1>The agents</h1>
        <span className="muted-note">
          Independent agents analyse your portfolio and the market and <b>propose</b> what is worth
          doing. Each proposal is checked by the safety policy; nothing is signed or sent. You keep
          control.
        </span>
      </div>

      {latest?.run && (
        <div className="callout" role="note" style={{ marginBottom: 16 }}>
          <b>Last cycle {ago(latest.run.at)}.</b>{' '}
          {latest.decision
            ? `${OUTCOME_LABEL[latest.decision.outcome] ?? latest.decision.outcome}.`
            : ''}
          {latest.decision?.expiresAt && hhmm(latest.decision.expiresAt)
            ? ` This read of the data is valid until ${hhmm(latest.decision.expiresAt)} UTC — after that the agents re-check before anything could be acted on.`
            : ''}
        </div>
      )}

      <section className="block">
        <div className="agent-grid">
          {data.agents.map((a) => (
            <article className="agent-card" key={a.id}>
              <div className="agent-card-head">
                <h3>{a.title}</h3>
                <span className="tag">{a.advisoryOnly ? 'advisory' : 'can propose actions'}</span>
              </div>
              <p className="muted-note">{a.responsibility}</p>
              <div className="agent-kinds">
                {a.proposalKinds
                  .filter((k) => k !== 'no_action')
                  .map((k) => (
                    <span className="chip" key={k}>
                      {KIND_LABEL[k] ?? k}
                    </span>
                  ))}
              </div>
              {(() => {
                const act = activityOf.get(a.id);
                if (!act || act.conclusions.length === 0) return null;
                return (
                  <div className="agent-latest">
                    <span className="eyebrow">Latest cycle</span>
                    {act.conclusions.map((c, i) => (
                      <p className="muted-note" key={i}>
                        {c.text}
                      </p>
                    ))}
                  </div>
                );
              })()}
              <div className="agent-meta">
                <span className="mono">{a.id}</span>
                <span className="muted-note">v{a.version}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="block">
        <h2>How a decision is made</h2>
        <ol className="flow">
          <li>
            <b>Agents propose.</b> Each agent turns plain portfolio and market data into a proposal
            — or says there is nothing to do. Agents never act; they only advise.
          </li>
          <li>
            <b>The safety policy checks every proposal.</b> Twelve independent rules (allowlists,
            amount and daily limits, slippage, oracle freshness, intent match…). Anything that fails
            is blocked.
          </li>
          <li>
            <b>You review and approve.</b> An approved proposal is shown to you in plain language,
            with its costs and risks, before anything happens.
          </li>
          <li>
            <b>Your wallet signs.</b> Only your own wallet can sign. The agent has no key and cannot
            send a transaction. On this demo nothing is ever signed or sent.
          </li>
        </ol>
      </section>

      <p className="fine">
        Agents receive plain data only — no keys, no signer, no ability to send a transaction or to
        change their own permissions. An agent that emits anything outside its allowed proposals is
        rejected and flagged.
      </p>
      <ProvenanceNote />
    </>
  );
}
