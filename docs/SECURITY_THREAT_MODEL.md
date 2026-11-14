# SECURITY_THREAT_MODEL

_Threat model for the product as built: a server that reads a mainnet account, ranks advice and builds **unsigned**
transaction cascades, and a user who signs them in their own wallet. The server holds no key and has no signer (D8,
D9). Controls are listed with the code that enforces them and the test or demo that proves it._

## Assets

- The user's funds: wallet balances, Burrow supply/collateral/loans, Rhea v1 and DCL positions, staking.
- The user's trust in what they sign: a cascade must do exactly what its preview says.
- Spend on the LLM provider and the RPC quota.
- Secrets: RPC keys, `NEAR_AI_API_KEY`, the admin token, DB credentials.

## Trust boundaries

```
 user's wallet  (trusted, the only place anything is signed)
      ▲  unsigned cascade + preview
 validateCascade  (server, fails closed: no cascade at all if any check fails)
      ▲  PlannedTransaction[] from the builders
 builders / agents / LLM  (untrusted proposers: they can propose, never authorise)
      ▲  on-chain reads, market data, 1Click quotes  (untrusted input, zod-parsed)
 browser  (untrusted: its amounts are requests only; the server re-reads the chain and caps them at the balance)
```

Enforcement points: the user's wallet; `validateCascade` (`apps/api/src/wallet/validate-cascade.ts`); the policy engine
on the demo portfolios' agent runs; zod at every external boundary. An LLM only ranks and explains what the
deterministic agents already returned.

## Threats

| #   | Threat                                                             | Check that stops it                                                                                                                                                                                                                | Proof                                                                                       |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| T1  | The server signs or moves funds on its own                         | No signer exists; `EXECUTION_MODE=live` is refused at load (`packages/config`) and again in `wire()`. Only the user's wallet signs.                                                                                                | `wiring.test.ts`, `packages/config/test/env.test.ts`                                        |
| T2  | A cascade step calls an unexpected contract or method              | `validateCascade`: signer = the account, receiver allowlist (the protocol + the tokens in play), method allowlist, allowlisted pools only                                                                                          | `validate-cascade.test.ts`; `pnpm demo:attack` (`storage_unregister`, `attacker.near`)      |
| T3  | A step burns gas or attaches too much NEAR                         | ≤ 300 Tgas per action, ≤ 0.15 NEAR per action (beyond the 1-yocto confirmation), ≤ 0.3 NEAR per cascade, except `near_deposit`, which wraps the user's own NEAR and goes only to wrap.near; loosening needs a `DECISIONS.md` entry | `validate-cascade.test.ts`; `pnpm demo:attack` (301 Tgas, 0.2 NEAR)                         |
| T4  | A withdrawal is redirected to an attacker                          | `ft_transfer` is allowed only to the stored 1Click quote's deposit address, which must be a NEAR implicit account; the quote must belong to the account and not be near expiry (D36)                                               | `withdraw.test.ts`; `pnpm demo:attack` (`withdraw-*`)                                       |
| T5  | A 1Click quote is altered or replayed                              | The server checks 1Click's echo of `recipient` and `refundTo` against what it asked; refunds go to the user (`refundTo` = their account). Each quote's transfer is handed out once (`transfer_issued_at`, #214)                    | `one-click-deposit.test.ts`, `withdraw.test.ts`                                             |
| T6  | A deposit from another chain lands in someone else's account       | HOT Kit's bridge popup with the recipient locked to the connected NEAR account, opened only after the connected account matches the page (D42)                                                                                     | `signing-lock.test.ts`, `deposit-bridge.test.ts` (the account match has no test)            |
| T7  | Prompt injection through token names or market data steers the LLM | The model sees our own token labels only; its reply is zod-parsed and every pick must be a candidate id a tool returned; anything else falls back to the rule-based list                                                           | `ai-analysis.test.ts`; `pnpm demo:attack` (`symbol-injection`)                              |
| T8  | A forged or tampered AI reply is shown as private inference        | Every reply's TEE signature is checked against the attested key over the exact request and answer (D43); a failed check is labelled unverified                                                                                     | `tee-verifier.test.ts`; `pnpm demo:attack` (`tee-*`)                                        |
| T9  | Someone runs paid AI analysis for an account they do not own       | NEP-413 ownership proof: a fixed message signed by a full-access key of the account, 24 h, checked per request, a valid proof cached 60 s (D12)                                                                                    | `ownership.test.ts`                                                                         |
| T10 | LLM spend runs away                                                | Per-UTC-day cap (`LLM_DAILY_CAP_USD`, admin override); each call reserves its worst case first; model allowlist (D14, D38)                                                                                                         | `llm-ledger.integration.test.ts`, `ai-analysis.test.ts`, `packages/config/test/env.test.ts` |
| T11 | A script drains the RPC quota or loads the server                  | Per-visitor and global sliding-window limits on account reads and `/api/prepare`, keyed on the IP Caddy sets; JSON-only prepare; 60 s read cache (D10)                                                                             | `apps/analytics/test/rate-limit.test.ts`                                                    |
| T12 | A bad price or thin pool turns into a bad trade                    | Quotes are re-read on the server; slippage floors on every swap; price-impact gate before signing; unverified tokens never a swap output (D44)                                                                                     | `swap-cost.test.ts`, `sign-review.test.ts`, `prepare-pool-allowlist.test.ts`                |
| T13 | Secrets leak                                                       | Env-only, validation errors name variables never values, generic public errors (D11); gitleaks over the full history on every PR and push to main; leaked keys are rotated (D15); admin on loopback only (D16)                     | `public-errors.test.ts`, CI `secrets` job                                                   |
| T14 | Simulated demo data is mistaken for a real account                 | Demo portfolios are labelled simulated; every displayed number carries its provenance tier                                                                                                                                         | `packages/core/test/provenance.test.ts`                                                     |

## What is not covered

- A compromised wallet or browser extension: the wallet is the trust root. The preview shows outcome, amounts and
  contracts so the user can refuse.
- The TEE hardware quote is not verified on our server (see `KNOWN_ISSUES.md`).
- A cascade is one wallet prompt per step, not atomic across contracts (NEAR cannot do that); a failed step stops the
  rest.
