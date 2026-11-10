# SECURITY_THREAT_MODEL

_Phase 0 deliverable. Threat model for the autonomous DeFi platform. Anchored to the non-negotiable rules in brief §21. Current verified posture is read-only/dry-run; this model governs everything added toward execution._

## 1. Assets to protect

- User's on-chain funds (primary wallet balances, Burrow collateral, LP positions).
- The agent's execution authority (any access key or Guard permission).
- Integrity of the decision/audit record (no forged approvals, no silent limit changes).
- Secrets: RPC keys, `API_TOKEN`, DB credentials, (future) Guard owner keys.

## 2. Trust boundaries

```
 user wallet (trusted, user-controlled)
      │ signs / delegates a *restricted* key
      ▼
 Guard contract (on-chain, independent of AI/backend/frontend)  ← enforcement point
      ▲
      │ typed, validated operation requests only
 backend / agents (semi-trusted: can propose, cannot authorize)
      ▲
      │ HTTP /v1/*
 frontend (untrusted for financial values)
```

Core principle: **enforcement is on-chain in the Guard**, not in AI, backend, or UI code.

## 3. Threats (STRIDE-flavored) and controls

| #   | Threat                                                       | Control                                                                                                                                                                          |
| --- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Forged/elevated agent permissions (agent grants itself more) | Guard validates agent authorization every op; agents cannot modify policy; keys are FunctionCall-restricted, never FullAccess.                                                   |
| T2  | Operation on unknown protocol/token                          | Guard protocol+token allowlists; policy-engine allowlists in backend as defense-in-depth.                                                                                        |
| T3  | Excessive amount / daily-volume / daily-loss bypass          | Guard per-op, daily-volume and daily-loss limits; reserve-before-execute.                                                                                                        |
| T4  | Replay / concurrent limit bypass (TOCTOU)                    | Unique operation IDs; Guard replay protection; serialized limit reservation. (A TOCTOU race was already found + fixed in the wallet hand-off; same discipline applies on-chain.) |
| T5  | Expired session used                                         | Session expiration validated on-chain; UI shows session expiry.                                                                                                                  |
| T6  | Stale/oracle-manipulated prices drive a bad trade            | Freshness + confidence checks (Pyth ≤1% band); risk agent can reject; slippage/min-output constraints.                                                                           |
| T7  | Malicious/compromised protocol callback                      | Verify callbacks; reconcile actual results; pending-operation state machine; never mark success before confirmation.                                                             |
| T8  | Frontend supplies forged financial values                    | Backend never trusts client financial values as authoritative (brief §16); server recomputes.                                                                                    |
| T9  | AI hallucinates a protocol/opportunity                       | Agents constrained to allowlisted protocols/pairs; quoter only returns routable swaps; schema-validated agent outputs.                                                           |
| T10 | Model explanation treated as authorization                   | Execution authorization is a separate, explicit step; no model output signs.                                                                                                     |
| T11 | Emergency Stop fails to halt in-flight ops                   | Stop blocks new ops; already-submitted external calls handled via explicit pending-op state; user can always revoke the agent key.                                               |
| T12 | Secret leakage (logs, images, git)                           | No secrets in logs; `.dockerignore` + image scan; env-only; separate per-env secrets.                                                                                            |
| T13 | Unsafe Guard upgrade / owner compromise                      | Ownership via multisig and/or timelock; critical upgrades reviewed; no mainnet deploy without independent audit.                                                                 |
| T14 | Simulated/demo data mistaken for live                        | Hard demo/live separation; simulation never mints a txHash; UI banners; provenance tiers.                                                                                        |

## 4. Non-negotiable rules (brief §21) — enforcement notes

- Never request/store seed phrases — not collected anywhere; wallet sign-in only.
- Never expose private keys to agents — agents receive no keys; execution goes through Guard/wallet.
- Never grant FullAccess — only restricted FunctionCall keys, Guard-scoped.
- Never bypass Guard — execution engine's only path to chain is through the Guard client.
- Never hide risks/fees, never invent yield/tx results — provenance tiers + confirmation-before-success.
- Never silently change limits/permissions — all changes audited; limit changes are explicit, user-authorized, on-chain.
- Never claim an audit occurred unless an independent audit actually happened.
- Never deploy unsafe code to mainnet.

## 5. Current state vs. this model

- Today: no signer, dry-run only, allowlists + audit + rate-limited public demo → **most execution threats are not yet reachable** because nothing is sent.
- The model becomes load-bearing the moment Approve/Autonomous modes or the Guard are introduced. Each such change references the relevant threats above in its PR and tests.

## 6. Required before any mainnet execution

1. Guard contract implemented, adversarially tested in a local sandbox (brief §18 scenarios).
2. Independent security review (no self-declared audit).
3. Explicit, revocable user authorization; autonomous off by default.
4. Rollback/kill plan (Emergency Stop + key revocation) rehearsed.
