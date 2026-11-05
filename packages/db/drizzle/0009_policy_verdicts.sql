-- Policy verdicts: every decision with all checks, policy version, snapshot id and its replayable inputs.
-- Additive only: a new table, nothing existing changes.
CREATE TABLE IF NOT EXISTS "policy_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"engine" text NOT NULL,
	"run_id" text,
	"intent_id" text NOT NULL,
	"intent_kind" text NOT NULL,
	"verdict" text NOT NULL,
	"outcome" text NOT NULL,
	"policy_version" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"plan_hash" text NOT NULL,
	"value_usd_micro" text,
	"checks" jsonb NOT NULL,
	"violations" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"data_source" text NOT NULL,
	"network" text NOT NULL,
	CONSTRAINT "policy_verdicts_engine_check" CHECK ("engine" IN ('legacy', 'orchestrator')),
	CONSTRAINT "policy_verdicts_verdict_check" CHECK ("verdict" IN ('ALLOW', 'WARN', 'BLOCK')),
	CONSTRAINT "policy_verdicts_outcome_check" CHECK ("outcome" IN ('approve', 'require_approval', 'reject')),
	CONSTRAINT "policy_verdicts_consistent_check" CHECK (
		("verdict" = 'ALLOW' AND "outcome" = 'approve') OR
		("verdict" = 'WARN' AND "outcome" = 'require_approval') OR
		("verdict" = 'BLOCK' AND "outcome" = 'reject')
	),
	CONSTRAINT "policy_verdicts_data_source_check" CHECK ("data_source" IN ('chain', 'simulation')),
	CONSTRAINT "policy_verdicts_network_check" CHECK ("network" IN ('mainnet', 'testnet'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_verdicts_evaluated_idx" ON "policy_verdicts" USING btree ("evaluated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_verdicts_intent_idx" ON "policy_verdicts" USING btree ("intent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "policy_verdicts_verdict_idx" ON "policy_verdicts" USING btree ("verdict","evaluated_at");
