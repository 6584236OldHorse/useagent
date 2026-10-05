-- fast-deploy: expansion-safe
-- Where the thread was asked to run: "local" is the person's connected machine,
-- "cloud" the hosted provider. Chosen on the root run and copied onto every
-- reply at insert. Null on rows from before the choice existed.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "run_location" text;
