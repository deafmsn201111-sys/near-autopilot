CREATE TABLE IF NOT EXISTS "yield_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"network" text NOT NULL,
	"block_height" integer NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"contract" text NOT NULL,
	"methods" jsonb NOT NULL,
	"market_id" text NOT NULL,
	"asset_ids" jsonb NOT NULL,
	"yield_type" text NOT NULL,
	"apr" text,
	"apy" text,
	"calculation_method" text NOT NULL,
	"formula" text,
	"observation_period_seconds" integer,
	"utilization" text,
	"liquidity_usd" text,
	"volume_usd" text,
	"price_status" text NOT NULL,
	"source_timestamp" timestamp with time zone,
	"validation_status" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	CONSTRAINT "yield_observations_network_check" CHECK ("network" = 'testnet'),
	CONSTRAINT "yield_observations_source_check" CHECK ("source" IN ('burrow', 'rhea_v1', 'rhea_dcl')),
	CONSTRAINT "yield_observations_type_check" CHECK ("yield_type" IN ('lending_supply', 'lending_borrow', 'lp_fee')),
	CONSTRAINT "yield_observations_validation_check" CHECK ("validation_status" IN ('valid', 'rejected', 'informational')),
	CONSTRAINT "yield_observations_borrow_not_yield_check" CHECK ("yield_type" <> 'lending_borrow' OR "validation_status" = 'informational')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "yield_observations_observed_idx" ON "yield_observations" USING btree ("observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "yield_observations_market_idx" ON "yield_observations" USING btree ("source","market_id","observed_at");
