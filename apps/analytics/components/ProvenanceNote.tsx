import { PROVENANCE_TIERS, PROVENANCE_TIER_INFO } from '@near-autopilot/core';

/**
 * A plain legend of where the numbers on a page come from and how far they can be trusted (brief §5). It exists so an
 * estimate is never read as a verified on-chain fact. One shared vocabulary, from `@near-autopilot/core`.
 */
export function ProvenanceNote() {
  return (
    <details className="more provenance-note" style={{ marginTop: 24 }}>
      <summary>Where these numbers come from</summary>
      <ul className="prov-list">
        {PROVENANCE_TIERS.map((t) => {
          const i = PROVENANCE_TIER_INFO[t];
          return (
            <li key={t}>
              <span className={`chip prov-${i.trust}`}>{i.label}</span>
              <span className="muted-note">{i.describe}</span>
            </li>
          );
        })}
      </ul>
      <p className="fine">
        On-chain values are read facts; prices come from oracles and exchanges; scores, APYs and
        risk levels are <b>our estimates</b>, not promises. Nothing here is a prediction of the
        future, and the agents use no model.
      </p>
    </details>
  );
}
