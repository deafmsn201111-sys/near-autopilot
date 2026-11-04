# Rhea / Ref v2 DCL: capability matrix

Package: `@near-autopilot/rhea-dcl-adapter`. This document says what was verified, against what, and what was not.
Where the evidence is weaker than "I read the source", the row says so.

## 1. What could and could not be verified

| Question                                                      | Answer                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the DCL **contract source** (Rust) verified?               | **No.** I could not locate a publicly readable contract repository (`ref-finance/ref-dcl` and several likely names fail anonymous `git ls-remote`). ABI claims below come from **consumer source code** (see tiers), not from the contract. |
| Are method names and argument names verified?                 | **Yes, to consumer-code level (tier A)** for every method marked implemented. Each is tied to a file and line in an official Rhea/Ref repository.                                                                                           |
| Does a deployed testnet contract really export these methods? | **Not checked from this sandbox** (egress to NEAR RPC is blocked by policy). `verifyDeployedAbi` does this check from the chain's own `view_code` and the live test runs it. Until you run it, "exists on testnet" is **unconfirmed**.      |
| Do testnet pools exist, and do they hold liquidity?           | **Unconfirmed.** No RPC access here. The pool ids that appear in sources are listed in section 7 as _leads_, not facts. The live test prints the real list.                                                                                 |
| Is the tick/liquidity math right?                             | **Yes, tested.** Exact port of the frontend's integer math; reproduces the published MIN/MAX sqrt-price constants and an on-chain `predict_add_liquidity` result bit for bit (section 5).                                                   |

### Evidence tiers

- **A** read in source of an official repository: `ref-finance/ref-sdk` @ `8dcb4fb` (2026-02-01) and `ref-finance/ref-ui` @ `1938efc` (2024-11-02), which is Rhea's production frontend code.
- **B** reported by a probe or third-party document, not seen in source.
- **C** method name only, arguments unknown.

Nothing implemented is tier C. Tier B items are called out.

## 2. Contract IDs

| Deployment        | Account                     | Evidence                                                                         |
| ----------------- | --------------------------- | -------------------------------------------------------------------------------- |
| mainnet           | `dclv2.ref-labs.near`       | A: ref-sdk `src/constant.ts:35`, ref-ui `src/services/config.ts:239`             |
| **testnet**       | `dclv2.ref-dev.testnet`     | A: ref-sdk `src/constant.ts:47` (`getConfig('testnet')`), ref-ui `config.ts:361` |
| testnet-dev       | `refv2-dev.ref-dev.testnet` | A: ref-sdk `src/constant.ts:59` (`'dev'`), ref-ui `config.ts:466`                |
| legacy testnet v1 | `dclv1.ref-dev.testnet`     | A: ref-ui `REF_UNI_SWAP_CONTRACT_ID` (migration reads only; **not used**)        |

**Conflicting testnet references.** Other testnet ids also appear in the same repositories, so the table above is the _current main config_, not the only answer in the sources:

| Account                    | Where                                                                                                         | Reading                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `dcl.ref-dev.testnet`      | ref-sdk `README.md:1334` (example output); ref-ui `src/pages/Orderly/config.ts:153` (separate Orderly module) | older name; main configs moved to `dclv2` |
| `mock-dcl.ref-dev.testnet` | ref-ui `src/pages/Orderly/config.ts:223` (dev block)                                                          | mock deployment for a side module         |

These are exported as `DCL_TESTNET_CANDIDATES` so `verifyDeployedAbi` can be run against every one of them. The live test accepts `RHEA_DCL_CONTRACT_ID` to point at any candidate. Which of them currently has code is **unknown** until that check runs. The README example also shows a `Swap` message without `referral_id`/`client_id`, which suggests those two fields are optional on the contract; the builders still send them (as the current SDK code does).

All three ids are constants, not discoveries. Whether each account currently has code deployed is checked by `verifyDeployedAbi` (section 8).

## 3. Method matrix

"Impl" is what this package exposes. "Tested" is how: **fixture** = synthetic data shaped from the source interfaces (proves argument names and parsing, not live behaviour), **live** = env-gated test against a node (not run in the build sandbox).

### View methods

| Method                                       | Args (exact)                                                     | Returns                 | Evidence                                            | Impl                                                   | Tested        |
| -------------------------------------------- | ---------------------------------------------------------------- | ----------------------- | --------------------------------------------------- | ------------------------------------------------------ | ------------- |
| `get_pool`                                   | `pool_id`                                                        | pool or null            | A ref-ui `swapV3.ts:557`                            | `getPool`                                              | fixture, live |
| `list_pools`                                 | none                                                             | pool[]                  | A `swapV3.ts:709`                                   | `listPools`                                            | fixture, live |
| `get_liquidity`                              | `lpt_id`                                                         | position                | A `swapV3.ts:1567`                                  | `getPosition`                                          | fixture       |
| `list_liquidities`                           | `account_id`                                                     | position[]              | A `swapV3.ts:1547`                                  | `listPositions`                                        | fixture       |
| `list_user_assets`                           | `account_id`                                                     | token→amount map        | A `swapV3.ts:1588`; value shape inferred            | `listInternalBalances`                                 | fixture       |
| `get_marketdepth`                            | `pool_id`, `depth`                                               | `{liquidities, orders}` | A `swapV3.ts:1597`, consumer `DclChart.tsx:497`     | `getMarketDepth`                                       | fixture, live |
| `get_pointorder_range`                       | `pool_id`, `left_point`, `right_point`                           | count data              | A `swapV3.ts:628`                                   | name listed, **not implemented** (return shape unread) | n/a           |
| `quote`                                      | `pool_ids`, `input_token`, `output_token`, `input_amount`, `tag` | `{amount, tag}`         | A ref-sdk `swap.ts` `quote`, ref-ui `swapV3.ts:102` | `quote`                                                | fixture, live |
| `quote_by_output`                            | `pool_ids`, `input_token`, `output_token`, `output_amount`       | `{amount, tag}`         | A `swapV3.ts:238`                                   | `quoteByOutput`                                        | fixture       |
| `get_order`                                  | `order_id`                                                       | order                   | A `swapV3.ts:468`                                   | `getOrder`                                             | fixture       |
| `find_order`                                 | `account_id`, `pool_id`, `point`                                 | order                   | A `swapV3.ts:483`, ref-sdk `limit-order.ts`         | `findOrder`                                            | fixture       |
| `list_active_orders` / `list_history_orders` | `account_id`                                                     | order[]                 | A `swapV3.ts:459,450`                               | same names                                             | fixture       |
| `get_user_storage_detail`                    | `user_id`                                                        | detail or null          | A `swapV3.ts:738`                                   | `getUserStorageDetail`                                 | fixture       |
| `storage_balance_of`                         | `account_id`                                                     | NEP-145 balance or null | A ref-sdk `ref.ts:242`                              | `getStorageBalance`                                    | fixture       |
| `get_metadata`                               | none                                                             | contract metadata       | A `swapV3.ts:1700`                                  | `getMetadata` (unparsed)                               | live          |
| `mft_balance_of`                             | `token_id`, `account_id`                                         | amount                  | A `swapV3.ts:1706`                                  | name listed, **not implemented**                       | n/a           |

### State-changing methods (built, not signed)

| Method                      | Args (exact)                                                                                                                                       | Gas / deposit                 | Evidence                                                                                                               | Builder                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| swap, exact in              | `ft_transfer_call` on token-in: `{receiver_id, amount, msg}`, `msg = {"Swap":{pool_ids, output_token, min_output_amount, referral_id, client_id}}` | 180 Tgas / 1 yocto            | A ref-sdk `swap.ts`                                                                                                    | `buildSwapExactIn`                         |
| swap, exact out             | `msg = {"SwapByOutput":{pool_ids, output_token, output_amount, referral_id, client_id}}`                                                           | same                          | A ref-sdk `swap.ts`                                                                                                    | `buildSwapExactOut`                        |
| limit order                 | `msg = {"LimitOrderWithSwap":{pool_id, buy_token, point, client_id, referral_id}}`                                                                 | same                          | A ref-sdk `swap.ts`                                                                                                    | `buildLimitOrder`, `orientLimitOrderPoint` |
| swap to stop point          | `msg = {"SwapByStopPoint":{pool_id, stop_point, referral_id[, skip_unwrap_near]}}`                                                                 | same                          | A ref-sdk `swap.ts`                                                                                                    | `buildSwapToStopPoint`                     |
| deposit to internal balance | `ft_transfer_call` with `msg = "\"Deposit\""`                                                                                                      | 150 Tgas / 1 yocto            | A ref-ui `swapV3.ts:793` ff.                                                                                           | `buildDeposit`                             |
| `add_liquidity`             | `pool_id, left_point, right_point, amount_x, amount_y, min_amount_x, min_amount_y`                                                                 | 150 Tgas / 0                  | A `swapV3.ts:793`                                                                                                      | `buildAddLiquidity`                        |
| `append_liquidity`          | `lpt_id, amount_x, amount_y, min_amount_x, min_amount_y`                                                                                           | 150 Tgas / 0                  | A `swapV3.ts:1075`                                                                                                     | `buildAppendLiquidity`                     |
| `remove_liquidity`          | `lpt_id, amount, min_amount_x, min_amount_y` (`amount` is **liquidity**, not tokens)                                                               | 150 Tgas / 0                  | A `swapV3.ts:1216`                                                                                                     | `buildRemoveLiquidity`                     |
| `burn_v_liquidity`          | `lpt_id`                                                                                                                                           | 100 Tgas / 0                  | A `swapV3.ts:1067`                                                                                                     | `buildBurnVirtualLiquidity`                |
| `withdraw_asset`            | `token_id`                                                                                                                                         | 100 Tgas / 0                  | A `swapV3.ts:1382`                                                                                                     | `buildWithdrawAssets`                      |
| `cancel_order`              | `order_id, amount` (`"0"` claims proceeds)                                                                                                         | 180 Tgas / 0                  | A ref-sdk `limit-order.ts`                                                                                             | `buildCancelOrder`, `buildClaimOrder`      |
| `create_pool`               | `token_a, token_b, fee, init_point`                                                                                                                | 180 Tgas / 0.1 NEAR           | A `swapV3.ts:693`                                                                                                      | `buildCreatePool`                          |
| `storage_deposit` (DCL)     | `registration_only, account_id`                                                                                                                    | 30 Tgas / 0.5 NEAR first time | A ref-sdk `swap.ts` (args, 30 Tgas, 0.5 NEAR); ref-ui `get_user_storage_detail` returns `'0.5'` for first registration | `buildDclStorageDeposit`                   |

### Deliberately not implemented

| Method                                                                                              | Why                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batch_add_liquidity`, `batch_remove_liquidity`, `batch_update_liquidity`, `batch_burn_v_liquidity` | Outer arg names are seen (`add_liquidity_infos`, `remove_liquidity_infos`) but the element type (`IAddLiquidityInfo`) is defined outside the code I could read. Guessing it would be inventing it.                                      |
| `predict_add_liquidity`                                                                             | **Tier B only.** I have one observed on-chain result for it (section 5) but no consumer source for its arguments. Local `computeLiquidity` replaces it, and it matches that result.                                                     |
| `get_pointorder_range`, `mft_balance_of`                                                            | Names and args known, return shapes unread.                                                                                                                                                                                             |
| Pagination for `list_pools`                                                                         | Consumers call it with no arguments. One earlier source claimed large deployments need paging; I found no argument names for it, so none are invented. If the call exceeds the view gas limit you get an error, never a truncated list. |

## 4. Position representation

- A position is an NFT-like record keyed by `lpt_id` = `<pool_id>#<index>` (A: ref-ui `Farms.tsx:1074`, `YourLiquidityV2.tsx:238` split on `#`).
- Fields (A: ref-ui `commonV3.ts:129`): `lpt_id, owner_id, pool_id, left_point, right_point, amount` (liquidity units), `unclaimed_fee_x, unclaimed_fee_y`, optional `mft_id`, `v_liquidity` (virtual-LP / farming link).
- Range is half-open `[left_point, right_point)`; both ends are multiples of the pool's `point_delta` (frontend always snaps; the adapter enforces it before building `add_liquidity`).
- Orders are separate records keyed `order_id` (`<pool_id>#<n>`), see `UserOrderInfo` in ref-sdk `limit-order.ts`.
- Funds live in an **internal balance** on the DCL contract: deposit (`ft_transfer_call "Deposit"`) → `add_liquidity` spends internal balance; `remove_liquidity` credits it; `withdraw_asset` moves it to the wallet. Read it with `list_user_assets`.

## 5. Tick math and liquidity

Pool id: `tokenX|tokenY|fee`, tokens sorted lexicographically (A: ref-sdk `getDCLPoolId`). Fee tiers `100, 400, 2000, 10000` (units of 1/1,000,000) map to `point_delta` `1, 8, 40, 200` (A: ref-sdk `feeToPointDelta`). Points are clamped to `[-800000, 800000]`.

- `undecimal price = 1.0001^point` = raw Y per raw X. `decimal price (X in Y) = undecimal × 10^(decimalsX − decimalsY)`.
- `sqrtPriceX96(point)` is the exact integer table from ref-ui `compute_liquidity.ts` (19 Q128 constants, **extracted by script, not retyped**), rounded up.
- Per-unit deposit and `computeLiquidity` are ports of `compute_deposit_xy_per_unit` and `compute_liquidity`.

Cross-checks that run in the test suite:

1. `sqrtPriceX96(-800000) = 337263108622` and `sqrtPriceX96(800000) = 18611883644907511909590774894315720731532604461`: the two constants ref-ui documents beside the table.
2. SDK price vector: 0.9 USDT (6 dec) ↔ 4.89454792 wNEAR (24 dec), fee 400 → point `431416`; decimal price at that point `5.43528191708623` (**tier B** source for the numbers).
3. **On-chain vector (tier B):** pool `usdc.fakes.testnet|wrap.testnet|2000`, range `[288680, 289000)`, `amount_x = 1000000`, `amount_y = 1e24`; `predict_add_liquidity` returned `liquidity_amount = 5842542192, need_x = 1000000, need_y = 0`. `computeLiquidity` returns exactly `5842542192` and `requiredDepositForLiquidity` exactly `{x: 1000000, y: 0}`, for any current point below the range.
4. A property test over ~300 range/amount combinations checks that the deposit implied by the computed liquidity never exceeds the supplied amounts.

Limits of this math:

- Display prices use `Math.pow`/`Math.log` (as the SDK does). Amounts never do.
- One deliberate deviation from the frontend: it computes `amount_y − 1` unguarded (negative for `amount_y = 0`). The adapter returns 0 liquidity instead.
- `requiredDepositForLiquidity` is the **deposit** side (ceil). The contract's withdrawal-side rounding was not readable, so valuing an existing position with it is an estimate off by at most a few raw units.

## 6. Token decimals

The DCL contract stores raw integer amounts only; it has no decimals field. Decimals come from each token's NEP-141 `ft_metadata` (the repo's `TokenReader` port). Example decimals seen in the SDK vector: USDT 6, wNEAR 24. Read them, don't hardcode them. `pointToDecimalPrice` and `decimalPriceToPoint` take both decimals explicitly.

## 7. Supported testnet pools

**Nothing here is confirmed live.** Leads from sources:

| Pool id                                  | Where it appears                                | Status                                                    |
| ---------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `usdc.fakes.testnet\|wrap.testnet\|2000` | on-chain `predict_add_liquidity` probe (tier B) | pool existed when probed; liquidity unconfirmed           |
| `usdt.fakes.testnet\|wrap.testnet\|2000` | swap message examples (tier B)                  | unconfirmed                                               |
| `usdt.fakes.testnet\|wrap.testnet\|100`  | ref-ui `DCL_POOL_BLACK_LIST` for testnet (A)    | existed at some point and ref-ui **hides** it; do not use |

To get the real answer:

```bash
RHEA_DCL_LIVE=1 RHEA_DCL_RPC_URL=<testnet rpc> pnpm --filter @near-autopilot/rhea-dcl-adapter test:live
```

It prints every pool with `fee, point_delta, current_point, state, liquidity, total_x, total_y`, and reports the count of pools with non-zero liquidity. It never asserts that liquidity exists.

## 8. Verifying a deployment yourself

`verifyDeployedAbi(rpc, contractId)` calls `query / view_code`, parses the WASM export section, and lists any source-verified method the deployment does not export. This proves **names**, not argument shapes. Argument shapes are proven only by the live parse of real responses (strict Zod schemas fail closed) and by a signed dry run on testnet.

## 9. Known gaps and risks

1. No contract source: argument _types_ for write calls rest on consumer code. A mismatch would surface as a failed transaction on testnet, which is why the policy engine's dry-run default stays on.
2. Schemas were derived from TypeScript interfaces, which mark many fields optional. Only fields the frontend always reads are required; the live test is the first check against real JSON.
3. Limit-order point orientation follows ref-sdk (negate when the sold token is not X). The SDK's own snapping happens before negation, so negated points are not guaranteed to be multiples of the delta; `buildLimitOrder` checks range but not alignment for that reason.
4. Gas and attached-deposit values are copied from the frontend and are not minimums.
5. This package builds transactions. It does not sign or broadcast; those stay with the existing `TransactionSigner` / policy engine path, and the API currently has no signer wired (by design).
6. The existing `rhea-adapter` targets the **v1 AMM** (`v2.ref-finance.near`, `get_return`, `force/actions` swap messages). The DCL adapter is separate and is not yet wired into the agents or API.
