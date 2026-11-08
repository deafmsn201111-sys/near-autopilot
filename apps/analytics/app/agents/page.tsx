import { ErrorState } from '../../components/states';
import { tryApi } from '../../lib/api';

export const dynamic = 'force-dynamic';

interface AgentDescriptor {
  id: string;
  title: string;
  responsibility: string;
  version: string;
  proposalKinds: string[];
  advisoryOnly: boolean;
}

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
  const { data, error } = await tryApi<{ agents: AgentDescriptor[] }>('/v1/analytics/agents');
  if (!data) return <ErrorState what="The agent roster" error={error} />;

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
              <div className="agent-meta">
                <span className="mono">{a.id}</span>
                <span className="muted-note">v{a.version}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <p className="fine">
        Agents receive plain data only — no keys, no signer, no ability to send a transaction or to
        change their own permissions. An agent that emits anything outside its allowed proposals is
        rejected and flagged.
      </p>
    </>
  );
}
