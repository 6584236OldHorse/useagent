-- fast-deploy: expansion-safe
-- A person can mute the bot in one Slack thread ("mute" as a reply, "unmute"
-- to lift it); the thread remembers it here.
ALTER TABLE "slack_threads" ADD COLUMN "muted_at" timestamp with time zone;
