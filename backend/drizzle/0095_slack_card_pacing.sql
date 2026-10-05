-- fast-deploy: expansion-safe
-- The thread card's revision ledger: the newest revision applied to the card
-- and the run that produced it (a retried older revision never regresses the
-- card; a turn's terminal revision still settles its own late live one), and
-- when the card was last updated (revisions are paced to Slack's chat.update
-- guidance).
ALTER TABLE "slack_threads" ADD COLUMN "card_revision" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "slack_threads" ADD COLUMN "card_revision_run_id" text;
--> statement-breakpoint
ALTER TABLE "slack_threads" ADD COLUMN "card_updated_at" timestamp with time zone;
