-- fast-deploy: expansion-safe
-- Sandboxes whose native runtime files passed the artifact probe, per runtime
-- generation. The probe is a corruption check (docs/operations/native-runtime-assets.md),
-- run once per sandbox and generation; this row lets a restarted backend skip
-- it as the process that ran it would. One small row per sandbox, never read
-- after the sandbox is gone.
CREATE TABLE IF NOT EXISTS "runtime_artifact_verifications" (
	"sandbox_id" text NOT NULL,
	"generation" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_artifact_verifications_pk" PRIMARY KEY("sandbox_id","generation")
);
