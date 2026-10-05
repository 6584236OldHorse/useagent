-- fast-deploy: expansion-safe
-- Per-card revision ledger for the native Slack stream: card id -> the newest
-- watcher batch sequence delivered for it, so a retried older batch never
-- restores stale card state, across restarts.
ALTER TABLE "slack_run_responses"
ADD COLUMN "card_revisions" jsonb NOT NULL DEFAULT '{}'::jsonb;
