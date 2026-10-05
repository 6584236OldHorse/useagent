-- fast-deploy: expansion-safe
-- Where the thread was asked to run: "local" is the person's connected machine,
-- "cloud" the hosted provider. Chosen on the root run and copied onto every
-- reply at insert. Null on rows from before the choice existed.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "run_location" text;
-- Threads that ran on a machine under the old rule keep it: a thread whose
-- latest run that recorded a sandbox held a local one reads "local" on every
-- run, so its replies stay on the machine and keep its logins. A thread that
-- moved on to the cloud, and everything else, stays null: the cloud.
UPDATE "runs" SET "run_location" = 'local'
WHERE "run_location" IS NULL AND "thread_id" IN (
  SELECT "thread_id" FROM (
    SELECT DISTINCT ON ("thread_id") "thread_id", "sandbox_id", "sandbox_provider"
    FROM "runs"
    WHERE "sandbox_id" IS NOT NULL OR "sandbox_provider" IS NOT NULL
    ORDER BY "thread_id", "thread_seq" DESC, "created_at" DESC, "id" DESC
  ) AS latest
  WHERE latest."sandbox_id" LIKE 'local:%' OR latest."sandbox_provider" = 'local'
);
