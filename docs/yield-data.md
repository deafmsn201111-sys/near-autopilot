# Yield data: Burrow and Rhea on TESTNET (read-only)

`YIELD_DATA=testnet-onchain` (testnet profile, API `:4001`, dashboard `:3002` → **Yield data**) reads lending rates
and pool state from NEAR **testnet** contracts and turns them into validated yield estimates for the orchestrator.
Every read is a `call_function` view; nothing is signed or sent. The setting is accepted only with
`MARKET_DATA=mainnet-reference`, which itself requires `NEAR_NETWORK=testnet`, `DATA_SOURCE=chain` and
`EXECUTION_MODE=dry-run` (`packages/config`, re-checked in `apps/api/src/wiring.ts`).

## Flow

```
FastNEAR / RPC ─► final block H (one per report)
   ├─ Burrow   contract.1638481328.burrow.testnet  get_assets_paged_detailed @H  (burrow-adapter BurrowClient)
   ├─ Rhea v1  ref-finance-101.testnet             metadata, get_pool, get_pool_volumes @H (rhea-adapter RheaPoolReader)
   └─ Rhea DCL dclv2.ref-dev.testnet               get_pool @H                    (rhea-dcl-adapter RheaDclClient)
        ─► validation + normalisation (apps/api/src/yield)  ─► YieldReport ─► Postgres yield_observations
        ─► ReferenceMarketProvider: estimatedYieldWad (valid Burrow supply rates only) + reasons
        ─► Capital Allocator / LP Optimizer ─► dry-run decision (audit_events, marketProvenance.yieldReportId)
```

All views of one report are pinned to the same final block (`block_id`), so a report is one consistent state; the
block height and time are stored with each estimate. A report is reused for 30 s. Each source is isolated: if one
fails it is reported `unavailable` and contributes nothing; another protocol's data or an older report is never used
in its place. Read retries are those of `NearRpcClient` (bounded, backoff, `Retry-After` on 429).

## Semantics

| Type             | Meaning                                                                                                            | Used for                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `lending_supply` | Burrow `supply_apr`: simple annual rate at current utilisation, as the contract reports it (farm rewards excluded) | Capital Allocator, if valid    |
| `lending_borrow` | Burrow `borrow_apr`: a cost to borrowers                                                                           | display only (`informational`) |
| `lp_fee`         | trading fees to LPs over an observation period (historical)                                                        | display only at this stage     |

- `apr` is a fraction (0.05 = 5 %), exact decimal end to end. **`apy` is never computed**: Burrow's compounding is not
  confirmed here, so no APR is ever presented as an APY.
- Utilisation = `borrowed / (supplied + reserved)`; withdrawable = `supplied + reserved − borrowed` (inner units /
  10^extra_decimals).
- Rhea v1 fee APR (`calculated`), from two observations of cumulative `get_pool_volumes`:
  `lp_fee_usd = Σ Δinput_i × price_i × total_fee/1e4 × (1 − admin_fee_bps/1e4)`;
  `apr = lp_fee_usd / pooled_usd × 31 536 000 / period_s`. `admin_fee_bps` is read from `metadata` (2000 on testnet).
  Period: at least `minObservationSeconds` (1 h), at most `maxObservationSeconds` (7 d); otherwise no APR. Historical
  fees are not a forecast.
- DCL: pool state is collected and validated (tokens, decimals, state, value, cumulative fees) but **no APR is
  computed** at this stage (it needs in-range liquidity and fee growth). Only configured pools are read, one `get_pool`
  each; the 11k+ testnet pools are never listed in a cycle (unpaged `list_pools` exceeds the view gas limit).

## Validation (every estimate)

| Code                     | When                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MISSING_YIELD_DATA`     | rate not reported; no earlier observation for a fee APR; DCL APR (not computed)                                                                                                                                                          |
| `INVALID_YIELD_DATA`     | unparsable/negative rate; APR above `maxAprBps` (100 %); borrowed > supplied; deposits or withdrawals disabled; unreadable decimals; pool price deviating more than `policy.maxOracleDeviationBps` from the reference; volume decreasing |
| `INSUFFICIENT_LIQUIDITY` | utilisation ≥ `maxUtilizationBps` (95 %); withdrawable or pooled value < `minLiquidityUsd` (1000 USD); zero reserve                                                                                                                      |
| `MISSING_PRICE`          | no usable (fresh, undisputed) reference price: liquidity cannot be valued                                                                                                                                                                |
| `STALE_YIELD_DATA`       | block older than `orchestrator.freshness.maxMarketAgeSeconds` (300 s); observation period too long                                                                                                                                       |
| `UNVERIFIED_ASSET`       | token not in `policy.allowedTokens`                                                                                                                                                                                                      |
| `UNVERIFIED_POOL`        | Rhea v1 pool not in `rhea.pools` (operator allowlist); any DCL pool                                                                                                                                                                      |
| `SOURCE_UNAVAILABLE`     | the source could not be read (reported per source)                                                                                                                                                                                       |

A rejected estimate keeps the observed rate (it is recorded and shown) but never reaches a strategy. Only
`valid` `lending_supply` estimates become `MarketContext.estimatedYieldWad`; every allocation token without one gets
its reason in `MarketContext.notes.yield`, which the Capital Allocator quotes in its `insufficient_data` answer.

Pools in `yield.rheaV1Pools` / `yield.dclPools` are **observed**, not allowlisted. Nothing adds a pool to
`rhea.pools`; that remains an operator decision.

## Configuration (`config/autopilot.testnet.example.json`, `yield`)

`rheaV1Pools` (≤ 20), `dclPools` (≤ 20), `maxAprBps`, `maxUtilizationBps`, `minLiquidityUsd`,
`minObservationSeconds`, `maxObservationSeconds`. Env: `YIELD_DATA`, `RHEA_DCL_CONTRACT_ID`
(compose: `TESTNET_YIELD_DATA`, `TESTNET_RHEA_DCL_CONTRACT_ID`).

## Storage and API

- Postgres `yield_observations` (migration 0005): one row per estimate per report — block height and time, source,
  contract, methods, market, assets, type, APR/APY text, method, formula, period, utilisation, liquidity, volume, price
  status, validation status, reasons, raw source fields (jsonb), source statuses. CHECK constraints: `network =
'testnet'`, and a `lending_borrow` row can only be `informational`.
- `audit_events`: one `yield.report` event per report (block, source health, counts, rejection codes per estimate);
  each orchestrator decision records `marketProvenance.yieldReportId` / `marketReportId`.
- `GET /v1/yield` (read-only, auth) and the dashboard page **Yield data**.

## Tests

- `apps/api/test/yield.test.ts`: rules, formulas, pinned block, partial outages, 429, TTL, market context.
- `apps/api/test/drizzle-repository.integration.test.ts` (`test:db`): persistence, previous observation, CHECKs.
- `apps/api/test/yield.live.test.ts`: `YIELD_LIVE=1 pnpm --filter @near-autopilot/api test:live:yield`, read-only
  views against testnet.
