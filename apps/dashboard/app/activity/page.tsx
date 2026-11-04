import { revalidatePath } from 'next/cache';
import { StatusLabel } from '../../components/StatusLabel';
import {
  ApiError,
  getPolicy,
  getProposals,
  getRuns,
  getTestnetTransactions,
  triggerRun,
} from '../../lib/api';
import { evidenceLabel, formatTimestamp, formatUsd } from '../../lib/format';

export const dynamic = 'force-dynamic';

async function runCheck(): Promise<void> {
  'use server';
  try {
    await triggerRun();
  } catch (error) {
    // 409: a check is already in progress. Nothing to do.
    if (!(error instanceof ApiError && error.status === 409)) throw error;
  }
  revalidatePath('/activity');
}

export default async function ActivityPage() {
  const [{ proposals }, { runs }, policy] = await Promise.all([
    getProposals(50),
    getRuns(10),
    getPolicy(),
  ]);
  const onTestnet = policy.dataSource === 'chain' && policy.network === 'testnet';
  const ledger = onTestnet ? await getTestnetTransactions(20) : null;

  return (
    <>
      <h1>Activity</h1>
      <p className="lede">
        Every action an agent proposed, what the policy engine decided, and why.
      </p>

      <form action={runCheck} className="actions">
        <button type="submit">Run a check now</button>
      </form>

      <section className="block" aria-labelledby="checks">
        <h2 id="checks">Recent checks</h2>
        {runs.length === 0 ? (
          <p className="muted">No checks have run yet.</p>
        ) : (
          <ol className="feed">
            {runs.map((r) => (
              <li key={r.id}>
                <div className="feed-head">
                  <StatusLabel status={r.status === 'failed' ? 'failed' : 'completed'} />
                  <span className="feed-value">{r.proposalCount} proposal(s)</span>
                  <time dateTime={r.startedAt}>{formatTimestamp(r.startedAt)}</time>
                </div>
                {r.outcome && <p className="feed-summary">{r.outcome}</p>}
                {r.error && <p className="error-text">{r.error}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>

      {ledger && (
        <section className="block" aria-labelledby="testnet-tx">
          <h2 id="testnet-tx">Testnet transactions (manually confirmed)</h2>
          <p className="muted">
            Budget used {ledger.spentNear} of {ledger.budgetNear} NEAR. These are prepared and sent
            only with the testnet-tx command and an explicit confirmation; the autopilot itself
            never signs.
          </p>
          {ledger.transactions.length === 0 ? (
            <p className="muted">None prepared yet.</p>
          ) : (
            <ol className="feed">
              {ledger.transactions.map((t) => (
                <li key={t.id}>
                  <div className="feed-head">
                    <span className="status">{t.status}</span>
                    <span className="feed-value">
                      {t.actualCostNear ?? `up to ${t.maxCostNear}`} NEAR
                    </span>
                    <time dateTime={t.createdAt}>{formatTimestamp(t.createdAt)}</time>
                  </div>
                  <p className="feed-summary">
                    {t.operation}: {t.receiverId}.{t.methodName} (deposit {t.depositNear} NEAR)
                  </p>
                  {t.txHash && (
                    <p className="evidence">
                      {t.status === 'confirmed'
                        ? `Confirmed on testnet: ${t.txHash}`
                        : `Sent, outcome ${t.status}: ${t.txHash}`}
                    </p>
                  )}
                  {t.error && <p className="muted">{t.error}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <h2>Proposals</h2>
      {proposals.length === 0 ? (
        <p className="muted">
          No proposals yet. Agents only propose when the position needs attention.
        </p>
      ) : (
        <ol className="feed">
          {proposals.map((p) => (
            <li key={p.id}>
              <div className="feed-head">
                <StatusLabel status={p.status} />
                <span className="feed-value">{formatUsd(p.valueUsd)}</span>
                <time dateTime={p.createdAt}>{formatTimestamp(p.createdAt)}</time>
              </div>
              <p className="evidence">{evidenceLabel(p)}</p>
              <p className="feed-summary">{p.summary}</p>
              <p className="muted">
                {p.agentId}: {p.reason}
              </p>
              {p.violations.length > 0 && (
                <ul className="violations">
                  {p.violations.map((v) => (
                    <li key={`${p.id}-${v.rule}-${v.message}`}>{v.message}</li>
                  ))}
                </ul>
              )}
              {p.error && <p className="error-text">{p.error}</p>}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
