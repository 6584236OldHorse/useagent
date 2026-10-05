-- fast-deploy: expansion-safe
-- Who sent a connector-born turn (Slack): the sender's display name and avatar as
-- the channel showed them at ingress, plus the message permalink. Null for turns
-- typed in the product. slack_identity_lookups holds the lookup still owed for
-- that stamp, durable before the inbox claim completes; it has no foreign key on
-- purpose (a key-share lock on the run row would wait on finalization's lock).
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "connector" jsonb;
CREATE TABLE IF NOT EXISTS "slack_identity_lookups" (
  "run_id" text PRIMARY KEY,
  "team_id" text NOT NULL,
  "channel" text NOT NULL,
  "message_ts" text NOT NULL,
  "slack_user_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
