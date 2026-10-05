-- fast-deploy: expansion-safe
-- The permission policy each run was started with (engines/permission-mode.ts).
-- Rows from before the column ran with the runtime's full-access posture, so
-- that is the default.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "permission_mode" text NOT NULL DEFAULT 'full-access';
-- The run's place in its thread, assigned under the thread lifecycle lock at
-- insert: a lossless acceptance order that survives the wire, where created_at
-- is truncated to milliseconds. Earlier rows keep 0 and sort by created_at.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "thread_seq" integer NOT NULL DEFAULT 0;
