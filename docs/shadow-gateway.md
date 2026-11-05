# Shadow Gateway and best execution

The Shadow Gateway is the execution boundary of every dry-run deployment (`apps/api/src/gateway/`). It replaces the
plain dry-run executor in both engines (legacy cycle and orchestrator). It holds **no signer** and has no way to obtain
one: its only effect is a row in `execution_routes`. Mainnet stays read-only.

## What each verdict leads to

| Verdict | What happens                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| BLOCK   | The cycle stops at the verdict. No approval exists, so nothing reaches the gateway.                          |
| WARN    | The proposal waits for a human (`requires_approval`). No approval is minted, so nothing reaches the gateway. |
| ALLOW   | The gateway re-checks everything, quotes the venues, records the best execution and returns `dry_run`.       |

For ALLOW the gateway refuses (`status: rejected`, row with `outcome: refused`) on the first failed check:

1. **The stored verdict.** `policy_verdicts` must hold an ALLOW verdict for this decision id that names this exact
   plan hash. A decision that was never persisted, a WARN/BLOCK, or an ALLOW for another plan does not pass.
2. **The approval itself**, by the wrapped dry-run executor: minted by the policy engine (a structural copy is not),
   unexpired, plan bytes unchanged since approval, not used before.

Tests: `apps/api/test/gateway.test.ts` (missing verdict, WARN, BLOCK, other plan, forged approval, replay, no signer
in the module) and `apps/api/test/simulation.test.ts` (ALLOW reaches the gateway, BLOCK never does, in both engines).

## Venues

| Venue                 | How it is quoted                                                                   | Settlement                                    |
| --------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `rhea`                | `get_return` view on the plan's own pool (#4512 wNEAR/USDC in the shadow config)   | atomic: one `ft_transfer_call`                |
| `near-intents-1click` | `POST /v0/quote` with `dry: true` (a constant of the client), no JWT, mainnet only | async: deposit, then a solver settles/refunds |

- **Rhea** is quoted only on operator-configured pools (`config.rhea.pools`). A plan naming any other pool gets no Rhea
  quote.
- **1Click** dry quotes carry no deposit address. An answer that has one anyway is refused and never read. Without a
  JWT, 1Click adds its own app fee (20 bps at the time of writing). The fee is already inside `amountOut` and is
  recorded as `feeBps`. Quotes take 5–25 s.
- **1Click privacy:** it receives the token pair, the amount and the configured account id (`AUTOPILOT_ACCOUNT_ID`,
  `shadow-demo.near` in the shadow profile). Nothing else is sent.
- **Turning 1Click off:** set `ONE_CLICK_URL=` (empty).

## Choosing the route

`chooseRoute` in `best-execution.ts` is pure and deterministic. It ranks venues by **net USD received**: the venue's
output value minus the gas the user would attach.

**How gas is costed:** an upper bound, attached gas × the current gas price (RPC `gas_price`). Refunds are not counted.

| Venue  | Gas costed                            |
| ------ | ------------------------------------- |
| Rhea   | the plan's 180 Tgas                   |
| 1Click | 30 Tgas for the `ft_transfer` deposit |

1Click is not charged for a possible `storage_deposit` of its deposit address. Both venues are costed by upper bounds,
and 180 Tgas is far above what a Rhea swap actually burns. So **small trades are biased against Rhea**. Read the
recorded `gasUsdMicro` next to `outUsdMicro`.

**When a quote is excluded** (recorded, never patched):

- the quote failed;
- the quoted output is zero;
- the quote is older than `policy.maxPriceAgeSeconds` (180 s);
- it pays more than `policy.maxOracleDeviationBps` (150 bps) below the oracle-implied output;
- prices are missing. Without input, output and NEAR prices, or without a gas price, nothing is valued and **no venue
  is chosen**. Gas is never treated as free.

**Ties** go to the atomic venue.

No new thresholds were introduced: the limits are the policy's own `maxPriceAgeSeconds`, `maxOracleDeviationBps` and
`maxSlippageBps`, the last of which is passed to 1Click as `slippageTolerance`.

## Reference probe

An agent rarely proposes a swap. So every shadow-collector cycle also quotes two reference trades: $10 and $100 of
wNEAR → USDC on pool #4512. They use the same venues and the same rule, at the cycle's pinned block and on the cycle's
prices.

- Rows are stored with `origin: probe`.
- In collector cycles the source is listed as `routes.probe`. It is `degraded` when a size found no route.

## Reading the records

```bash
curl -s -H "authorization: Bearer $API_TOKEN" 'http://127.0.0.1:4002/v1/routes?origin=probe&limit=10'
```

Every row returns `executed: false`. The `quotes` field holds each venue's quote and score: output, gas, net, oracle
deviation and the exclusion reason. The table is append-only (migration `0010_execution_routes`, additive).

The database rejects:

- a `routed` row without a venue;
- a non-routed row that names a venue;
- any venue other than the two above.
