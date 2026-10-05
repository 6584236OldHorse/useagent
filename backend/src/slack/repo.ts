/**
 * Slack thread ↔ run mapping. One row per Slack thread the bot has rooted,
 * keyed by `(team, channel, thread root ts)`. The FIRST bot interaction in a Slack
 * thread creates a useAgent root run and links it here; every later message in
 * that Slack thread resolves to the root and becomes a `parent_run_id` reply,
 * so the thread stays one useAgent conversation with clean, un-nested prompts.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runs, slackRunResponses, slackThreads, threadRelationships } from "../db/schema";
import { env } from "../env";
import { parseRepoRef } from "../github/repo-ref";
import { getThreadRelationship } from "../runs/thread-relationship-repo";
import { deriveTitle, sessionUrl, type RunCardInput } from "./card";
import type { SlackStreamTaskDisplayMode } from "./streaming";

export interface SlackThreadLink {
  rootRunId: string;
  orgId: string;
}

export interface SlackThreadTarget {
  teamId: string;
  channel: string;
  threadTs: string;
}

/** A rooted Slack thread: its destination plus the run family that owns its card. */
export interface SlackThreadRoot extends SlackThreadTarget {
  rootRunId: string;
}

export interface SlackRunResponseTarget extends SlackThreadTarget {
  runId: string;
  nativeStreamTs: string | null;
  nativeStreamMode: SlackStreamTaskDisplayMode | null;
  fallbackMessageTs: string | null;
  /** Narration chars the native stream has accepted (offset fence + stop tail). */
  streamedChars: number;
  /** Card id -> newest delivered batch sequence (stale-retry fence). */
  cardRevisions: Record<string, number>;
}

/** The useAgent root run for a Slack thread, or null if the bot hasn't engaged it. */
export async function findSlackThread(
  teamId: string,
  channel: string,
  threadTs: string,
): Promise<SlackThreadLink | null> {
  const [row] = await db
    .select({ rootRunId: slackThreads.rootRunId, orgId: slackThreads.orgId })
    .from(slackThreads)
    .where(
      and(
        eq(slackThreads.teamId, teamId),
        eq(slackThreads.channel, channel),
        eq(slackThreads.threadTs, threadTs),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Resolve a Slack thread in the post-team-id schema. During the 0053 migration
 * legacy rows are temporarily stamped `__legacy__`; the first event from the
 * resolved workspace may adopt exactly one matching legacy row, but only when
 * its stored org matches the workspace org. Anything ambiguous or cross-org
 * returns null so ingress fails closed instead of routing across tenants. */
export async function findOrAdoptSlackThread(
  input: { teamId: string; channel: string; threadTs: string; orgId: string },
): Promise<SlackThreadLink | null> {
  return await db.transaction(async (tx) => {
    const [exact] = await tx
      .select({ rootRunId: slackThreads.rootRunId, orgId: slackThreads.orgId })
      .from(slackThreads)
      .where(
        and(
          eq(slackThreads.teamId, input.teamId),
          eq(slackThreads.channel, input.channel),
          eq(slackThreads.threadTs, input.threadTs),
        ),
      )
      .limit(1);
    if (exact) return exact.orgId === input.orgId ? exact : null;

    const legacyRows = await tx
      .select({ rootRunId: slackThreads.rootRunId, orgId: slackThreads.orgId })
      .from(slackThreads)
      .where(
        and(
          eq(slackThreads.teamId, "__legacy__"),
          eq(slackThreads.channel, input.channel),
          eq(slackThreads.threadTs, input.threadTs),
        ),
      )
      .limit(2);
    if (legacyRows.length !== 1) return null;
    const [legacy] = legacyRows;
    if (!legacy || legacy.orgId !== input.orgId) return null;

    await tx
      .update(slackThreads)
      .set({ teamId: input.teamId })
      .where(
        and(
          eq(slackThreads.teamId, "__legacy__"),
          eq(slackThreads.channel, input.channel),
          eq(slackThreads.threadTs, input.threadTs),
        ),
      );
    await tx
      .update(slackRunResponses)
      .set({ teamId: input.teamId, updatedAt: new Date() })
      .where(
        and(
          eq(slackRunResponses.teamId, "__legacy__"),
          eq(slackRunResponses.channel, input.channel),
          eq(slackRunResponses.threadTs, input.threadTs),
        ),
      );
    return legacy;
  });
}

/** The Slack channel + thread ts a run's reply belongs in, resolved from the run's
 *  THREAD (a Slack thread's `rootRunId` equals the useAgent thread id every run in
 *  it shares). Null for a non-Slack run. Takes an Executor so run finalization can
 *  resolve it inside the finalization transaction. */
export async function findSlackThreadByRoot(
  rootRunId: string,
  exec: Executor = db,
  orgId?: string,
): Promise<SlackThreadRoot | null> {
  const rows = await exec
    .select({
      teamId: slackThreads.teamId,
      channel: slackThreads.channel,
      threadTs: slackThreads.threadTs,
      rootRunId: slackThreads.rootRunId,
    })
    .from(slackThreads)
    .where(
      orgId === undefined
        ? eq(slackThreads.rootRunId, rootRunId)
        : and(eq(slackThreads.rootRunId, rootRunId), eq(slackThreads.orgId, orgId)),
    )
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** Resolve the Slack destination inherited by an ordinary product child thread.
 * Relationship metadata is tenant-scoped and contains no connector credential;
 * the durable Slack binding remains owned by the family root. */
export async function findSlackThreadForProductThread(
  orgId: string,
  threadId: string,
  exec: Executor = db,
): Promise<SlackThreadRoot | null> {
  const [relationship] = await exec
    .select({ familyThreadId: threadRelationships.familyThreadId })
    .from(threadRelationships)
    .where(and(eq(threadRelationships.orgId, orgId), eq(threadRelationships.threadId, threadId)))
    .limit(1);
  return findSlackThreadByRoot(relationship?.familyThreadId ?? threadId, exec, orgId);
}

/** Link a Slack thread to the run that rooted it. Idempotent: a duplicate
 * (channel, threadTs) from a Slack retry race is ignored, keeping the original. */
export async function linkSlackThread(input: {
  teamId: string;
  channel: string;
  threadTs: string;
  rootRunId: string;
  orgId: string;
}): Promise<void> {
  await db.insert(slackThreads).values(input).onConflictDoNothing();
}

export async function createSlackRunResponse(
  input: { runId: string; teamId: string; channel: string; threadTs: string },
  exec: Executor = db,
): Promise<void> {
  await exec.insert(slackRunResponses).values(input).onConflictDoNothing();
}

export async function findSlackRunResponse(
  runId: string,
  exec: Executor = db,
): Promise<SlackRunResponseTarget | null> {
  const [row] = await exec
    .select({
      runId: slackRunResponses.runId,
      teamId: slackRunResponses.teamId,
      channel: slackRunResponses.channel,
      threadTs: slackRunResponses.threadTs,
      nativeStreamTs: slackRunResponses.nativeStreamTs,
      nativeStreamMode: slackRunResponses.nativeStreamMode,
      fallbackMessageTs: slackRunResponses.fallbackMessageTs,
      streamedChars: slackRunResponses.streamedChars,
      cardRevisions: slackRunResponses.cardRevisions,
    })
    .from(slackRunResponses)
    .where(eq(slackRunResponses.runId, runId))
    .limit(1);
  return row ?? null;
}

/** Record the batch sequence just delivered for each card it revised. */
export async function noteSlackCardRevisions(runId: string, revisions: Record<string, number>): Promise<void> {
  if (Object.keys(revisions).length === 0) return;
  await db
    .update(slackRunResponses)
    .set({
      cardRevisions: sql`${slackRunResponses.cardRevisions} || ${JSON.stringify(revisions)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(slackRunResponses.runId, runId));
}

/** Record the opened native stream and the chars its opening already holds in
 *  ONE write, so a crash can never leave the ts without its count. */
export async function setSlackNativeStream(
  runId: string,
  nativeStreamTs: string,
  nativeStreamMode: SlackStreamTaskDisplayMode,
  openingChars = 0,
): Promise<void> {
  await db
    .update(slackRunResponses)
    .set({ nativeStreamTs, nativeStreamMode, streamedChars: openingChars, updatedAt: new Date() })
    .where(eq(slackRunResponses.runId, runId));
}

/** The native stream failed for this run: forget its ts so every later append
 *  and the stop ride the Block Kit card path instead (fall back ONCE, no
 *  doomed per-row stream calls). */
export async function disableSlackNativeStream(runId: string): Promise<void> {
  await db
    .update(slackRunResponses)
    .set({ nativeStreamTs: null, updatedAt: new Date() })
    .where(eq(slackRunResponses.runId, runId));
}

/** Count narration chars the native stream ACCEPTED (after a successful append). */
export async function addSlackStreamedChars(runId: string, chars: number): Promise<void> {
  if (chars <= 0) return;
  await db
    .update(slackRunResponses)
    .set({ streamedChars: sql`${slackRunResponses.streamedChars} + ${chars}`, updatedAt: new Date() })
    .where(eq(slackRunResponses.runId, runId));
}

export async function setSlackFallbackMessageTs(runId: string, fallbackMessageTs: string): Promise<void> {
  await db
    .update(slackRunResponses)
    .set({ fallbackMessageTs, updatedAt: new Date() })
    .where(eq(slackRunResponses.runId, runId));
}

/** The thread card as stored: its message ts once posted, the newest revision
 *  applied (and the run that produced it), and when it last changed. */
export interface SlackThreadCard extends SlackThreadTarget {
  cardTs: string | null;
  cardRevision: number;
  cardRevisionRunId: string | null;
  cardUpdatedAt: Date | null;
}

/** Remember the thread card's message ts and the revision just applied, as
 *  applied (one card per rooted Slack thread): a replay of that revision is
 *  then told from a due one by equality. */
export async function setSlackCardTs(
  rootRunId: string,
  cardTs: string,
  revision?: { readonly revision: number; readonly runId: string },
): Promise<void> {
  await db
    .update(slackThreads)
    .set({
      cardTs,
      cardUpdatedAt: new Date(),
      ...(revision
        ? { cardRevision: revision.revision, cardRevisionRunId: revision.runId }
        : {}),
    })
    .where(eq(slackThreads.rootRunId, rootRunId));
}

/** The Slack thread a run family roots, with its card as stored. */
export async function getSlackCardTsByRoot(rootRunId: string): Promise<SlackThreadCard | null> {
  const rows = await db
    .select({
      teamId: slackThreads.teamId,
      channel: slackThreads.channel,
      threadTs: slackThreads.threadTs,
      cardTs: slackThreads.cardTs,
      cardRevision: slackThreads.cardRevision,
      cardRevisionRunId: slackThreads.cardRevisionRunId,
      cardUpdatedAt: slackThreads.cardUpdatedAt,
    })
    .from(slackThreads)
    .where(eq(slackThreads.rootRunId, rootRunId))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** The thread card's fixed chrome, built from the ROOT run of the Slack thread
 *  (never from the turn or child thread being delivered): its title (a
 *  relationship title wins, sanitised like a prompt), model and repos, and the
 *  root session link. Every turn revises the same card, so every turn must
 *  render the same chrome. Null when the root run is gone. */
export async function slackThreadCardBase(
  rootRunId: string,
  orgId: string,
  exec: Executor = db,
): Promise<Omit<RunCardInput, "status" | "output"> | null> {
  const [root] = await exec
    .select({ prompt: runs.prompt, model: runs.model, repos: runs.repos })
    .from(runs)
    .where(eq(runs.id, rootRunId))
    .limit(1);
  if (!root) return null;
  const relationship = await getThreadRelationship(orgId, rootRunId, exec);
  return {
    title: deriveTitle(relationship?.title ?? root.prompt),
    model: root.model,
    repoSpecs: root.repos.map(parseRepoRef),
    webUrl: sessionUrl(env.FRONTEND_ORIGIN, rootRunId),
  };
}
