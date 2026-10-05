-- fast-deploy: expansion-safe
ALTER TABLE "runs" ADD COLUMN "expected_sandbox" jsonb;
