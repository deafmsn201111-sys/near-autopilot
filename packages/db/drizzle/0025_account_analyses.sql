-- The last AI analysis per account and strategy (#190), so the page shows it again after a reload or an API restart.
-- Served to the account's proven owner only. Deleted after 30 days by the analytics API. Additive: one new table.
CREATE TABLE IF NOT EXISTS "account_analyses" (
	"account_id" text NOT NULL,
	"strategy" text NOT NULL,
	"analysis_key" text NOT NULL,
	"signature" text,
	"at" timestamp with time zone NOT NULL,
	"analysis" jsonb NOT NULL,
	CONSTRAINT "account_analyses_pk" PRIMARY KEY ("account_id", "strategy")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "account_analyses_at_idx" ON "account_analyses" USING btree ("at");
