-- Real 1Click quotes for inbound deposits (#27), one row per deposit address shown to a user, deleted after 30 days by
-- the analytics API. Additive: one new table.
CREATE TABLE IF NOT EXISTS "deposit_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"account_id" text NOT NULL,
	"origin_asset" text NOT NULL,
	"destination_asset" text NOT NULL,
	"amount_in" text NOT NULL,
	"amount_out" text NOT NULL,
	"min_amount_out" text NOT NULL,
	"refund_to" text NOT NULL,
	"deposit_address" text NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"correlation_id" text NOT NULL,
	"signature" text NOT NULL,
	"fee_bps" integer,
	CONSTRAINT "deposit_quotes_amounts_check" CHECK ("amount_in" ~ '^[0-9]+$' AND "amount_out" ~ '^[0-9]+$' AND "min_amount_out" ~ '^[0-9]+$'),
	CONSTRAINT "deposit_quotes_fee_check" CHECK ("fee_bps" IS NULL OR ("fee_bps" >= 0 AND "fee_bps" <= 10000))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposit_quotes_created_at_idx" ON "deposit_quotes" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deposit_quotes_deposit_address_idx" ON "deposit_quotes" USING btree ("deposit_address");
