-- fast-deploy: expansion-safe
-- The permission policy each run was started with (engines/permission-mode.ts).
-- Rows from before the column ran with the runtime's full-access posture, so
-- that is the default.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "permission_mode" text NOT NULL DEFAULT 'full-access';
