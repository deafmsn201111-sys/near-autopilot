# Financial engine

`@near-autopilot/financial-engine` is a pure, deterministic library. Same inputs, same outputs, on every machine:
no clock, no randomness, no network, no floating point. It depends only on `@near-autopilot/core`.

This page lists **every assumption**, the rounding policy, and how **realized**, **marked** and **estimated** figures
are kept apart. If something is not stated here or in a doc comment, the engine does not assume it.

## 1. Arithmetic rules

| Rule                  | Detail                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No floats for amounts | Token amounts, prices, liquidity, weights and ratios are `bigint`. A JavaScript `number` appears only for small integer _parameters_ that are bounded and validated: basis-point inputs (`0..10000`), fee in ppm, tick index, decimals, a count. |
| Fixed-point scales    | `WAD = 1e18` (ratios, rates, health factor), `BPS = 1e4`, `PPM = 1e6`, `Q96 = 2^96` (sqrt price), `Q128` (fee growth), `Q192`.                                                                                                                   |
| Explicit rounding     | Every division names its direction: `floor`, `ceil` or `nearest` (ties away from zero). There is no implicit truncation except where the Uniswap formula defines it.                                                                             |
| Parsing               | `parseUnits` never rounds; it rejects extra fractional digits instead of dropping them.                                                                                                                                                          |
| Overflow              | `bigint` is unbounded. Where a protocol uses `uint256` wraparound (fee growth), the engine reproduces it explicitly with `subMod256`.                                                                                                            |

### Rounding policy (who is protected)

The engine rounds so that **costs, debts and losses are never understated and values, collateral and yield are never overstated**.

| Quantity                                                        | Direction                                                | Why                                                |
| --------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Swap input needed / fee charged                                 | up                                                       | the pool never undercharges                        |
| Swap output                                                     | down                                                     | the pool never overpays                            |
| Deposit amounts for a liquidity add                             | up                                                       | the real deposit is at least this                  |
| Position value (withdrawable)                                   | down                                                     | the position is worth at most this                 |
| HODL basket value in IL                                         | up                                                       | so IL stays `<= 0` and a loss is never hidden      |
| Collateral value (USD)                                          | down                                                     |                                                    |
| Debt value (USD), accrued interest, borrow-factor adjusted debt | up                                                       |                                                    |
| Health factor                                                   | down                                                     |                                                    |
| LTV                                                             | up                                                       |                                                    |
| Liquidation price / shock distances                             | the safe side, found by bisection on the exact predicate | the reported shock is _safe_; one unit more is not |
| Costs in bps                                                    | up                                                       |                                                    |
| Estimated APR and realized yield                                | down                                                     |                                                    |

## 2. Realized vs. marked vs. estimated

This distinction is carried in the type of every yield result (`basis`), and the three are never added together.

| Basis         | Meaning                                                                                                                                         | Examples in the engine                                                                                                           | Needs assumptions?                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **realized**  | Cash events that already happened. Observed, not modelled.                                                                                      | fees collected, gas paid, swap costs paid; `realizedFeeYield`; `netYield().realized`                                             | No                                              |
| **marked**    | Deterministic mark-to-market of the _current_ state at an observed price. Not cash yet, but nothing is forecast. Includes the realized figures. | uncollected fees (`feesOwed`), impermanent loss, `netYield().marked` (`netVsHodlQuote`)                                          | The observed price only                         |
| **estimated** | Anything that looks forward.                                                                                                                    | `estimateFeeApr`, `netYield().estimated`, `paybackDays`, `allocateConstrained` yields, `rebalanceCost` projected against a quote | **Yes** — listed in `assumptions` on the result |

Rules that follow from this:

1. `realized` never contains impermanent loss: IL is not a cash event until the position is closed.
2. `marked.netVsHodlQuote = realized net + uncollected fees + IL`. It is the honest "profit versus just holding" to date.
3. `estimated` results never feed `realized` or `marked`. The `estimated` block of `netYield` is `null` unless the caller supplies a projection.
4. **Annualizing is arithmetic, not a forecast.** A realized rate of 0.5% over 30 days annualizes linearly (365-day year) to 6.08%; that says what the observed rate would be if it persisted, and the result keeps its `realized` basis. It does not predict anything.
5. Allocation inputs are named `estimatedYieldWad` so they cannot be mistaken for realized figures, and the portfolio yield comes back as `{ basis: 'estimated' }`.

## 3. Modules, formulas and assumptions

### 3.1 `fixed.ts`

`mulDiv`, `divRound`, `isqrt` (Newton, exact floor), `sqrtWad`, `powWad`, clamps, `parseUnits`/`formatUnits`.
Assumption: `powWad` and `sqrtWad` floor, so their error is below `1e-18` relative per operation.

### 3.2 `clmm.ts`: concentrated liquidity valuation

Uniswap-v3 style math in `sqrtPriceX96`.

- `amount0 = L·Q96·(√Pb − √Pa) / (√Pa·√Pb)` and `amount1 = L·(√Pb − √Pa)/Q96`, with the v3 rounding order (inner division first).
- In range: token0 is held above the price, token1 below. **Lower bound inclusive, upper bound exclusive**: at `√P = √Pa` the position is all token0; at `√P = √Pb` it is all token1.
- `liquidityForAmounts` takes the smaller of the two liquidities (the binding side) and rounds down. A deposit that cannot exceed the supplied funds is the contract.
- `feeGrowthInsideX128` / `feesOwed` reproduce `uint256` wraparound: `owed = (growthNow − growthLast) mod 2^256 · L / 2^128`.
- **Assumption — tick to price:** `sqrtRatioAtTick` evaluates `1.0001^(tick/2)` from its exact definition in 192-bit fixed point and rounds to nearest. It is verified against independently generated reference values, but it is **not bit-identical to Uniswap's published lookup table** (differences are at the last bits). The pool-supplied `sqrtPrice` is always the primary input. Rhea's DCL pools use iZiSwap-style ticks and a different pricing convention; use the `rhea-dcl-adapter` values rather than this tick function for those pools.
- Valuation is in **token1 (quote) raw units** at one stated price. Converting to USD is the caller's step, using `valuation.ts`.

### 3.3 `amm.ts`: slippage and price impact

- Constant product: `out = floor(in·(1−f)·Rout / (Rin + in·(1−f)))`; fee = `ceil(in·f)`.
- Concentrated: `swapStepExactIn` is the v3 SwapMath step (input rounds up, output rounds down, the fee takes the remainder when the target is not reached). `concentratedQuoteExactIn` walks the supplied contiguous liquidity segments.
- **Price impact** is measured against the pre-trade spot price with fee excluded; **total cost** is measured against spot including fee. Both in bps, rounded up.
- **Assumption — liquidity is a snapshot.** Segments are supplied by the caller and treated as static during the swap. No other trade, no MEV, no block-to-block change.
- If the supplied segments cannot absorb the whole input, the result says `exhausted: true` with the unfilled `amountRemaining`; it never invents liquidity.
- `withinSlippage` checks `actualOut >= quotedOut·(1 − tolerance)` with an integer, round-down floor.

### 3.4 `impermanent-loss.ts`

- **Full range:** `IL(r) = 2√r/(1+r) − 1`, `r = P_exit/P_entry`. Exact fixtures: `IL(4) = IL(1/4) = −20%`; `IL(2) = −5.7191%`.
- **Concentrated:** `IL = value(position at exit) − value(HODL of the entry deposit at exit)`, in token1. IL is `<= 0` by concavity; the rounding directions (HODL up, position down) preserve that sign. The engine clamps at 0 as a defence; the clamp is not reachable with correctly rounded inputs.
- **Excludes fees** by definition. Fees are reported separately (section 3.5).
- Assumption: the HODL basket is the amounts _deposited at entry_ (so a position minted when out of range is a single-asset basket).

### 3.5 `yield.ts`: fee APR, net yield, payback

- `estimateFeeApr` (**estimated**): `fees/day = volume24h · feePpm/1e6 · share · timeInRange`, `share = L_pos / L_active`, `APR = fees/day · 365 / capital`, and `APY = (1 + APR/n)^n − 1`.
  Assumptions, also emitted in `assumptions[]` on the result:
  1. 24h volume is representative of the future and is spread over the _active_ liquidity pro rata.
  2. The pool-wide volume used applies to the price the position is active at; volume does not shift with the position's presence.
  3. `timeInRangeBps` is an input, not a forecast the engine makes.
  4. Fees compound at the same rate (APY only).
  5. No incentive/reward tokens, no gas, no IL: those are separate lines.
- `realizedFeeYield` (**realized**): `fees collected / average capital`, annualized linearly by `365·86400` seconds.
- `netYield` returns three separate blocks as described in section 2.
- `paybackDays` (**estimated**): `ceil(cost / fees per day)`; `null` when fees per day is zero.
- **Assumption — average capital** is supplied by the caller. The engine does not reconstruct a time-weighted capital history.
- **Fixed 365-day year.** No leap years.

### 3.6 `rebalance.ts`: rebalance cost

- `solveRebalance` finds the swap that makes the holdings fit the new range. It bisects the swap size on the sign of "which side is in surplus" (monotone in the swap size), then sizes the largest liquidity the post-swap holdings can fund. Throws if the supplied book cannot absorb the swap needed.
- `rebalanceCost` splits the cost into **pool fee**, **price impact**, **gas** and **other cost**, valued in quote units at the **pre-trade spot price**.
- **Not included** (explicitly): impermanent loss crystallized by closing the old position, MEV/sandwich loss, failed-transaction gas, the opportunity cost of time out of range, taxes.
- Pool fee is paid in the input token and valued at spot, rounded up and capped by the total swap cost.
- `leftover` is what remains un-deposited after rounding; it is reported, never hidden.

### 3.7 `risk.ts`: lending health, liquidation risk and stress

Generic Aave/Burrow-style model: each collateral asset has a liquidation threshold (bps); each debt asset may have a borrow factor (bps, default 10000).

```
collateralUsd         = Σ floor(value)
adjustedCollateralUsd = Σ floor(value · LT / 10000)
debtUsd               = Σ ceil(value)
adjustedDebtUsd       = Σ ceil(ceil(value) · 10000 / borrowFactor)
healthFactor          = floor(adjustedCollateralUsd · WAD / adjustedDebtUsd)     (null if no debt)
liquidatable          ⇔ debt exists AND adjustedCollateralUsd < adjustedDebtUsd
ltvBps                = ceil(debtUsd · 10000 / collateralUsd)                     (null if debt and no collateral)
```

- **HF exactly 1.0 is not liquidatable.** The decision is made on the integer comparison, not on the rounded ratio, so the two can never disagree; a test asserts `liquidatable ⇔ HF < WAD` over random positions.
- **Status bands** (`healthy / watch / danger / liquidatable / no-debt`) use thresholds that are _policy defaults_ (`danger < 1.10`, `watch < 1.50`) and are overridable. They are not protocol parameters.
- **Stress scenarios** apply exact multipliers `(10000 + shock)/10000` with no rounding: prices are `multiplier / 10^decimals`, so a shock is `multiplier·(10000+shock)` and `decimals + 4`. A scenario can shock all collateral, all debt, individual assets (which override the default), and accrue interest (debt rounds up).
- **Distance to liquidation:** `collateralDropBuffer`, `debtRiseBuffer` and `liquidationPrice` are found by bisection on the exact predicate. The reported shock is safe, and one bp (or one price unit) further is not. A test asserts this tightness for random models. Debt-rise searches are capped at 10,000,000 bps and flagged `capped`.
- **`simulateLiquidation`** is a single Aave-style call: repay up to `closeFactor` of one debt asset, seize collateral worth `(1 + bonus)` times the repayment (rounded in the liquidator's favor, i.e. worst case for the borrower), or all of the collateral if it runs out. Close factor and bonus are inputs because they are protocol- and asset-specific.
- **Inputs are protocol parameters supplied by the caller.** The engine does not read a chain. For Burrow, the `burrow-adapter` computes the same quantities from verified on-chain parameters; this module is the protocol-agnostic version and is what other protocols or what-if analysis use.
- **No probability of liquidation.** That needs a price distribution (volatility, drift, correlation), which would be an assumption the engine has no basis for. The engine answers "what _is_ the buffer and what happens at _this_ shock", and refuses to invent a probability.
- **Assumption — oracle price is the liquidation price.** Real protocols can use a different oracle than the market, with delays and confidence intervals. Differences are not modelled.

### 3.8 `allocate.ts`: constrained allocation

Solves exactly, in integer basis points:

```
maximise   Σ wᵢ · yᵢ       (yᵢ = estimatedYieldWad, an ESTIMATE)
subject to minᵢ ≤ wᵢ ≤ maxᵢ,   Σ wᵢ = 10000,   Σ_{i∈G} wᵢ ≤ capG   (disjoint groups)
```

- With a linear objective and these box and group-capacity constraints, filling the minimums and then the highest yield first is optimal. This is not just argued: tests compare the result with exhaustive search on randomized instances and with the infeasibility cases.
- Ties break by asset id ascending, so output is independent of input order.
- Infeasible problems throw `InfeasibleAllocationError` with the reason (minimums above 100%, group minimums above a cap, maximums that cannot reach 100%).
- `weightsToAmounts` converts weights to amounts that sum **exactly** to the total (largest remainder, ties by id).
- `limitTurnover` moves toward a target by at most N bps of one-way turnover, rounds toward the current weights so the limit is never exceeded, and keeps the sum at exactly 10,000.
- **It is not mean-variance optimization.** There is no risk model or correlation. Risk limits are expressed as bounds and group caps chosen by the operator.
- Negative yields are allowed; capital must still be placed, so weights sum to 100%.

## 4. Relationship to other code

| Code                                               | Relationship                                                                                                                                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `financial-engine/src/lending.ts` (`healthFactor`) | **Legacy.** Returns a floating-point _ratio_ (a number, not an amount) and floors debt. Kept for the existing planner and policy checks. Anything that decides liquidation should use `risk.ts` (`assessLendingPosition`).   |
| `burrow-adapter/src/risk.ts`                       | Burrow-specific, built on verified protocol parameters. Same conventions (HF 1.0 is not liquidatable, pessimistic rounding).                                                                                                 |
| `rhea-dcl-adapter`                                 | Source of pool state for Rhea DCL. `clmm.ts` is the Uniswap-v3 convention; iZiSwap ticks differ (see 3.2).                                                                                                                   |
| `policy-engine`, `agents`                          | May import this package (dependencies point one way: they depend on `financial-engine`, which depends only on `core`). The direction is enforced by `scripts/check-boundaries.mjs`. Neither currently calls the new modules. |

## 5. Test strategy

| Kind             | What                                                                                                                                                                                                                                                                           | Where                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Known fixtures   | Hand-computed values and independently generated references (Python big-integer scripts written separately from the package).                                                                                                                                                  | all `test/*.test.ts`                 |
| Protocol vectors | Uniswap v3 SwapMath vectors and tick/sqrt-price reference values.                                                                                                                                                                                                              | `amm.test.ts`, `clmm.test.ts`        |
| Boundary tests   | HF exactly 1.0, range edges (lower inclusive, upper exclusive), `MIN_TICK`/`MAX_TICK`, zero amounts, empty portfolios, price at a range bound, group-cap edges.                                                                                                                | all                                  |
| Property tests   | Seeded, replayable: conservation of tokens through swaps and rebalances, `IL <= 0`, symmetry `IL(r) = IL(1/r)`, tightness of liquidation buffers and prices, HF monotonicity, allocation optimality against brute force, exact sums, turnover bounds, `liquidatable ⇔ HF < 1`. | `test/support/prop.ts` + each suite  |
| Mutation checks  | Key lines (rounding direction, comparison operators, constants) were deliberately broken and the suites were required to fail. See limitations for what survived.                                                                                                              | manual, recorded here                |
| Fuzzing          | 20,000 random rebalance cases, which found and fixed a real defect (see 6).                                                                                                                                                                                                    | ad hoc script, regression test added |

**About the property harness.** `fast-check` could not be installed in the build sandbox (no registry access), so the
library ships a small seeded harness (`mulberry32` PRNG, `forAll`). A failure reports the seed, case index and input,
and replays exactly. It does **not** shrink counterexamples and is not coverage-guided; generators are biased toward
boundaries instead. Moving to `fast-check` later only requires re-expressing the `forAll` call sites.

## 6. Defects found while testing

- **Price exactly at the lower bound of a range** made `liquidityForAmounts` divide by zero (`√P − √Pa = 0`). Found by fuzzing the rebalance solver; fixed by treating `√P <= √Pa` as all token0 (as Uniswap's `LiquidityAmounts` does). Regression tests added in `clmm.test.ts` and `rebalance.test.ts`.
- Earlier rounding fixtures were all exact, so a flipped rounding direction would not have been noticed; mutation testing exposed this and `rounding-fixtures.test.ts` now pins each direction with inexact, independently computed vectors.

## 7. Known limitations (read before relying on a number)

1. **Nothing here is a forecast.** `estimated` results are only as good as their listed assumptions.
2. **No probability model**, no volatility, no correlation, no VaR.
3. **Tick function is not bit-identical to Uniswap's table** (3.2). Use pool-supplied sqrt prices.
4. **Liquidity snapshots are static**; quotes ignore other trades and MEV.
5. **Rebalance cost excludes** crystallized IL, MEV, failed-transaction gas and opportunity cost.
6. **365-day year**, no leap years; annualization is linear.
7. **Average capital and time-in-range are inputs.** The engine does not reconstruct history.
8. **Generic lending model:** close factor, bonus, thresholds and oracle behaviour are inputs. Protocol-specific details (isolated assets, e-mode, caps, interest model) are not modelled here.
9. **Surviving mutants, both defensive code with no known trigger:** the `il > 0 ? 0 : il` clamp in `impermanentLossConcentrated` (IL is non-positive by construction) and the 16-step overshoot loop in `solveRebalance` (not reached in 20,000 fuzzed cases). They remain as defence in depth and are not covered by a test that can fail.
10. **Not verified against a live chain.** No NEAR RPC was reachable from the build environment, so nothing here has been compared with on-chain state. Fixtures are mathematical, not observational.
