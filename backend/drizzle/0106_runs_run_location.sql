-- fast-deploy: expansion-safe
-- Where the thread was asked to run: "local" is the person's connected machine,
-- "cloud" the hosted provider. Chosen on the root run and copied onto every
-- reply at insert. Null on rows from before the choice existed.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "run_location" text;
-- Threads that ran on a machine under the old rule keep it: every run of a
-- thread that holds or held a local sandbox reads "local", so its replies stay
-- on the machine and keep its logins. Everything else stays null: the cloud.
UPDATE "runs" SET "run_location" = 'local'
WHERE "run_location" IS NULL AND "thread_id" IN (
  SELECT "thread_id" FROM "runs" WHERE "sandbox_id" LIKE 'local:%' OR "sandbox_provider" = 'local'
);
