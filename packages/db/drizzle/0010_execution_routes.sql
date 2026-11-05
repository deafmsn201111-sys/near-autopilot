-- Shadow Gateway routing: venues quoted for an approved plan (or a reference probe) and the venue chosen.
-- Quotes only, nothing here was signed or sent. Additive only: a new table, nothing existing changes.
CREATE TABLE IF NOT EXISTS "execution_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"origin" text NOT NULL,
	"outcome" text NOT NULL,
	"decision_id" text,
	"intent_id" text,
	"plan_hash" text,
	"token_in" text,
	"token_out" text,
	"amount_in" text,
	"chosen_venue" text,
	"advantage_bps" integer,
	"reason" text NOT NULL,
	"quotes" jsonb NOT NULL,
	"data_source" text NOT NULL,
	"network" text NOT NULL,
	CONSTRAINT "execution_routes_origin_check" CHECK ("origin" IN ('gateway', 'probe')),
	CONSTRAINT "execution_routes_outcome_check" CHECK ("outcome" IN ('routed', 'no_route', 'not_a_swap', 'refused')),
	CONSTRAINT "execution_routes_chosen_check" CHECK (("outcome" = 'routed') = ("chosen_venue" IS NOT NULL)),
	CONSTRAINT "execution_routes_venue_check" CHECK ("chosen_venue" IS NULL OR "chosen_venue" IN ('rhea', 'near-intents-1click')),
	CONSTRAINT "execution_routes_amount_check" CHECK ("amount_in" IS NULL OR "amount_in" ~ '^[0-9]{1,40}$'),
	CONSTRAINT "execution_routes_data_source_check" CHECK ("data_source" IN ('chain', 'simulation')),
	CONSTRAINT "execution_routes_network_check" CHECK ("network" IN ('mainnet', 'testnet'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_routes_created_idx" ON "execution_routes" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_routes_origin_idx" ON "execution_routes" USING btree ("origin","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_routes_decision_idx" ON "execution_routes" USING btree ("decision_id");
