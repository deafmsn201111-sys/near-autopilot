-- Durable orchestrator state (was in process memory). Additive: four new tables, nothing existing changes.
--   orchestrator_control          current operating mode per scope (one row), with an optimistic-concurrency version
--   orchestrator_control_history  every change of that row, append-only (trigger), linked to its audit entry
--   orchestrator_cycles           cycle-level idempotency: one row per (scope, cycle key); claimed atomically
--   orchestrator_actions          action-level idempotency: one row per (scope, action key, decision id)
-- A scope is one deployment and portfolio, e.g. "chain:testnet:alice.testnet" or "simulation:mainnet:x:demo-500".
CREATE TABLE IF NOT EXISTS "orchestrator_control" (
	"scope" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"reason" text NOT NULL,
	"since" timestamp with time zone NOT NULL,
	"changed_by" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"blind_cycles" integer DEFAULT 0 NOT NULL,
	"quarantined" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"audit_chain" text,
	"audit_seq" bigint,
	CONSTRAINT "orchestrator_control_mode_check" CHECK ("mode" IN ('normal', 'risk_reduction_only', 'read_only')),
	CONSTRAINT "orchestrator_control_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orchestrator_control_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"version" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"previous_mode" text,
	"mode" text NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"state" jsonb NOT NULL,
	"audit_chain" text,
	"audit_seq" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orchestrator_control_history_scope_version_uq" ON "orchestrator_control_history" USING btree ("scope","version");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "orchestrator_control_history_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'orchestrator_control_history is append-only (scope %, version %)', OLD.scope, OLD.version;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "orchestrator_control_history_append_only" BEFORE UPDATE OR DELETE ON "orchestrator_control_history"
	FOR EACH ROW EXECUTE FUNCTION "orchestrator_control_history_append_only"();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orchestrator_cycles" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"execution_started_for" text,
	"summary" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "orchestrator_cycles_pk" PRIMARY KEY ("scope","key"),
	CONSTRAINT "orchestrator_cycles_state_check" CHECK ("state" IN ('in_progress', 'completed', 'needs_reconciliation'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orchestrator_cycles_in_doubt_idx" ON "orchestrator_cycles" USING btree ("scope") WHERE "execution_started_for" IS NOT NULL AND "state" <> 'completed';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orchestrator_actions" (
	"scope" text NOT NULL,
	"action_key" text NOT NULL,
	"decision_id" text NOT NULL,
	"kind" text NOT NULL,
	"cycle_key" text NOT NULL,
	"status" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"tx_hash" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "orchestrator_actions_pk" PRIMARY KEY ("scope","action_key","decision_id"),
	CONSTRAINT "orchestrator_actions_status_check" CHECK ("status" IN ('in_flight', 'executed', 'dry_run', 'failed', 'pending_approval', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orchestrator_actions_scope_at_idx" ON "orchestrator_actions" USING btree ("scope","at");
