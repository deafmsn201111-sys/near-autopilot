-- Token metadata (ft_metadata symbol and decimals) for display. Additive: a new table, nothing existing changes.
CREATE TABLE IF NOT EXISTS "token_metadata" (
	"token" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"decimals" integer NOT NULL,
	"block_height" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "token_metadata_decimals_check" CHECK ("decimals" BETWEEN 0 AND 36),
	CONSTRAINT "token_metadata_symbol_check" CHECK (length("symbol") BETWEEN 1 AND 64)
);
