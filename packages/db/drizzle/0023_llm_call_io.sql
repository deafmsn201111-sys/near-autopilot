-- What each model run was offered and what it answered (#33), for the admin LLM quality screen. Kept 7 days with the
-- row. Additive: two nullable columns.
ALTER TABLE "llm_calls" ADD COLUMN IF NOT EXISTS "input" jsonb;
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN IF NOT EXISTS "output" jsonb;
