CREATE TABLE IF NOT EXISTS "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"snapshot" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"account_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"reason" text NOT NULL,
	"intent" jsonb NOT NULL,
	"value_usd_micro" bigint,
	"status" text NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_hash" text,
	"execution_mode" text,
	"tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"run_id" text,
	"proposal_id" text,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposals" ADD CONSTRAINT "proposals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runs_started_at_idx" ON "runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_run_idx" ON "proposals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_account_status_created_idx" ON "proposals" USING btree ("account_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_proposal_idx" ON "audit_events" USING btree ("proposal_id");
