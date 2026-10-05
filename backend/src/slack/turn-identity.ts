/**
 * Identity of a Slack-born turn for the web. The inbox claim records, before it
 * completes, what the stamp still owes (a slack_identity_lookups row: the sender
 * to look up through the workspace's bot token, never from the browser, and the
 * message whose permalink to fetch). That row is its own table with no foreign
 * key, so the write never waits on the run row's terminal lock and never holds
 * the serial inbox. The stamp runs off that path: the two lookups share one
 * deadline, whatever resolved by then is stamped on the run row under a bounded
 * lock wait, the lookup row is deleted in the same transaction, and the thread
 * stream is woken so an open session shows the sender within the same second.
 * A crash or a lock wait that ran out leaves the lookup row; the boot sweep
 * finishes it, however old the row is. Idempotent: a replayed delivery finds the stamp and cleans up.
 * A lookup failure never fails the accepted run.
 */
import type { RunConnector } from "@useagent/agent-client/wire";
import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { db } from "../db/client";
import { isLockTimeout } from "../db/pg-errors";
import { runs, slackIdentityLookups } from "../db/schema";
import { slackConfig } from "../env";
import { resolveSlackBotTokenForWorkspace } from "../integrations/slack-token-resolver";
import { publishThreadChange } from "../runs/thread-signals";
import { resolveSlackClient } from "./client";

export type SlackTurnIdentityOutcome = "stamped" | "already_stamped" | "unavailable";
export type SlackTurnIdentityIntentOutcome = "recorded" | "already_recorded";

const DEFAULT_LOOKUP_MS = 5_000;
/** The stamp's wait for the run row, which finalization can hold for update;
 *  past it the lookup row stays and the boot sweep finishes the stamp. */
const STAMP_LOCK_TIMEOUT = "30s";
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
 *  Touches only the lookup table, so a held run row cannot delay it. */
export async function recordSlackTurnIdentityIntent(input: {
  readonly runId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly messageTs: string;
  readonly slackUserId: string | null;
}): Promise<SlackTurnIdentityIntentOutcome> {
  const recorded = await db
    .insert(slackIdentityLookups)
    .values({
      runId: input.runId,
      teamId: input.teamId,
      channel: input.channel,
      messageTs: input.messageTs,
      slackUserId: input.slackUserId,
    })
    .onConflictDoNothing({ target: slackIdentityLookups.runId })
    .returning({ runId: slackIdentityLookups.runId });
  return recorded.length > 0 ? "recorded" : "already_recorded";
}

/** Finish the stamp a recorded lookup owes. Never throws. */
export async function stampSlackTurnIdentity(runId: string): Promise<SlackTurnIdentityOutcome> {
  try {
    const [owed] = await db
      .select()
      .from(slackIdentityLookups)
      .where(eq(slackIdentityLookups.runId, runId))
      .limit(1);
    if (!owed) return "unavailable";
    const [run] = await db
      .select({ orgId: runs.orgId, threadId: runs.threadId, connector: runs.connector })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    if (!run?.orgId) return "unavailable";
    if (run.connector) {
      await db.delete(slackIdentityLookups).where(eq(slackIdentityLookups.runId, runId));
      return "already_stamped";
    }
    const config = slackConfig();
    const botToken = config
      ? await resolveSlackBotTokenForWorkspace({ orgId: run.orgId, teamId: owed.teamId, config })
      : null;
    if (!config || !botToken) return "unavailable";
    const client = resolveSlackClient({ apiUrl: config.apiUrl, botToken });
    const deadlineMs = lookupDeadlineMs();
    const signal = AbortSignal.timeout(deadlineMs);
    const [profile, permalink] = await Promise.all([
      within(owed.slackUserId ? client.userInfo?.({ user: owed.slackUserId, signal }) : undefined, signal),
      within(client.getPermalink?.({ channel: owed.channel, messageTs: owed.messageTs, signal }), signal),
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
    // One transaction: the stamp lands (`updated_at` moves so an open session's
    // merge treats the fresh row as new) and the owed row goes with it. The
    // run row can be held by a terminal write; the wait is bounded and a
    // timeout leaves the owed row for the sweep.
    const updated = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', ${STAMP_LOCK_TIMEOUT}, true)`);
      const rows = await tx
        .update(runs)
        .set({ connector, updatedAt: new Date() })
        .where(and(eq(runs.id, runId), isNull(runs.connector)))
        .returning({ id: runs.id });
      await tx.delete(slackIdentityLookups).where(eq(slackIdentityLookups.runId, runId));
      return rows;
    });
    if (updated.length === 0) return "already_stamped";
    publishThreadChange(run.threadId, { runId, kind: "created" });
    return "stamped";
  } catch (error) {
    if (isLockTimeout(error)) {
      console.warn(`[slack] turn identity stamp for run ${runId} waited ${STAMP_LOCK_TIMEOUT} on its run row; the boot sweep retries it`);
      return "unavailable";
    }
    console.error(`[slack] turn identity stamp failed for run ${runId}:`, (error as Error).message);
    return "unavailable";
  }
}

/** Boot sweep: finish the stamps whose lookup row is still owed, oldest first,
 *  a page at a time. Only a row nothing can finish is dropped first: its run is
 *  gone or already carries a connector. An owed row for an unstamped run is
 *  never expired, however old; it waits its turn across boots. Returns how many
 *  stamps landed. */
export async function recoverSlackTurnIdentities(): Promise<number> {
  await db
    .delete(slackIdentityLookups)
    .where(notExists(
      db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, slackIdentityLookups.runId), isNull(runs.connector))),
    ));
  const owed = await db
    .select({ runId: slackIdentityLookups.runId })
    .from(slackIdentityLookups)
    .orderBy(slackIdentityLookups.createdAt)
    .limit(RECOVERY_LIMIT);
  let stamped = 0;
  for (const { runId } of owed) {
    if ((await stampSlackTurnIdentity(runId)) === "stamped") stamped++;
  }
  if (owed.length > 0) {
    console.log(`[slack] turn identity recovery: ${stamped} of ${owed.length} owed stamps landed`);
  }
  return stamped;
}
