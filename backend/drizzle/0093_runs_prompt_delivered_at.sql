-- fast-deploy: expansion-safe
-- Delivery evidence per run: when the engine runtime accepted the prompt. A bound
-- session is not evidence; a turn whose prompt never reached an engine keeps null.
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "prompt_delivered_at" timestamp with time zone;
