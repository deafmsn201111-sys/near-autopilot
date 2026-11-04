ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "data_source" text DEFAULT 'chain' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "network" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "data_source" text DEFAULT 'chain' NOT NULL;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "network" text;
