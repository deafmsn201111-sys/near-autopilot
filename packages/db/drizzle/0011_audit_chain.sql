-- Audit hash chain in the database: every new audit_events row carries its chain, sequence number, the previous
-- entry's hash and its own hash. Additive: four nullable columns (rows written before this stay unchained), a CHECK,
-- a unique (chain, seq) index so a chain can never fork, and a trigger that refuses UPDATE / DELETE of chained rows.
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "chain" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "seq" bigint;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "prev_hash" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "hash" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_chain_check" CHECK (
	("chain" IS NULL AND "seq" IS NULL AND "prev_hash" IS NULL AND "hash" IS NULL) OR
	("chain" IS NOT NULL AND "seq" >= 1 AND "prev_hash" ~ '^[0-9a-f]{64}$' AND "hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_events_chain_seq_uq" ON "audit_events" USING btree ("chain","seq") WHERE "chain" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "audit_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only: chained entry % of % cannot be changed or deleted', OLD.seq, OLD.chain;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "audit_events_append_only" BEFORE UPDATE OR DELETE ON "audit_events"
	FOR EACH ROW WHEN (OLD."chain" IS NOT NULL) EXECUTE FUNCTION "audit_events_append_only"();
