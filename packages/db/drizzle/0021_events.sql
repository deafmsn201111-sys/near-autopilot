-- What real users did through the app (#32): one row per connect, ownership proof, analysis, prepared cascade (with
-- its validateCascade verdict), RPC-confirmed signed transaction and 1Click quote. Account id only, never an IP.
-- Deleted after 30 days by the analytics API. Additive: one new table.
CREATE TABLE IF NOT EXISTS "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"account_id" text NOT NULL,
	"cascade_id" text,
	"intent" jsonb,
	"verdict" text,
	"checks" jsonb,
	"tx_hash" text,
	"source" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "events_kind_check" CHECK ("kind" IN ('connect', 'verified', 'analyse', 'prepare', 'prepare_blocked', 'signed', 'oneclick_quote', 'oneclick_final')),
	CONSTRAINT "events_source_check" CHECK ("source" IN ('client', 'server', 'rpc')),
	CONSTRAINT "events_verdict_check" CHECK ("verdict" IS NULL OR "verdict" IN ('ALLOW', 'BLOCK'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_account_at_idx" ON "events" USING btree ("account_id", "at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_at_idx" ON "events" USING btree ("at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_cascade_idx" ON "events" USING btree ("cascade_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_tx_hash_idx" ON "events" USING btree ("tx_hash");
