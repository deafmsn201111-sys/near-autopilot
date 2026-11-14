-- The latest 1Click swap status of each deposit quote and when it was seen (#29). Additive: two nullable columns.
ALTER TABLE "deposit_quotes" ADD COLUMN IF NOT EXISTS "status" text;
--> statement-breakpoint
ALTER TABLE "deposit_quotes" ADD COLUMN IF NOT EXISTS "status_at" timestamp with time zone;
