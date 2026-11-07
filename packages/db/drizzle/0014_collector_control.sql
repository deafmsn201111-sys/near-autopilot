-- Operator pause of the scheduled market collection (read-only data collection; it never executes anything).
-- Additive: one new single-row table. Every change is also written to the audit chain by the API that makes it.
CREATE TABLE IF NOT EXISTS "collector_control" (
	"id" text PRIMARY KEY NOT NULL,
	"paused" boolean NOT NULL,
	"reason" text NOT NULL,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"version" bigint NOT NULL,
	CONSTRAINT "collector_control_single_row" CHECK ("id" = 'default')
);
