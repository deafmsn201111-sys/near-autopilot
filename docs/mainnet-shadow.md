# Mainnet read-only shadow analysis

`docker compose --profile shadow up -d` → API `:4002`, dashboard `:3003`; shadow collector, analytics API `:4003` and
analytics dashboard `:3001` (see the README section "Mainnet read-only analytics").

A pool's fee history starts at its first stored reading **with cumulative volumes**: the registry-scan reading that
first discovers a pool carries none, so it never starts a fee window or the history used for LP eligibility.

A **simulated** demo portfolio (`SHADOW_PORTFOLIO=demo-500 | demo-5000`, served by the in-process mock RPC) is analysed
by the full orchestrator with **real mainnet data read with view calls only**:

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
- The mainnet read RPC must answer `status` with `chain_id = mainnet`, or the API refuses to start. It is a separate
  client used for views only; no signer exists, the executor is dry-run, and the portfolio's own state never comes from
  mainnet (it is the mock).
- Prices are labelled `MAINNET PRICE — SIMULATED PORTFOLIO, NOTHING EXECUTED`; `market_prices.execution_network` is
  `none`; `yield_observations.network` is `mainnet`. Every proposal is a dry run with no transaction hash.
- Allowlist (`config/autopilot.shadow.example.json` `rhea.pools`): **pool 4512** (wNEAR/USDC native, SIMPLE_POOL,
  0.30 %), approved by the operator on 2026-11-05. Observed only: v1 3879 (wNEAR/USDt, ≈ $4k), 5515 and 6063
  (DEGEN_SWAP: unsupported curve, rejected), DCL `USDC|wrap.near|100` and `|2000`.

Validation, formulas and storage are those of [yield-data.md](yield-data.md). The reward APR is
`reward_per_day × 365 × price_reward / (boosted_shares × value per supply share)` (base rate, a supplier without a
booster); it needs a usable reward-token price (BRRR has only a 0.7-confidence DefiLlama price, so it is
`MISSING_PRICE`). A Rhea v1 fee APR needs two observations at least `minObservationSeconds` (1 h) apart.

## History backfill (archival RPC, read-only)

The 24H / 7D / 30D fee windows need a reading that old. `backfill-main.ts` re-reads every active, tracked,
model-supported v1 pool at one past block per day (default 90 days) through an **archival** RPC
(`MAINNET_ARCHIVAL_RPC_URL`, default `https://archival-rpc.mainnet.fastnear.com`; its chain id must be `mainnet`):
`get_pool`, `get_pool_volumes` and the exchange `metadata`, all view calls pinned to the block height. Nothing is signed.

```bash
docker compose --profile shadow exec shadow-collector node --import tsx src/collector/backfill-main.ts --days 90
```

- The block is a real block within 10 minutes of the target time; its own timestamp is stored.
- TVL of a past state uses DefiLlama **historical** prices at the block time (within 2 h; confidence >= 0.9 OK,
  > = 0.5 LOW_CONFIDENCE). NEAR is OK only if a Coinbase 5-minute candle agrees within 150 bps; disagreeing -> no NEAR
  > price (the point is stored without TVL).
- A pool that did not exist yet, or whose tokens differ, is skipped and counted `missing`.
- Rows are ordinary `rhea_pool_observations` (`snapshot_id = backfill:<run time>`, `raw.backfill` names the source and
  the prices used). Re-runs skip targets with a stored point within 3 h. The window math and every check are unchanged:
  a window across a fee change or a volume decrease is still `DATA_INVALID`.
- Volume in USD over a window is valued at current prices, as for live windows.
