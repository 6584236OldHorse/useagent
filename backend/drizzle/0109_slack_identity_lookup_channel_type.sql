-- The kind of Slack conversation a turn arrived from (Slack's channel_type:
-- im, channel, group, mpim), recorded with the identity lookup so the stamp can
-- mark the thread as a DM or a channel and, for channels, look the name up.
-- Null for lookups recorded before this column and for events without one
-- (app_mention carries none); those fall back to the channel id's prefix.
ALTER TABLE "slack_identity_lookups" ADD COLUMN "channel_type" text;
