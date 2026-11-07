-- The simulated ledger of the demo portfolios: every action the agent carried out on a demo portfolio as a DRY RUN
-- (dashboard "let the agent do it"), so the simulated balances follow what was done. Additive: one new table.
-- Nothing here is chain data; a `reset` entry starts the portfolio again from its base amounts.
CREATE TABLE IF NOT EXISTS "demo_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"portfolio" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"asset" text,
	"amount_raw" text NOT NULL,
	"usd" double precision,
	"request_id" text,
	"by" text NOT NULL,
	CONSTRAINT "demo_ledger_kind_check" CHECK ("kind" IN ('repay', 'supply', 'reset')),
	CONSTRAINT "demo_ledger_asset_check" CHECK ("asset" IS NULL OR "asset" IN ('near', 'usdt')),
	CONSTRAINT "demo_ledger_portfolio_check" CHECK ("portfolio" IN ('demo-500', 'demo-5000'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "demo_ledger_portfolio_idx" ON "demo_ledger" USING btree ("portfolio","id");
