-- Signed audit checkpoints. Additive: one new append-only table. Each row is a statement, signed with an ed25519 key
-- that is NOT stored in this database, that chain <chain> had entry <seq> with hash <hash> at <at>. The same lines are
-- written to a file outside the database volume. A rewrite of the chain (even with recomputed hashes) or a cut of its
-- tail is then detectable by anyone holding the public key, unless the attacker also holds the private key.
CREATE TABLE IF NOT EXISTS "audit_checkpoints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"seq" bigint NOT NULL,
	"hash" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"public_key" text NOT NULL,
	"signature" text NOT NULL,
	CONSTRAINT "audit_checkpoints_hash_check" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audit_checkpoints_seq_check" CHECK ("seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "audit_checkpoints_chain_seq_uq" ON "audit_checkpoints" USING btree ("chain","seq");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "audit_checkpoints_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_checkpoints is append-only (chain %, seq %)', OLD.chain, OLD.seq;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "audit_checkpoints_append_only" BEFORE UPDATE OR DELETE ON "audit_checkpoints"
	FOR EACH ROW EXECUTE FUNCTION "audit_checkpoints_append_only"();
