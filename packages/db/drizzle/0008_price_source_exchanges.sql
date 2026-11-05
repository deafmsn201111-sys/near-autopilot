-- NEAR/USD quorum: exchange last-trade observations (coinbase, kraken, binance) join pyth and defillama.
-- Non-destructive: only the CHECK constraint is replaced; no row is changed.
ALTER TABLE "price_observations" DROP CONSTRAINT IF EXISTS "price_observations_source_check";
--> statement-breakpoint
ALTER TABLE "price_observations" ADD CONSTRAINT "price_observations_source_check" CHECK ("source" IN ('pyth', 'defillama', 'coinbase', 'kraken', 'binance'));
