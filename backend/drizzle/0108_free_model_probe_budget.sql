-- fast-deploy: expansion-safe
-- The qualifier re-verifies every advertised model every six hours and needs
-- room left for new candidates; 24 probes a day starved them once the lane
-- filled. A probe is one short low-priority sandbox run.
ALTER TABLE "free_model_registry_state" ALTER COLUMN "daily_probe_budget" SET DEFAULT 96;
--> statement-breakpoint
UPDATE "free_model_registry_state"
SET "daily_probe_budget" = 96, "updated_at" = now()
WHERE "daily_probe_budget" = 24;
