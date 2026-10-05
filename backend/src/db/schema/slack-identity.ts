import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// The lookup a Slack-born turn's identity stamp still owes: who to ask Slack
// about and which message to link. Written inside the inbox claim, before it
// completes, and deleted when the stamp lands on runs.connector, so a row here
// means work owed; the boot sweep finishes what a crash left behind.
//
// Deliberately NO foreign key to runs: a foreign-key check takes a key-share
// lock on the run row, which finalization holds for update, so the write would
// wait on a terminal write and the serial inbox with it. Rows outlive a deleted
// run only until the sweep's age limit.
export const slackIdentityLookups = pgTable("slack_identity_lookups", {
  runId: text("run_id").primaryKey(),
  teamId: text("team_id").notNull(),
  channel: text("channel").notNull(),
  messageTs: text("message_ts").notNull(),
  slackUserId: text("slack_user_id"),
  // Slack's channel_type for the message (im, channel, group, mpim); null when
  // the event carried none (app_mention) or the row predates the column.
  channelType: text("channel_type"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
