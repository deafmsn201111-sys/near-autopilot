-- A run stopped because the visitor left is recorded as 'cancelled' (#151). Widens the outcome check; existing rows pass.
ALTER TABLE "llm_calls" DROP CONSTRAINT IF EXISTS "llm_calls_outcome_check";
--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_outcome_check" CHECK ("outcome" IN ('ok', 'cap', 'model_error', 'invalid_output', 'empty', 'deadline', 'cancelled', 'loop_limit'));
