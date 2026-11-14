-- When a deposit quote's wallet transfer was handed out (#214): set once with a conditional update. Additive.
ALTER TABLE "deposit_quotes" ADD COLUMN IF NOT EXISTS "transfer_issued_at" timestamp with time zone;
