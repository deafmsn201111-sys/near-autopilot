-- Admin controls of the central LLM (#31): the kill switch and the deposit balance the owner types in for the run-out
-- forecast, on the single llm_settings row. Additive: new columns with safe defaults.
ALTER TABLE "llm_settings" ADD COLUMN IF NOT EXISTS "llm_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_settings" ADD COLUMN IF NOT EXISTS "deposit_micro_usd" bigint;
--> statement-breakpoint
ALTER TABLE "llm_settings" ADD COLUMN IF NOT EXISTS "deposit_set_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "llm_settings" DROP CONSTRAINT IF EXISTS "llm_settings_deposit_check";
--> statement-breakpoint
ALTER TABLE "llm_settings" ADD CONSTRAINT "llm_settings_deposit_check" CHECK ("deposit_micro_usd" IS NULL OR "deposit_micro_usd" > 0);
