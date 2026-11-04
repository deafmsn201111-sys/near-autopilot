CREATE TABLE IF NOT EXISTS "market_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"market_network" text NOT NULL,
	"execution_network" text NOT NULL,
	"testnet_token" text NOT NULL,
	"reference_symbol" text NOT NULL,
	"mainnet_contract" text NOT NULL,
	"status" text NOT NULL,
	"price_usd" text,
	"source" text,
	"source_asset_id" text,
	"published_at" timestamp with time zone,
	"age_ms" integer,
	"spread_bps" integer,
	"reason" text,
	"observations" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	CONSTRAINT "market_prices_market_network_check" CHECK ("market_network" = 'mainnet'),
	CONSTRAINT "market_prices_execution_network_check" CHECK ("execution_network" = 'testnet')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_prices_fetched_idx" ON "market_prices" USING btree ("fetched_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_prices_token_idx" ON "market_prices" USING btree ("testnet_token","fetched_at");
