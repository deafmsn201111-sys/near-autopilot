# NEAR Autopilot — Rework plan (feat/rework)

_Owner's corrected vision (2026-11-09). Branch `feat/rework` from `fix/audit` (clean base, stable backend, no prior "technical" UI)._

## Product in one line

A powerful **real-time DeFi analyzer** with an **AI agent layer** that reads the **connected wallet's** mainnet portfolio, proposes the best moves (what / why / where), and lets the user **execute them in one click by signing in their own wallet** — the site's engine builds the exact, safe transaction cascades.

**Non-negotiable:** no autonomy, the agent never holds a key, the server never signs. Transactions are assembled **precisely and safely** per each contract's real methods. Mainnet only; no fixed test account — whatever wallet is connected is read and signs.

## Keep / Cut

- **Keep (reuse):** agent layer + decision engine, Rhea/Burrow/DCL adapters, collector + market-data, policy + audit, and the protocol **transaction builders** (see map below). Reuse the owner-signs-in-wallet mechanism prototyped on `feat/mainnet-wallet-confirm`.
- **Cut:** autonomous autopilot, Guard contract, any auto-execution, **testnet** (config/code/compose/docs), the execution-mode switch, the current "technical" UI.

## Transaction capability map (ground truth, from the code)

| Operation                                                    | Protocol          | Status                                                                 |
| ------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------- |
| Swap (exact-in / exact-out)                                  | Rhea v1 + DCL     | ✅ built (`rhea-adapter`, `buildSwapExactIn/Out`)                      |
| Supply / add-collateral / repay                              | Burrow            | ✅ built (`buildSupply`, `buildSupplyAsCollateral`, `buildRepay`)      |
| Concentrated liquidity (add / append / remove, limit orders) | Rhea DCL          | ✅ built (`rhea-dcl-adapter/messages.ts`)                              |
| Storage registration                                         | ft / Burrow / DCL | ✅ built (`storage_deposit`, `buildDclStorageDeposit`)                 |
| Wrap NEAR                                                    | wrap.near         | ✅ built (`near_deposit`)                                              |
| **Borrow**                                                   | Burrow            | ⬜ **gap** — intentionally absent; needs the priced `oracle_call` flow |
| **Withdraw**                                                 | Burrow            | ⬜ **gap** — intentionally absent; needs `oracle_call`                 |
| **v1 pool add / remove liquidity**                           | Rhea v1           | ⬜ **gap** — only swap+register today                                  |
| **Unwrap NEAR** (`near_withdraw`)                            | wrap.near         | ⬜ small gap                                                           |

So most assembly already exists; the engine's job is to (a) unify builders behind one "intent → safe transaction cascade" interface, (b) fill the gaps above, (c) drive one-click signing.

## Staged plan

**Phase 0 — Clean base.** Remove testnet entirely; remove autonomous/Guard remnants; drop the execution-mode switch. `verify` green, mainnet-only config.

**Phase 1 — Real-time Data Intelligence.** Live market: prices, Rhea v1 + DCL pools, liquidity depth, Burrow supply/borrow rates — fresh, provenance-tagged. (Extend collector/market-data.)

**Phase 2 — Connected-wallet portfolio (mainnet).** Read the connected account's real portfolio: balances, Burrow positions, Rhea v1 + DCL LP positions, staking. Value + metrics + exposure/concentration.

**Phase 3 — Agent layer & decisions.** Agents analyse market + portfolio → ranked, explained proposals (what/why/where, expected effect, costs, risks). Each proposal = a concrete, parameterised **intent**.

**Phase 4 — Transaction engine (one-click, user-signed) — core, max safety.**

- Unify all builders behind one `Intent → PlannedTransaction[]` assembler.
- Fill gaps: Burrow **borrow** + **withdraw** (oracle_call priced flow), Rhea **v1 add/remove liquidity** (50/50 split, min-amounts, slippage), **unwrap**.
- Client: one click → wallet signs the cascade (HOT Connector); a **clear pre-sign preview** of exactly what will be signed; policy-check every tx; on-chain verification after. No server key, no autonomy.
- Every builder covered by tests + an independent safety review.

**Phase 5 — UX / design (full rework).** Premium, friendly, uncluttered DeFi UI. IA: **Home** (2 demos $5k/$500 + connected-wallet portfolio), **Opportunities/Recommendations**, **Portfolio**, **Activity**. One-click actions from recommendation cards. Design system, mobile, a11y.

**Phase 6 — Real mainnet verification + hardening.** On the connected wallet, run real cascades with small amounts; independent review of the builders; e2e; security.

## What's needed to proceed

Nothing external — the connected wallet provides the account and the signature. Confirm the branch (`feat/rework`) and the phase order; implementation starts at Phase 0.
