# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: a real DeFi user with their own NEAR wallet.** They hold tokens, a Burrow loan, Rhea liquidity or liquid staking. They come to answer:
  - "Am I safe?"
  - "Is my money working?"
  - "What should I do, and what does it cost?"

  Then they act by signing in their own wallet. Every design trade-off is decided for this person first.

- **Secondary: a first-time visitor or hackathon judge** with about a minute and often no wallet. They are served by a first-visit layer:
  - the demo portfolios;
  - how it works and why you can trust it;
  - "See a real wallet".

  There is no separate product for them. Hackathon criteria value real usefulness, so a judge evaluates the product as a user would.

## Product Purpose

NEAR Autopilot is an AI DeFi analyst for NEAR mainnet:

1. It reads a real portfolio: balances, Burrow lending, Rhea v1/DCL liquidity, liquid staking.
2. Agents check loan safety, concentration, idle money and liquidity ranges.
3. It ranks what to do, with numbers after costs.
4. It builds the exact unsigned transaction for the user to sign in their own wallet.

Success means the user understands their position, trusts the numbers and acts with confidence. When doing nothing is the right answer, it says so and shows the work behind it.

## Positioning

An advisor that never holds your keys. The server cannot sign:

- every cascade passes an independent validator (allowed receivers and methods, gas and amount caps);
- the user sees every call before signing;
- the model can only propose, and code checks its ranking.

Trust is the product. Transparency surfaces carry the claim: provenance on every number, the exact calls, the decision pipeline, and the blocked-attack demo.

## Operating Context

The core loop:

1. Connect a wallet, or view a demo or any mainnet account read-only.
2. Read the analysis: verdict, agents, strategy.
3. Review a suggestion.
4. Sign in the wallet (HOT Connector / HOT Kit).
5. See the result and a re-check.

Cross-chain deposit and withdrawal go through 1Click. With HOT Kit, EVM and Solana wallets connect for funding. Balances on other chains are shown but not analysed.

Three account contexts must never be confused:

- **Demo**: simulated.
- **Read-only lookup**: rules only, preview only.
- **Your wallet**: AI analysis after ownership is verified by signature; signing.

## Capabilities and Constraints

- Mainnet only. No autonomy: signing happens only in the user's wallet (D8).
- AI analysis only for a verified owner. Other accounts get rule-based checks.
- Intents with UI: supply, repay (including from or with collateral), withdraw, swap, reposition and recentre DCL. Borrow, unwrap and add_liquidity exist without UI.
- Strategy presets (Conservative / Balanced / Aggressive) change thresholds and therefore every recommendation.
- Coming next, the design system must accommodate:
  - one HOT Kit connector for all chains (#189);
  - EVM/Solana deposit with a connected wallet (#126);
  - withdraw via 1Click (#171);
  - Google sign-in (#172);
  - looping (#88);
  - idle-token ranking (#194, #196);
  - market signals (#105);
  - possibly a multichain analyst later.
- The interface is English. Amounts are exact on-chain values, never floats.
- Undecided: final product name (#76). Treat "NEAR Autopilot" as replaceable in one place.

## Brand Commitments

- Name for now: **NEAR Autopilot** (hackathon and domain near-autopilot.tech). It may be renamed later, so the brand must not depend on it.
- Do not imitate NEAR Foundation's own marks. NEAR is the ecosystem, not our identity.
- No hype, no gamification, no invented numbers. Calm, exact and honest, including about losses and price impact.

## Evidence on Hand

- Live product: near-autopilot.tech, with real mainnet data.
- The UX prototype `docs/design/portfolio-ux-prototype.html`, approved in direction by the owner on 14 Nov 2026.
- The blocked-attack demo on `/policy`.
- Token icons: about 180 Ref-whitelisted NEP-148 icons on `origin/feat/test-ui-ux` (`public/token-icons`), safe to reuse.
- No logo yet: the teammate's raster wordmark is not used.
- No testimonials, customers or usage numbers exist. Never invent them.

## Product Principles

1. **Answer first.** Verdict, safety and money before settings and detail.
2. **Show the work.** Every conclusion, including "do nothing", shows what was checked, by whom, and with which numbers.
3. **Never hide the cost.** Fees, price impact and loss sit at the same weight as gains.
4. **The signature is sacred.** One distinct, unmistakable path to signing, with the exact calls one click away.
5. **Context is explicit.** Demo, read-only and your wallet are told apart in words, not only colour.

## Accessibility & Inclusion

WCAG 2.2 AA in both themes:

- contrast;
- visible focus;
- keyboard;
- reduced motion;
- touch targets ≥ 24px, aiming for 44px;
- status never by colour alone.
