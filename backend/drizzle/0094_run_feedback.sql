-- fast-deploy: expansion-safe
-- In-app feedback on a run: one row per (run, user), updated on resend.
CREATE TABLE IF NOT EXISTS "run_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"verdict" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_run_feedback_verdict" CHECK ("verdict" in ('good', 'bad'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_run_feedback_run_user" ON "run_feedback" ("run_id", "user_id");
