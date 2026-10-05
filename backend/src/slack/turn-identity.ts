/**
 * Identity of a Slack-born turn for the web. The inbox claim records, before it
 * completes, what the stamp still owes (a slack_identity_lookups row: the sender
 * to look up through the workspace's bot token, never from the browser, and the
 * message whose permalink to fetch). That row is its own table with no foreign
 * key, so the write never waits on the run row's terminal lock and never holds
 * the serial inbox. The stamp runs off that path: the two lookups share one
 * deadline, whatever resolved by then is stamped on the run row under a bounded
 * lock wait, and the thread stream is woken so an open session shows the sender
 * within the same second. The lookup row stays until everything it owes has
 * resolved (the sender's profile when a sender is known, and the permalink): a
 * failed or cut lookup leaves a partial stamp and the row, so a redelivery or
 * the boot sweep fills the rest; only then is the row deleted, in the same
 * transaction as the stamp. A crash or a lock wait that ran out leaves the row
 * too, however old it gets. A lookup failure never fails the accepted run.
 */
import type { RunConnector } from "@useagent/agent-client/wire";
import { and, eq, isNull, notExists, sql } from "drizzle-orm";
import { db } from "../db/client";
import { isLockTimeout } from "../db/pg-errors";
import { runs, slackIdentityLookups } from "../db/schema";
import { slackConfig } from "../env";
import { resolveSlackBotTokenForWorkspace } from "../integrations/slack-token-resolver";
import { publishThreadChange } from "../runs/thread-signals";
import { resolveSlackClient, type SlackChannelInfo, type SlackClient, type SlackUserProfile } from "./client";

export type SlackTurnIdentityOutcome = "stamped" | "already_stamped" | "unavailable";
export type SlackTurnIdentityIntentOutcome = "recorded" | "already_recorded";

const DEFAULT_LOOKUP_MS = 5_000;
/** The stamp's wait for the run row, which finalization can hold for update;
 *  past it the lookup row stays and the boot sweep finishes the stamp. */
const STAMP_LOCK_TIMEOUT = "30s";
const RECOVERY_LIMIT = 200;
/** A sender's profile resolves once per team and user for a few minutes, so ten
 *  messages from one person cost one users.info; the permalink stays per message.
 *  Only a profile Slack returned is cached: a failure or a deadline cut is asked
 *  again next time, never remembered as "no name". */
const SENDER_PROFILE_TTL_MS = 5 * 60 * 1000;
const SENDER_PROFILE_CACHE_MAX = 1000;
const senderProfiles = new Map<string, { profile: SlackUserProfile; until: number }>();
/** A channel's description resolves once per team and channel for the same
 *  while; only an answer that named the channel is cached. */
const channelDescriptions = new Map<string, { info: SlackChannelInfo; until: number }>();

type ChannelKind = NonNullable<RunConnector["channel_kind"]>;

/** The kind of conversation a message came from: Slack's channel_type when the
 *  event carried one (message events do, app_mention events do not), else the
 *  channel id's prefix. Null when neither says; the web then reads the kind off
 *  the permalink. */
function channelKindFor(channelType: string | null, channel: string): ChannelKind | null {
  switch (channelType) {
    case "im":
      return "dm";
    case "mpim":
      return "group_dm";
    case "group":
      return "private_channel";
    case "channel":
      return "channel";
    default:
      if (channel.startsWith("D")) return "dm";
      if (channel.startsWith("G")) return "private_channel";
      if (channel.startsWith("C")) return "channel";
      return null;
  }
}

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

/** The sender's profile, from the cache while fresh, else from Slack. */
async function senderProfile(
  client: SlackClient,
  teamId: string,
  userId: string,
  signal: AbortSignal,
): Promise<SlackUserProfile | null> {
  const key = `${teamId}:${userId}`;
  const cached = senderProfiles.get(key);
  if (cached && cached.until > Date.now()) return cached.profile;
  const profile = await within(client.userInfo?.({ user: userId, signal }), signal);
  if (profile && !signal.aborted) {
    if (senderProfiles.size >= SENDER_PROFILE_CACHE_MAX) senderProfiles.clear();
    senderProfiles.set(key, { profile, until: Date.now() + SENDER_PROFILE_TTL_MS });
  }
  return profile;
}

/** The channel's description, from the cache while fresh, else from Slack. */
async function channelDescription(
  client: SlackClient,
  teamId: string,
  channel: string,
  signal: AbortSignal,
): Promise<SlackChannelInfo | null> {
  const key = `${teamId}:${channel}`;
  const cached = channelDescriptions.get(key);
  if (cached && cached.until > Date.now()) return cached.info;
  const info = await within(client.channelInfo?.({ channel, signal }), signal);
  if (info?.name && !signal.aborted) {
    if (channelDescriptions.size >= SENDER_PROFILE_CACHE_MAX) channelDescriptions.clear();
    channelDescriptions.set(key, { info, until: Date.now() + SENDER_PROFILE_TTL_MS });
  }
  return info;
}

/** Whether a stamp has everything the lookup row owes. */
function stampComplete(connector: RunConnector, senderOwed: boolean, nameOwed: boolean): boolean {
  return (
    (!senderOwed || connector.sender_name !== null) &&
    connector.permalink !== null &&
    (!nameOwed || (connector.channel_name ?? null) !== null)
  );
}

/** Record, durably and before the inbox claim completes, what the stamp owes.
 *  Touches only the lookup table, so a held run row cannot delay it. */
export async function recordSlackTurnIdentityIntent(input: {
  readonly runId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly messageTs: string;
  readonly slackUserId: string | null;
  /** Slack's channel_type for the message (im, channel, group, mpim); null when
   *  the event carried none. */
  readonly channelType: string | null;
}): Promise<SlackTurnIdentityIntentOutcome> {
  const recorded = await db
    .insert(slackIdentityLookups)
    .values({
      runId: input.runId,
      teamId: input.teamId,
      channel: input.channel,
      messageTs: input.messageTs,
      slackUserId: input.slackUserId,
      channelType: input.channelType,
    })
    .onConflictDoNothing({ target: slackIdentityLookups.runId })
    .returning({ runId: slackIdentityLookups.runId });
  return recorded.length > 0 ? "recorded" : "already_recorded";
}

/** Finish the stamp a recorded lookup owes: everything still missing is looked
 *  up and merged into what an earlier stamp already resolved. Never throws. */
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
    const senderOwed = owed.slackUserId !== null;
    const kind = run.connector?.channel_kind ?? channelKindFor(owed.channelType, owed.channel);
    // A channel's name is owed until Slack names it or says it never will.
    let nameOwed = kind === "channel" || kind === "private_channel";
    if (run.connector && stampComplete(run.connector, senderOwed, nameOwed)) {
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
    const [profile, permalink, description] = await Promise.all([
      owed.slackUserId ? senderProfile(client, owed.teamId, owed.slackUserId, signal) : null,
      within(client.getPermalink?.({ channel: owed.channel, messageTs: owed.messageTs, signal }), signal),
      nameOwed && (run.connector?.channel_name ?? null) === null
        ? channelDescription(client, owed.teamId, owed.channel, signal)
        : null,
    ]);
    // Slack answered without a name: no scope for it, no such channel, or a
    // conversation that turned out not to be a named channel. Nothing more is owed.
    if (description && description.name === null) nameOwed = false;
    if (signal.aborted) {
      console.warn(
        `[slack] turn identity lookups for run ${runId} hit the ${deadlineMs}ms deadline; stamping what resolved`,
      );
    }
    let known = run.connector;
    for (let attempt = 0; ; attempt += 1) {
      const connector: RunConnector = {
        source: "slack",
        sender_name: known?.sender_name ?? profile?.name ?? null,
        sender_avatar_url: known?.sender_avatar_url ?? profile?.image ?? null,
        permalink: known?.permalink ?? permalink ?? null,
        channel_kind: known?.channel_kind ?? description?.kind ?? kind,
        channel_name: known?.channel_name ?? description?.name ?? null,
      };
      const complete = stampComplete(connector, senderOwed, nameOwed);
      if (
        known &&
        known.sender_name === connector.sender_name &&
        known.sender_avatar_url === connector.sender_avatar_url &&
        known.permalink === connector.permalink &&
        (known.channel_kind ?? null) === connector.channel_kind &&
        (known.channel_name ?? null) === connector.channel_name
      ) {
        // Nothing new resolved this time. Once nothing is owed any more (Slack
        // said the name will never come) the row goes; otherwise it waits for
        // the next attempt.
        if (complete) {
          await db.delete(slackIdentityLookups).where(eq(slackIdentityLookups.runId, runId));
          return "already_stamped";
        }
        return "unavailable";
      }
      // One transaction: the stamp lands (`updated_at` moves so an open session's
      // merge treats the fresh row as new) and, once nothing is owed, the row goes
      // with it. The stamp merges onto exactly the row it read, so a concurrent
      // stamp that resolved more is never overwritten. The run row can be held by
      // a terminal write; the wait is bounded and a timeout leaves the owed row
      // for the sweep.
      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('lock_timeout', ${STAMP_LOCK_TIMEOUT}, true)`);
        const rows = await tx
          .update(runs)
          .set({ connector, updatedAt: new Date() })
          .where(and(
            eq(runs.id, runId),
            known ? sql`${runs.connector} = ${JSON.stringify(known)}::jsonb` : isNull(runs.connector),
          ))
          .returning({ id: runs.id });
        if (rows.length > 0 && complete) {
          await tx.delete(slackIdentityLookups).where(eq(slackIdentityLookups.runId, runId));
        }
        return rows;
      });
      if (updated.length > 0) {
        publishThreadChange(run.threadId, { runId, kind: "created" });
        return "stamped";
      }
      // A concurrent stamp wrote first (a detached stamp and the sweep can meet
      // on one run): what resolved here is merged onto its row, once, so a stamp
      // that resolved more is not lost to the next sweep.
      if (attempt > 0) return "already_stamped";
      const [latest] = await db.select({ connector: runs.connector }).from(runs).where(eq(runs.id, runId)).limit(1);
      if (!latest) return "unavailable";
      known = latest.connector;
      if (known && stampComplete(known, senderOwed, nameOwed)) {
        await db.delete(slackIdentityLookups).where(eq(slackIdentityLookups.runId, runId));
        return "already_stamped";
      }
    }
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
 *  gone. A row whose run is already complete is dropped by its stamp; an owed
 *  row for a run still missing something is never expired, however old; it
 *  waits its turn across boots. Returns how many stamps landed. */
export async function recoverSlackTurnIdentities(): Promise<number> {
  await db
    .delete(slackIdentityLookups)
    .where(notExists(
      db.select({ id: runs.id }).from(runs).where(eq(runs.id, slackIdentityLookups.runId)),
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
