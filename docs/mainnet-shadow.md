# Mainnet read-only shadow analysis

`./scripts/quickstart.sh` (or `docker compose up -d --build`) → Postgres, the collector, the analytics API on
`127.0.0.1:4003` and the site on `127.0.0.1:3001`. The public server runs the same collector as `shadow-collector`
(`deploy/public/docker-compose.yml`).

A pool's fee history starts at its first stored reading **with cumulative volumes**: the registry-scan reading that
first discovers a pool carries none, so it never starts a fee window or the history used for LP eligibility.

Each collector cycle analyses both **simulated** demo portfolios (`demo-500`, `demo-5000`, served by the in-process
mock RPC) with the full orchestrator with **real mainnet data read with view calls only**:

| Data                                   | Source (mainnet, read-only)                                              |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Prices (wNEAR, USDt, USDC)             | Pyth (needs `PYTH_API_KEY`), DefiLlama `coingecko:*`                     |
| Lending supply / borrow APR, liquidity | Burrow `contract.main.burrow.near` `get_assets_paged_detailed`           |
| Supply reward programmes (farms)       | same view, `farms` (`{"Supplied": token}`), base rate without booster    |
| Pool reserves, fees, cumulative volume | Rhea v1 `v2.ref-finance.near` `metadata`, `get_pool`, `get_pool_volumes` |
| Concentrated-liquidity pool state      | Rhea DCL `dclv2.ref-labs.near` `get_pool` (no APR computed)              |
| Swap quotes for the decision engine    | Rhea v1 `get_return` on allowlisted pools                                |

Rules (enforced in `packages/config`, re-checked in `apps/api/src/wiring.ts`):

- `MARKET_DATA=mainnet-live` only with `DATA_SOURCE=simulation`, `NEAR_NETWORK=mainnet`, `EXECUTION_MODE=dry-run`, and
  `MAINNET_READ_RPC_URL`; `YIELD_DATA=mainnet-onchain` only with `MARKET_DATA=mainnet-live`.
- The mainnet read RPC must answer `status` with `chain_id = mainnet`, or the collector refuses to start. It is a separate
  client used for views only; no signer exists, the executor is dry-run, and the portfolio's own state never comes from
  mainnet (it is the mock).
- Prices are labelled `MAINNET PRICE — SIMULATED PORTFOLIO, NOTHING EXECUTED`; `market_prices.execution_network` is
  `none`; `yield_observations.network` is `mainnet`. Every proposal is a dry run with no transaction hash.
- Allowlist (`config/market.json` `rhea.pools`, loaded from `MARKET_CONFIG_FILE`): **pool 4512** (wNEAR/USDC native, SIMPLE_POOL,
  0.30 %), approved by the operator on 2026-11-05. Observed only: v1 3879 (wNEAR/USDt, ≈ $4k), 5515 and 6063
  (DEGEN_SWAP: unsupported curve, rejected), DCL `USDC|wrap.near|100` and `|2000`.

## Prices: sources and quorum

Asset mapping and checks live in `apps/api/src/market-data/assets.ts`. At run time Pyth feed ids must resolve to the
expected symbol and DefiLlama contract keys must report the expected symbol and decimals; any mismatch leaves the asset
`unpriced`. Every unmapped token is `unpriced`.

1. **Pyth Hermes** (priority 1). Hermes requires an API key (`Authorization: Bearer`). Set `PYTH_API_KEY` in the local
   `.env` only; without it Pyth is reported `unavailable` and is not called. Prices are exact integers with an
   exponent. Rejected: older than 60 s, more than 5 s in the future, non-positive, or a confidence interval wider than
   2 % of the price.
2. **DefiLlama coins API** (priority 2, no key). Rejected: older than 180 s, future, non-positive, symbol or decimals
   not as mapped, DefiLlama confidence below 0.9.
3. **Exchanges, NEAR only** (no key, `apps/api/src/market-data/exchanges.ts`): the last trade of Coinbase `NEAR-USD`,
   Kraken `NEARUSD` and Binance `NEARUSDT`, exact decimal strings with the trade's own time. Rejected: last trade older
   than 180 s, more than 5 s in the future, non-positive. The Binance USDT quote is multiplied by the **corroborated**
   USDT/USD price (Pyth + DefiLlama) and takes the older of the two timestamps; without a corroborated USDT price it is
   `unavailable` (USDT is never assumed to be 1.00).

NEAR (`quorum` in `assets.ts`): one vote per provider (its highest-priority valid key), the median of the votes, and
every vote within **150 bps** of the median agrees. At least **2** agreeing providers → **`corroborated`**, priced at
the median observation (a real quote, not an average); outliers are excluded and named in the reason. Fewer → no price
(`price_disputed` if providers answered but disagree, else `unpriced`). NEAR has **no single-source fallback**.

Other assets (`resolveAsset` in `apps/api/src/market-data/service.ts`):

- valid prices further apart than the asset's limit (stablecoins 100 bps) → **`price_disputed`**: no price, excluded
  from every decision until reviewed;
- two different providers valid and agreeing → **`corroborated`**; the Pyth price is used;
- one provider valid → **`single_source`**: used, and flagged in the UI and in Postgres;
- nothing valid → **`unpriced`**, with every source's reason. A failure never becomes a price of 0.

There is no further fallback. HTTP: 8 s timeout, at most 2 retries with exponential backoff and jitter, `Retry-After`
honoured on 429/503, at most 2 requests in flight; 401/403/404 are never retried. One report is reused for 30 s so a
cycle sees one consistent price set. Amounts are exact decimals/BigInt end to end (`decimal.ts`).

## Yield: formulas

All views of one report are pinned to the same final block (`block_id`); the block height and time are stored with
each estimate. A report is reused for 30 s. Each source is isolated: if one fails it is reported `unavailable` and
contributes nothing; another protocol's data or an older report is never used in its place.

| Type             | Meaning                                                                                                            | Used for                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `lending_supply` | Burrow `supply_apr`: simple annual rate at current utilisation, as the contract reports it (farm rewards excluded) | Capital Allocator, if valid    |
| `lending_borrow` | Burrow `borrow_apr`: a cost to borrowers                                                                           | display only (`informational`) |
| `lp_fee`         | trading fees to LPs over an observation period (historical)                                                        | display only at this stage     |

- `apr` is a fraction (0.05 = 5 %), exact decimal end to end. **`apy` is never computed**: no APR is ever presented as
  an APY.
- Utilisation = `borrowed / (supplied + reserved)`; withdrawable = `supplied + reserved − borrowed` (inner units /
  10^extra_decimals).
- Burrow reward APR = `reward_per_day × 365 × price_reward / (boosted_shares × value per supply share)` (base rate, a
  supplier without a booster); it needs a usable reward-token price (BRRR has only a 0.7-confidence DefiLlama price,
  so it is `MISSING_PRICE`).
- Rhea v1 fee APR (`calculated`), from two observations of cumulative `get_pool_volumes`:
  `lp_fee_usd = Σ Δinput_i × price_i × total_fee/1e4 × (1 − admin_fee_bps/1e4)`;
  `apr = lp_fee_usd / pooled_usd × 31 536 000 / period_s`. `admin_fee_bps` is read from `metadata`. Period: at least
  `minObservationSeconds` (1 h), at most `maxObservationSeconds` (7 d); otherwise no APR. Historical fees are not a
  forecast. The start observation is the latest stored one at least `minObservationSeconds` older; it must be from an
  earlier block and must itself have passed every check except the missing period, otherwise `INVALID_YIELD_DATA`.
  Fees are charged on swap INPUT, so only input volumes are summed. The APR base is the END pool value.
- DCL: pool state is collected and validated but **no APR is computed** (it needs in-range liquidity and fee growth).
  Only configured pools are read, one `get_pool` each.

Config (`config/market.json`, `yield`): `rheaV1Pools` (≤ 20), `dclPools` (≤ 20), `maxAprBps`,
`maxUtilizationBps`, `minLiquidityUsd`, `minObservationSeconds`, `maxObservationSeconds`. Pools there are
**observed**, not allowlisted; nothing adds a pool to `rhea.pools`.

## Yield: validation codes

| Code                     | When                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MISSING_YIELD_DATA`     | rate not reported; no earlier observation for a fee APR; DCL APR (not computed)                                                                                                                                                          |
| `INVALID_YIELD_DATA`     | unparsable/negative rate; APR above `maxAprBps` (100 %); borrowed > supplied; deposits or withdrawals disabled; unreadable decimals; pool price deviating more than `policy.maxOracleDeviationBps` from the reference; volume decreasing |
| `INSUFFICIENT_LIQUIDITY` | utilisation ≥ `maxUtilizationBps` (95 %); withdrawable or pooled value < `minLiquidityUsd` (1000 USD); zero reserve                                                                                                                      |
| `MISSING_PRICE`          | no usable (fresh, undisputed) price: liquidity cannot be valued                                                                                                                                                                          |
| `STALE_YIELD_DATA`       | block older than `orchestrator.freshness.maxMarketAgeSeconds` (300 s); observation period too long                                                                                                                                       |
| `UNVERIFIED_ASSET`       | token not in `policy.allowedTokens`                                                                                                                                                                                                      |
| `UNVERIFIED_POOL`        | Rhea v1 pool not in `rhea.pools` (operator allowlist); any DCL pool                                                                                                                                                                      |
| `SOURCE_UNAVAILABLE`     | the source could not be read (reported per source)                                                                                                                                                                                       |

A rejected estimate keeps the observed rate (it is recorded and shown) but never reaches a strategy. Only `valid`
`lending_supply` estimates become `MarketContext.estimatedYieldWad`; every allocation token without one gets its
reason in `MarketContext.notes.yield`, which the Capital Allocator quotes in its `insufficient_data` answer.

Storage: Postgres `yield_observations` (one row per estimate per report; a `lending_borrow` row can only be
`informational`) and one `yield.report` event per report in `audit_events`. Tests: `apps/api/test/yield.test.ts`.

## History backfill (archival RPC, read-only)

The 24H / 7D / 30D fee windows need a reading that old. `backfill-main.ts` re-reads every active, tracked,
model-supported v1 pool at one past block per day (default 90 days) through an **archival** RPC
(`MAINNET_ARCHIVAL_RPC_URL`, default `https://archival-rpc.mainnet.fastnear.com`; its chain id must be `mainnet`):
`get_pool`, `get_pool_volumes` and the exchange `metadata`, all view calls pinned to the block height. Nothing is signed.

```bash
docker compose exec collector node --import tsx src/collector/backfill-main.ts --days 90
```

On the public server the service is `shadow-collector`.

- The block is a real block within 10 minutes of the target time; its own timestamp is stored.
- TVL of a past state uses DefiLlama **historical** prices at the block time (within 2 h; confidence >= 0.9 OK,
  > = 0.5 LOW_CONFIDENCE). NEAR is OK only if a Coinbase 5-minute candle agrees within 150 bps; disagreeing -> no NEAR
  > price (the point is stored without TVL).
- A pool that did not exist yet, or whose tokens differ, is skipped and counted `missing`.
- Rows are ordinary `rhea_pool_observations` (`snapshot_id = backfill:<run time>`, `raw.backfill` names the source and
  the prices used). Re-runs skip targets with a stored point within 3 h. The window math and every check are unchanged:
  a window across a fee change or a volume decrease is still `DATA_INVALID`.
- Volume in USD over a window is valued at current prices, as for live windows.
