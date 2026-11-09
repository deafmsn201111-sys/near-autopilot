import type { AccountRecommendation } from '../lib/product';
import { actionLabel, recommendationToPrepare } from '../lib/recommendation-intent';
import { PrepareDialog } from './PrepareDialog';

/**
 * The agents' recommendations for the connected wallet, each a card: what (title), why (plain language), which agent,
 * and — when the engine can assemble it — a one-click button that prepares the exact transaction cascade to sign.
 * Read-only on its own; signing (if enabled) happens inside the dialog, in the user's own wallet.
 */
export function Recommendations({
  account,
  recommendations,
  signingEnabled,
}: {
  account: string;
  recommendations: readonly AccountRecommendation[];
  signingEnabled: boolean;
}) {
  if (recommendations.length === 0)
    return (
      <p className="muted-note">
        Nothing to improve right now — the portfolio looks balanced at current prices.
      </p>
    );
  return (
    <div className="recs">
      {recommendations.map((r) => {
        const request = recommendationToPrepare(r.intent, account);
        return (
          <article className={`rec sev-${r.severity}`} key={r.id}>
            <span className="rec-agent">
              <span className="rec-agent-dot" aria-hidden="true" />
              {r.agent}
            </span>
            <div className="rec-head">
              <h3>{r.title}</h3>
            </div>
            <p className="rec-why">{r.why}</p>
            {request ? (
              <PrepareDialog
                request={request}
                label={actionLabel(r.intent)}
                signingEnabled={signingEnabled}
              />
            ) : (
              <span className="muted-note">Advisory — no one-click action for this one yet.</span>
            )}
          </article>
        );
      })}
    </div>
  );
}
