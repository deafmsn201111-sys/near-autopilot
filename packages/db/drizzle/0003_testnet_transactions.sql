CREATE TABLE IF NOT EXISTS "testnet_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"preview_hash" text NOT NULL,
	"network" text NOT NULL,
	"signer_id" text NOT NULL,
	"operation" text NOT NULL,
	"receiver_id" text NOT NULL,
	"method_name" text NOT NULL,
	"preview" jsonb NOT NULL,
	"status" text NOT NULL,
	"deposit_yocto" text NOT NULL,
	"max_cost_yocto" text NOT NULL,
	"actual_cost_yocto" text,
	"tx_hash" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "testnet_transactions_preview_hash_unique" UNIQUE("preview_hash"),
	CONSTRAINT "testnet_transactions_network_check" CHECK ("network" = 'testnet')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "testnet_transactions_status_idx" ON "testnet_transactions" USING btree ("status");
