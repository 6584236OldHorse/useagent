-- fast-deploy: expansion-safe
-- The preamble a resumed native session already holds: content hashes of the
-- rule blocks and skill catalog its last delivered prompt carried. A resumed
-- turn re-sends a block only when its hash changed. Null sends everything.
-- A database upgrading through 0106 in one transaction holds deferred trigger
-- events from its runs UPDATE; firing them first lets runs be altered.
SET CONSTRAINTS ALL IMMEDIATE;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "preamble_hashes" jsonb;
