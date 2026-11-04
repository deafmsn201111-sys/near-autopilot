-- Autonomous shadow collector (mainnet READ-ONLY analytics). Additive only: new tables, one defaulted column.
ALTER TABLE "yield_observations" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'on_demand' NOT NULL;
--> statement-breakpoint
ALTER TABLE "yield_observations" ADD CONSTRAINT "yield_observations_origin_check" CHECK ("origin" IN ('scheduled', 'on_demand'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "collector_cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"records" integer DEFAULT 0 NOT NULL,
	"sources" jsonb NOT NULL,
	"error" text,
	"snapshot_id" text,
	"registry_scan" boolean DEFAULT false NOT NULL,
	CONSTRAINT "collector_cycles_trigger_check" CHECK ("trigger" IN ('scheduled', 'on_demand')),
	CONSTRAINT "collector_cycles_status_check" CHECK ("status" IN ('running', 'success', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collector_cycles_started_idx" ON "collector_cycles" USING btree ("started_at");
--> statement-breakpoint
-- At most one cycle runs at a time, across every process (the collector and any on-demand trigger).
CREATE UNIQUE INDEX IF NOT EXISTS "collector_cycles_one_running" ON "collector_cycles" USING btree ("status") WHERE "status" = 'running';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"cycle_id" text NOT NULL,
	"network" text NOT NULL,
	"block_height" integer NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"market_report_id" text,
	"yield_report_id" text,
	"summary" jsonb NOT NULL,
	CONSTRAINT "market_snapshots_network_check" CHECK ("network" = 'mainnet')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_snapshots_taken_idx" ON "market_snapshots" USING btree ("taken_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_snapshots_block_idx" ON "market_snapshots" USING btree ("block_height");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"asset" text NOT NULL,
	"source" text NOT NULL,
	"source_asset_id" text NOT NULL,
	"price_usd" text,
	"quote_currency" text NOT NULL,
	"confidence" text,
	"published_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"age_ms" integer,
	"status" text NOT NULL,
	"reason" text,
	CONSTRAINT "price_observations_source_check" CHECK ("source" IN ('pyth', 'defillama'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_observations_asset_idx" ON "price_observations" USING btree ("asset","observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_observations_snapshot_idx" ON "price_observations" USING btree ("snapshot_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rhea_pools" (
	"pool_key" text PRIMARY KEY NOT NULL,
	"contract" text NOT NULL,
	"family" text NOT NULL,
	"pool_type" text NOT NULL,
	"tokens" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_block_height" integer NOT NULL,
	"fee_bps" integer,
	"tvl_usd" text,
	"price_quality" text NOT NULL,
	"category" text NOT NULL,
	"model_status" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"latest" jsonb NOT NULL,
	CONSTRAINT "rhea_pools_family_check" CHECK ("family" IN ('v1', 'dcl'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rhea_pools_category_idx" ON "rhea_pools" USING btree ("category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rhea_pools_family_idx" ON "rhea_pools" USING btree ("family");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rhea_pool_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"pool_key" text NOT NULL,
	"block_height" integer NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"reserves" jsonb NOT NULL,
	"volumes_in" jsonb,
	"fee_bps" integer,
	"admin_fee_bps" integer,
	"tvl_usd" text,
	"price_quality" text NOT NULL,
	"quality" text NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rhea_pool_observations_pool_idx" ON "rhea_pool_observations" USING btree ("pool_key","block_timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rhea_pool_observations_snapshot_idx" ON "rhea_pool_observations" USING btree ("snapshot_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rhea_pool_observations_unique" ON "rhea_pool_observations" USING btree ("pool_key","block_height");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "burrow_markets" (
	"token" text PRIMARY KEY NOT NULL,
	"contract" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"latest" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "burrow_market_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"token" text NOT NULL,
	"block_height" integer NOT NULL,
	"block_timestamp" timestamp with time zone NOT NULL,
	"supply_apr" text,
	"borrow_apr" text,
	"utilization" text,
	"available_usd" text,
	"reward_apr" text,
	"quality" text NOT NULL,
	"raw" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "burrow_market_observations_token_idx" ON "burrow_market_observations" USING btree ("token","block_timestamp");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "burrow_market_observations_unique" ON "burrow_market_observations" USING btree ("token","block_height");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portfolio_analyses" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"portfolio_id" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"outcome" text,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portfolio_analyses_snapshot_idx" ON "portfolio_analyses" USING btree ("snapshot_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portfolio_analyses_unique" ON "portfolio_analyses" USING btree ("snapshot_id","portfolio_id");
