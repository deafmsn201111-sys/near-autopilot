-- Read-only MAINNET shadow analysis (simulated portfolio, nothing executed). Constraints are widened, no data changes.
ALTER TABLE "market_prices" DROP CONSTRAINT IF EXISTS "market_prices_execution_network_check";
--> statement-breakpoint
ALTER TABLE "market_prices" ADD CONSTRAINT "market_prices_execution_network_check" CHECK ("execution_network" IN ('testnet', 'none'));
--> statement-breakpoint
ALTER TABLE "yield_observations" DROP CONSTRAINT IF EXISTS "yield_observations_network_check";
--> statement-breakpoint
ALTER TABLE "yield_observations" ADD CONSTRAINT "yield_observations_network_check" CHECK ("network" IN ('testnet', 'mainnet'));
--> statement-breakpoint
ALTER TABLE "yield_observations" DROP CONSTRAINT IF EXISTS "yield_observations_type_check";
--> statement-breakpoint
ALTER TABLE "yield_observations" ADD CONSTRAINT "yield_observations_type_check" CHECK ("yield_type" IN ('lending_supply', 'lending_reward', 'lending_borrow', 'lp_fee'));
