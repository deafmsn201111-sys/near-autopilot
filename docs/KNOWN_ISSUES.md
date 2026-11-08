# KNOWN_ISSUES

_Known limitations and defects, honestly stated (brief §3.3, §23). Not a roadmap — see IMPLEMENTATION_ROADMAP for planned work._

## Honest limitations (not bugs, by design today)

- **No LLM reasoning.** Agents are deterministic heuristics; `LlmAgent` is an unimplemented placeholder. No "AI confidence" exists.
- **No autonomous execution.** `loadSigner()` is null; dry-run only. Mainnet execution requires the (unbuilt) Guard contract + review.
- **Owner-signs path is branch-only.** `feat/mainnet-wallet-confirm` is local, never pushed/merged.
- **Single-operator model.** No per-user accounts/policies/sessions yet.
- **Demo portfolios are simulated** (balances), valued at live prices; labelled as such.

## Defects / tech debt to address

- **Duplicated risk logic (partly resolved, T2.1):** the two financial-engine health-factor forms — `risk.ts` `healthFactorWad` (WAD, **authoritative**, used by the orchestrator) and `lending.ts` `healthFactorBps` (legacy engine) — were found NOT to diverge: in the production path both use the same risk parameter, so bps equals WAD truncated to bps. This is now pinned by `financial-engine/test/hf-consistency.test.ts`. `lending.ts` `healthFactor` (float) is display-only (used only in `portfolio.ts`). A full merge into one function was deliberately NOT forced (different scales/rounding; low value, real regression risk pre-deadline). Still open: `burrow-adapter/risk.ts` computes its own USD18 health factor for the Burrow reader's risk view (separate path, not the orchestrator decision) — lower priority. Also 2 guardians / 2 rebalancers remain (legacy vs orchestrator); legacy is removed once the orchestrator path is the only one.
- **No uniform provenance tagging** across all financial values. → `T1.1/T1.2`.
- **Opportunity comparison** lacks a formal, documented, configurable score. → `T2.3`.
- **UX flows** flagged by owner as "not usable" (beyond theme). → `T4.1`.
- **Guard/contract absent** → autonomy hard-blocked. → `T5.1`.
- **CI has no Rust/contract job** (will be needed once `contracts/` lands). → `T5.2`.

## Watch list (external)

- Burrow/Rhea schema drift. Pyth staleness/confidence. NEAR RPC rate limits. DefiLlama yield staleness.
