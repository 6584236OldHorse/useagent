/**
 * Identity of a Slack-born turn for the web. After the inbox accepted a message
 * as a run, look the sender up (users.info through the workspace's bot token,
 * never from the browser), fetch the message's permalink (chat.getPermalink) and
 * stamp both on the run row. The thread stream re-projects the run once the
 * stamp lands, so an open session shows the sender within the same second; a
 * reload reads the row. Idempotent: a replayed delivery finds the stamp and does
 * nothing. A lookup failure never fails the accepted run; the turn then carries
 * the connector and whatever was resolved.
 */
import type { RunConnector } from "@useagent/agent-client/wire";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { runs } from "../db/schema";
import { slackConfig } from "../env";
import { resolveSlackBotTokenForWorkspace } from "../integrations/slack-token-resolver";
import { publishThreadChange } from "../runs/thread-signals";
import { resolveSlackClient } from "./client";

export type SlackTurnIdentityOutcome = "stamped" | "already_stamped" | "unavailable";

export async function stampSlackTurnIdentity(input: {
  readonly runId: string;
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly messageTs: string;
  readonly slackUserId: string | null;
}): Promise<SlackTurnIdentityOutcome> {
  try {
    const [run] = await db
      .select({ threadId: runs.threadId, connector: runs.connector })
      .from(runs)
      .where(eq(runs.id, input.runId))
      .limit(1);
    if (!run) return "unavailable";
    if (run.connector) return "already_stamped";
    const config = slackConfig();
    const botToken = config
      ? await resolveSlackBotTokenForWorkspace({ orgId: input.orgId, teamId: input.teamId, config })
      : null;
    if (!config || !botToken) return "unavailable";
    const client = resolveSlackClient({ apiUrl: config.apiUrl, botToken });
    const [profile, permalink] = await Promise.all([
      input.slackUserId ? client.userInfo?.({ user: input.slackUserId }) : null,
      client.getPermalink?.({ channel: input.channel, messageTs: input.messageTs }),
    ]);
    const connector: RunConnector = {
      source: "slack",
      sender_name: profile?.name ?? null,
      sender_avatar_url: profile?.image ?? null,
      permalink: permalink ?? null,
    };
    // `updated_at` moves so an open session's merge treats the fresh row as new.
    const updated = await db
      .update(runs)
      .set({ connector, updatedAt: new Date() })
      .where(and(eq(runs.id, input.runId), isNull(runs.connector)))
      .returning({ id: runs.id });
    if (updated.length === 0) return "already_stamped";
    publishThreadChange(run.threadId, { runId: input.runId, kind: "created" });
    return "stamped";
  } catch (error) {
    console.error(`[slack] turn identity stamp failed for run ${input.runId}:`, (error as Error).message);
    return "unavailable";
  }
}
