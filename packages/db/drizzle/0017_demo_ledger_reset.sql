-- The dry-run requests that wrote the demo ledger are gone (#13), and so is the "Reset demo" button: start both demo
-- portfolios again from their documented base amounts. Data only; the table stays as history.
INSERT INTO "demo_ledger" ("portfolio", "at", "kind", "asset", "amount_raw", "usd", "request_id", "by")
VALUES
	('demo-500', now(), 'reset', NULL, '0', NULL, NULL, 'migration 0017'),
	('demo-5000', now(), 'reset', NULL, '0', NULL, NULL, 'migration 0017');
