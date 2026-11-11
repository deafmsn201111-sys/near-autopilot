-- Spend tracking for the central LLM (#21): one row per analysis that reached the model, deleted after 7 days by the
-- analytics API, and a single-row settings table whose cap overrides LLM_DAILY_CAP_USD. Additive: two new tables.
CREATE TABLE IF NOT EXISTS "llm_calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"account_id" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_micro_usd" bigint NOT NULL,
	"latency_ms" integer NOT NULL,
	"tools" jsonb NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "llm_calls_tokens_check" CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost_micro_usd" >= 0),
	CONSTRAINT "llm_calls_outcome_check" CHECK ("outcome" IN ('ok', 'cap', 'model_error', 'invalid_output', 'empty', 'deadline', 'loop_limit'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_calls_at_idx" ON "llm_calls" USING btree ("at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"daily_cap_micro_usd" bigint,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "llm_settings_single_row" CHECK ("id" = 1),
	CONSTRAINT "llm_settings_cap_check" CHECK ("daily_cap_micro_usd" IS NULL OR "daily_cap_micro_usd" >= 0)
);
