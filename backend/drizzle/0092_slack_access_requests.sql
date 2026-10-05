-- fast-deploy: expansion-safe
-- Slack senders the bot does not know yet, waiting for an admin to let them in.
CREATE TABLE IF NOT EXISTS "slack_access_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL REFERENCES "slack_workspaces"("team_id") ON DELETE CASCADE,
	"slack_user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"image" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"invitation_id" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_slack_access_requests_sender" ON "slack_access_requests" ("team_id", "slack_user_id", "org_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_access_requests_org_status" ON "slack_access_requests" ("org_id", "status");
