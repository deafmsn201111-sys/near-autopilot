import type { PolicyDto } from '@near-autopilot/core';
import { provenanceBanner } from '../lib/format';

/** Always-visible statement of where the data on screen comes from. */
export function ProvenanceBanner({ policy }: { policy: PolicyDto | null }) {
  if (!policy) {
    return (
      <p className="provenance provenance-unknown" role="status">
        Data source unknown: the autopilot API is unreachable.
      </p>
    );
  }
  const banner = provenanceBanner(policy);
  return (
    <p className={`provenance provenance-${banner.tone}`} role="status">
      {banner.text}
      {policy.simulationPortfolio && ` Portfolio: ${policy.simulationPortfolio}.`}
      {` Engine: ${policy.engine}.`}
    </p>
  );
}
