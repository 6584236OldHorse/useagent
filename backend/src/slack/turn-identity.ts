/**
 * Identity of a Slack-born turn for the web. The inbox claim records, before it
 * completes, what the stamp still owes (`runs.connector_lookup`): the sender to
 * look up (users.info through the workspace's bot token, never from the
 * browser) and the message whose permalink to fetch (chat.getPermalink). The
 * stamp itself runs off the inbox's serial path: the two lookups share one
 * deadline, whatever resolved by then is stamped on the run row, and the thread
 * stream is woken so an open session shows the sender within the same second.
 * A crash between the claim and the stamp leaves the intent behind; the boot
 * sweep finishes it. Idempotent: a replayed delivery finds the stamp and does
 * nothing. A lookup failure never fails the accepted run.
 */
import type { RunConnector } from "@useagent/agent-client/wire";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { runs, type ConnectorLookup } from "../db/schema";
import { slackConfig } from "../env";
import { resolveSlackBotTokenForWorkspace } from "../integrations/slack-token-resolver";
import { publishThreadChange } from "../runs/thread-signals";
import { resolveSlackClient } from "./client";

export type SlackTurnIdentityOutcome = "stamped" | "already_stamped" | "unavailable";

const DEFAULT_LOOKUP_MS = 5_000;
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECOVERY_LIMIT = 200;

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

/** Record, durably and before the inbox claim completes, what the stamp owes.
 *  True when this call recorded it; false when the turn is already stamped or
 *  an earlier claim recorded the same intent. */
export async function recordSlackTurnIdentityIntent(input: {
  readonly runId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly messageTs: string;
  readonly slackUserId: string | null;
}): Promise<boolean> {
  const lookup: ConnectorLookup = {
    source: "slack",
    teamId: input.teamId,
    channel: input.channel,
    messageTs: input.messageTs,
    slackUserId: input.slackUserId,
  };
  const recorded = await db
    .update(runs)
    .set({ connectorLookup: lookup })
    .where(and(eq(runs.id, input.runId), isNull(runs.connector), isNull(runs.connectorLookup)))
    .returning({ id: runs.id });
  return recorded.length > 0;
}

/** Finish the stamp a recorded intent owes. Never throws. */
export async function stampSlackTurnIdentity(runId: string): Promise<SlackTurnIdentityOutcome> {
  try {
    const [run] = await db
      .select({
        orgId: runs.orgId,
        threadId: runs.threadId,
        connector: runs.connector,
        lookup: runs.connectorLookup,
      })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run) return "unavailable";
    if (run.connector) return "already_stamped";
    if (!run.lookup || !run.orgId) return "unavailable";
    const config = slackConfig();
    const botToken = config
      ? await resolveSlackBotTokenForWorkspace({ orgId: run.orgId, teamId: run.lookup.teamId, config })
      : null;
    if (!config || !botToken) return "unavailable";
    const client = resolveSlackClient({ apiUrl: config.apiUrl, botToken });
    const deadlineMs = lookupDeadlineMs();
    const signal = AbortSignal.timeout(deadlineMs);
    const { channel, messageTs, slackUserId } = run.lookup;
    const [profile, permalink] = await Promise.all([
      within(slackUserId ? client.userInfo?.({ user: slackUserId, signal }) : undefined, signal),
      within(client.getPermalink?.({ channel, messageTs, signal }), signal),
    ]);
    if (signal.aborted) {
      console.warn(
        `[slack] turn identity lookups for run ${runId} hit the ${deadlineMs}ms deadline; stamping what resolved`,
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
      .set({ connector, connectorLookup: null, updatedAt: new Date() })
      .where(and(eq(runs.id, runId), isNull(runs.connector)))
      .returning({ id: runs.id });
    if (updated.length === 0) return "already_stamped";
    publishThreadChange(run.threadId, { runId, kind: "created" });
    return "stamped";
  } catch (error) {
    console.error(`[slack] turn identity stamp failed for run ${runId}:`, (error as Error).message);
    return "unavailable";
  }
}

/** Boot sweep: finish the stamps whose intent a crash left behind (bounded to
 *  the last day and a page of turns, oldest first). Returns how many landed. */
export async function recoverSlackTurnIdentities(): Promise<number> {
  const owed = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(
      isNotNull(runs.connectorLookup),
      isNull(runs.connector),
      gt(runs.createdAt, new Date(Date.now() - RECOVERY_WINDOW_MS)),
    ))
    .orderBy(runs.createdAt)
    .limit(RECOVERY_LIMIT);
  let stamped = 0;
  for (const { id } of owed) {
    if ((await stampSlackTurnIdentity(id)) === "stamped") stamped++;
  }
  if (owed.length > 0) {
    console.log(`[slack] turn identity recovery: ${stamped} of ${owed.length} owed stamps landed`);
  }
  return stamped;
}
