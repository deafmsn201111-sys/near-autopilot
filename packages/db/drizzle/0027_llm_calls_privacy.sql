-- The TEE signature check of each answered run (#233): verified or not, why, and the NEAR AI chat ids. Additive:
-- one nullable column.
ALTER TABLE "llm_calls" ADD COLUMN IF NOT EXISTS "privacy" jsonb;
