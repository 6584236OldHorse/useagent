/**
 * Identity of a Slack-born turn for the web. After the inbox accepted a message
 * as a run, look the sender up (users.info through the workspace's bot token,
 * never from the browser), fetch the message's permalink (chat.getPermalink) and
 * stamp both on the run row. The thread stream re-projects the run once the
 * stamp lands, so an open session shows the sender within the same second; a
 * reload reads the row. Idempotent: a replayed delivery finds the stamp and does
 * nothing. Best effort and never on the inbox's path: the claim handler does not
 * await it, the two lookups share one deadline, and whatever resolved by then is
 * stamped. A lookup failure never fails the accepted run.
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

const DEFAULT_LOOKUP_MS = 5_000;

/** How long both Slack lookups may take together; a response that never
 *  completes is cut here and the socket released. */
function lookupDeadlineMs(): number {
  const raw = Number(process.env.SLACK_IDENTITY_LOOKUP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOOKUP_MS;
}

/** The lookup's value, or null once it fails or the deadline fires, whichever
 *  comes first: a client that ignores the signal can never hold the stamp open. */
function within<T>(lookup: Promise<T | null> | undefined, signal: AbortSignal): Promise<T | null> {
  if (!lookup) return Promise.resolve(null);
  return new Promise((resolve) => {
    lookup.then((value) => resolve(value ?? null), () => resolve(null));
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
}

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
    const deadlineMs = lookupDeadlineMs();
    const signal = AbortSignal.timeout(deadlineMs);
    const [profile, permalink] = await Promise.all([
      within(
        input.slackUserId ? client.userInfo?.({ user: input.slackUserId, signal }) : undefined,
        signal,
      ),
      within(
        client.getPermalink?.({ channel: input.channel, messageTs: input.messageTs, signal }),
        signal,
      ),
    ]);
    if (signal.aborted) {
      console.warn(
        `[slack] turn identity lookups for run ${input.runId} hit the ${deadlineMs}ms deadline; stamping what resolved`,
      );
    }
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
