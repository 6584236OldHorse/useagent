/**
 * Slack-born turns carry who sent them for the web. Fully in-process, zero live
 * Slack: events enter through the durable inbox and the same claim handler the
 * boot pump runs; users.info and chat.getPermalink are answered by a recording
 * client (this is a recording transport, not a live Slack certification).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { commands, runs, slackIdentityLookups, user } from "../src/db/schema";
import { createRun } from "../src/runs/repo";
import { subscribeThread, type ThreadChange } from "../src/runs/thread-signals";
import { handleSlackInboxClaim, setSlackClientForTest, type SlackClient } from "../src/slack";
import type { SlackEnvelope } from "../src/slack/events";
import {
  persistSlackInboxEvent,
  processSlackInbox,
  slackInboxKey,
  startSlackInboxPump,
  stopSlackInboxPumpForTest,
} from "../src/slack/inbox";
import {
  recordSlackTurnIdentityIntent,
  recoverSlackTurnIdentities,
  stampSlackTurnIdentity,
} from "../src/slack/turn-identity";
import { upsertSlackUser, upsertSlackWorkspace } from "../src/slack/workspaces";
import { createOrgSession, json, uid, waitFor, type OrgSession } from "./helpers";

setDefaultTimeout(15_000);

const TEAM = "T0IDENTITY";
const BOT = "U0BOTBOT";
const SUNDAR = "U-SUNDAR";
const PRIYA = "U-PRIYA";
const GHOST = "U-GHOST";
/** A member whose users.info never completes; the lookup ends only when aborted. */
const STUCK = "U-STUCK";
/** A member whose first users.info hangs until aborted and whose later ones answer. */
const GATED = "U-GATED";
/** A member whose first users.info fails outright and whose later ones answer. */
const FLAKY = "U-FLAKY";
const PROFILES: Record<string, { name: string; email: string | null; image: string | null }> = {
  [SUNDAR]: { name: "Sundar", email: null, image: "https://avatars.example/sundar-192.png" },
  [PRIYA]: { name: "Priya", email: null, image: null },
};

const SLACK_ENV_OVERRIDES: Record<string, string | undefined> = {
  SLACK_SIGNING_SECRET: "test-signing-secret",
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_LEGACY_TEAM_ID: TEAM,
  SLACK_APP_TOKEN: undefined,
  SLACK_CHANNEL_ALLOWLIST: undefined,
  SLACK_DEFAULT_ENGINE: "mock",
  SLACK_IDENTITY_LOOKUP_MS: "300",
};
const savedEnv: Record<string, string | undefined> = {};

const calls = { userInfo: [] as string[], permalinks: [] as string[] };
let stuckAborted = false;
let gatedCalls = 0;
let flakyCalls = 0;
function permalinkFor(channel: string, ts: string): string {
  return `https://example.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}
const ok = async () => ({ ok: true as const, ts: `${Date.now()}.000001` });
const client: SlackClient = {
  postMessage: ok,
  updateMessage: ok,
  addReaction: ok,
  uploadFile: ok,
  setSessionStatus: ok,
  setThreadStatus: ok,
  startStream: ok,
  appendStream: ok,
  stopStream: ok,
  userInfo: ({ user: id, signal }) => {
    calls.userInfo.push(id);
    if (id === STUCK || (id === GATED && gatedCalls++ === 0)) {
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          if (id === STUCK) stuckAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    }
    if (id === GATED) return Promise.resolve({ name: "Gated", email: null, image: null });
    if (id === FLAKY) return Promise.resolve(flakyCalls++ === 0 ? null : { name: "Flaky", email: null, image: null });
    return Promise.resolve(PROFILES[id] ?? null);
  },
  getPermalink: async ({ channel, messageTs }) => {
    calls.permalinks.push(`${channel}:${messageTs}`);
    return permalinkFor(channel, messageTs);
  },
};

let org: OrgSession;
let userId: string;

function envelope(event: NonNullable<SlackEnvelope["event"]>): SlackEnvelope {
  return {
    type: "event_callback",
    event_id: `Ev${uid("id")}`,
    team_id: TEAM,
    authorizations: [{ user_id: BOT }],
    event,
  };
}

async function runIdForMessage(channel: string, ts: string): Promise<string> {
  const [row] = await db
    .select({ runId: commands.runId })
    .from(commands)
    .where(and(eq(commands.orgId, org.orgId), eq(commands.idempotencyKey, `slack-event:${TEAM}:${channel}:${ts}`)))
    .limit(1);
  if (!row?.runId) throw new Error(`no run accepted for ${channel}:${ts}`);
  return row.runId;
}

async function runRow(id: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  if (!row) throw new Error(`run ${id} missing`);
  return row;
}

/** The lookup row a run's stamp still owes, or null once it landed. */
async function owedLookup(id: string) {
  const [row] = await db
    .select()
    .from(slackIdentityLookups)
    .where(eq(slackIdentityLookups.runId, id))
    .limit(1);
  return row ?? null;
}

/** The run once its stamp landed: the claim never waits for it, so tests do. */
function stampedRow(id: string) {
  return waitFor(async () => {
    const row = await runRow(id);
    return row.connector ? row : null;
  });
}

beforeAll(async () => {
  // The boot pump is kicked by every persisted event; this suite drives the
  // same claim handler explicitly so each assertion follows a finished claim.
  await stopSlackInboxPumpForTest();
  for (const [key, value] of Object.entries(SLACK_ENV_OVERRIDES)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  org = await createOrgSession("identity");
  const [me] = await db.select({ id: user.id }).from(user).where(eq(user.email, org.email)).limit(1);
  if (!me) throw new Error("session user missing");
  userId = me.id;
  await upsertSlackWorkspace({ teamId: TEAM, orgId: org.orgId, userId });
  for (const slackUserId of [SUNDAR, PRIYA, GHOST, STUCK, GATED, FLAKY]) {
    await upsertSlackUser({ teamId: TEAM, slackUserId, orgId: org.orgId, userId });
  }
  setSlackClientForTest(client);
});

afterAll(() => {
  startSlackInboxPump(handleSlackInboxClaim);
  setSlackClientForTest(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("slack turn identity", () => {
  const channel = `C${uid("ch").replace(/[^a-z0-9]/gi, "").toUpperCase()}`;
  const rootTs = "1700000000.000100";
  const replyTs = "1700000000.000200";
  const ghostTs = "1700000000.000300";
  const mention = envelope({
    type: "app_mention",
    channel,
    user: SUNDAR,
    text: `<@${BOT}> summarize the deploy`,
    ts: rootTs,
  });

  test("an accepted mention is stamped with the sender's name, avatar and permalink, and the web reads it", async () => {
    expect(await persistSlackInboxEvent(mention)).toBe("created");
    await processSlackInbox(handleSlackInboxClaim);
    const runId = await runIdForMessage(channel, rootTs);
    const row = await stampedRow(runId);
    expect(row.connector).toEqual({
      source: "slack",
      sender_name: "Sundar",
      sender_avatar_url: "https://avatars.example/sundar-192.png",
      permalink: permalinkFor(channel, rootTs),
    });
    expect(calls.userInfo).toEqual([SUNDAR]);
    expect(calls.permalinks).toEqual([`${channel}:${rootTs}`]);

    const single = await json<{ connector: unknown }>(`/api/runs/${runId}`, { cookies: org.cookies });
    expect(single.status).toBe(200);
    expect(single.body.connector).toEqual(row.connector);
    const summaries = await json<{ runs: Array<{ id: string; connector: unknown }> }>(
      "/api/runs?view=summary",
      { cookies: org.cookies },
    );
    expect(summaries.body.runs.find((run) => run.id === runId)?.connector).toEqual(row.connector);
  });

  test("a replayed delivery keeps the stamp and asks Slack nothing again", async () => {
    expect(await persistSlackInboxEvent(mention)).toBe("duplicate");
    await processSlackInbox(handleSlackInboxClaim);
    const row = await runRow(await runIdForMessage(channel, rootTs));
    expect(row.connector?.sender_name).toBe("Sundar");
    expect(calls.userInfo).toEqual([SUNDAR]);
    expect(calls.permalinks).toEqual([`${channel}:${rootTs}`]);
  });

  test("a repeated sender resolves once; the permalink is fetched per message", async () => {
    const againTs = "1700000000.000150";
    await persistSlackInboxEvent(envelope({
      type: "message",
      channel,
      user: SUNDAR,
      text: "one more from the same person",
      ts: againTs,
      thread_ts: rootTs,
    }));
    await processSlackInbox(handleSlackInboxClaim);
    const again = await stampedRow(await runIdForMessage(channel, againTs));
    expect(again.connector?.sender_name).toBe("Sundar");
    expect(again.connector?.permalink).toBe(permalinkFor(channel, againTs));
    expect(calls.userInfo).toEqual([SUNDAR]);
    expect(calls.permalinks).toEqual([`${channel}:${rootTs}`, `${channel}:${againTs}`]);
  });

  test("a thread reply from another member is stamped as its own turn", async () => {
    await persistSlackInboxEvent(envelope({
      type: "message",
      channel,
      user: PRIYA,
      text: "and the rollback plan",
      ts: replyTs,
      thread_ts: rootTs,
    }));
    await processSlackInbox(handleSlackInboxClaim);
    const rootId = await runIdForMessage(channel, rootTs);
    const reply = await stampedRow(await runIdForMessage(channel, replyTs));
    expect(reply.parentRunId).toBe(rootId);
    expect(reply.threadId).toBe(rootId);
    expect(reply.connector).toEqual({
      source: "slack",
      sender_name: "Priya",
      sender_avatar_url: null,
      permalink: permalinkFor(channel, replyTs),
    });
  });

  test("a sender Slack cannot describe still carries the connector and permalink", async () => {
    await persistSlackInboxEvent(envelope({
      type: "message",
      channel,
      user: GHOST,
      text: "one more thing",
      ts: ghostTs,
      thread_ts: rootTs,
    }));
    await processSlackInbox(handleSlackInboxClaim);
    const ghostId = await runIdForMessage(channel, ghostTs);
    const row = await stampedRow(ghostId);
    expect(row.connector).toEqual({
      source: "slack",
      sender_name: null,
      sender_avatar_url: null,
      permalink: permalinkFor(channel, ghostTs),
    });
    // The sender is still owed: the row stays for a later attempt.
    expect(await owedLookup(ghostId)).not.toBeNull();
  });

  test("a failed lookup is not remembered: the next message resolves the name and the sweep completes the earlier turn", async () => {
    const firstTs = "1700000000.000610";
    const secondTs = "1700000000.000620";
    await persistSlackInboxEvent(envelope({ type: "message", channel, user: FLAKY, text: "first", ts: firstTs, thread_ts: rootTs }));
    await processSlackInbox(handleSlackInboxClaim);
    const firstId = await runIdForMessage(channel, firstTs);
    const first = await stampedRow(firstId);
    expect(first.connector?.sender_name).toBeNull();
    expect(first.connector?.permalink).toBe(permalinkFor(channel, firstTs));
    expect(await owedLookup(firstId)).not.toBeNull();

    await persistSlackInboxEvent(envelope({ type: "message", channel, user: FLAKY, text: "second", ts: secondTs, thread_ts: rootTs }));
    await processSlackInbox(handleSlackInboxClaim);
    const secondId = await runIdForMessage(channel, secondTs);
    const second = await waitFor(async () => {
      const row = await runRow(secondId);
      return row.connector?.sender_name ? row : null;
    });
    expect(second.connector?.sender_name).toBe("Flaky");
    await waitFor(async () => ((await owedLookup(secondId)) === null ? true : null));

    // The earlier turn is still owed its sender; the boot sweep fills it in.
    expect(await recoverSlackTurnIdentities()).toBeGreaterThanOrEqual(1);
    expect((await runRow(firstId)).connector).toEqual({
      source: "slack",
      sender_name: "Flaky",
      sender_avatar_url: null,
      permalink: permalinkFor(channel, firstTs),
    });
    expect(await owedLookup(firstId)).toBeNull();
    expect(flakyCalls).toBe(2);
  });

  test("a lookup that never completes neither holds the inbox nor loses the turn", async () => {
    const stuckTs = "1700000000.000400";
    const afterTs = "1700000000.000500";
    await persistSlackInboxEvent(envelope({
      type: "message",
      channel,
      user: STUCK,
      text: "still there?",
      ts: stuckTs,
      thread_ts: rootTs,
    }));
    await persistSlackInboxEvent(envelope({
      type: "message",
      channel,
      user: PRIYA,
      text: "and after that",
      ts: afterTs,
      thread_ts: rootTs,
    }));
    // The pass finishes without the stuck lookup: both claims are done and both
    // runs accepted before any stamp resolved.
    await processSlackInbox(handleSlackInboxClaim);
    const stuckId = await runIdForMessage(channel, stuckTs);
    const afterId = await runIdForMessage(channel, afterTs);
    const stuck = await stampedRow(stuckId);
    expect(stuck.connector).toEqual({
      source: "slack",
      sender_name: null,
      sender_avatar_url: null,
      permalink: permalinkFor(channel, stuckTs),
    });
    expect(stuckAborted).toBe(true);
    expect((await stampedRow(afterId)).connector?.sender_name).toBe("Priya");
  });

  test("the intent outlives the claim, and the boot sweep finishes a stamp a crash left behind", async () => {
    // A generous deadline keeps the detached stamp waiting on the gated lookup
    // while the sweep runs, which is the crash sequence without a crash.
    process.env.SLACK_IDENTITY_LOOKUP_MS = "5000";
    try {
      const gatedTs = "1700000000.000600";
      const event = envelope({
        type: "message",
        channel,
        user: GATED,
        text: "gated",
        ts: gatedTs,
        thread_ts: rootTs,
      });
      await persistSlackInboxEvent(event);
      await processSlackInbox(handleSlackInboxClaim);
      const [inbox] = await db
        .select({ state: commands.state })
        .from(commands)
        .where(eq(commands.id, slackInboxKey(event)))
        .limit(1);
      expect(inbox?.state).toBe("completed");
      const gatedId = await runIdForMessage(channel, gatedTs);
      expect((await runRow(gatedId)).connector).toBeNull();
      expect(await owedLookup(gatedId)).toMatchObject({
        teamId: TEAM,
        channel,
        messageTs: gatedTs,
        slackUserId: GATED,
      });
      expect(await recoverSlackTurnIdentities()).toBeGreaterThanOrEqual(1);
      expect((await runRow(gatedId)).connector).toEqual({
        source: "slack",
        sender_name: "Gated",
        sender_avatar_url: null,
        permalink: permalinkFor(channel, gatedTs),
      });
      expect(await owedLookup(gatedId)).toBeNull();
      expect(await recoverSlackTurnIdentities()).toBe(0);
    } finally {
      process.env.SLACK_IDENTITY_LOOKUP_MS = "300";
    }
  });

  test("a run row held by a terminal write neither holds the inbox pass nor loses the intent", async () => {
    const heldTs = "1700000000.000700";
    const nextTs = "1700000000.000800";
    // The first event's run is accepted first so its row can be held the way
    // finalization holds it (finalize.ts takes the row for update) while the
    // same event is delivered again and a second event follows it.
    const held = envelope({ type: "message", channel, user: SUNDAR, text: "held", ts: heldTs, thread_ts: rootTs });
    await persistSlackInboxEvent(held);
    await processSlackInbox(handleSlackInboxClaim);
    const heldId = await runIdForMessage(channel, heldTs);
    await stampedRow(heldId);
    // Back to "owed": the redelivery below must record the intent while the row is held.
    await db.update(runs).set({ connector: null }).where(eq(runs.id, heldId));
    const release = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select id from runs where id = ${heldId} for update`);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      expect(await persistSlackInboxEvent(held)).toBe("duplicate");
      await persistSlackInboxEvent(envelope({
        type: "message",
        channel,
        user: PRIYA,
        text: "next",
        ts: nextTs,
        thread_ts: rootTs,
      }));
      const started = Date.now();
      const pass = await processSlackInbox(handleSlackInboxClaim);
      const elapsedMs = Date.now() - started;
      expect(pass.requeued).toBe(0);
      expect(pass.failed).toBe(0);
      expect(elapsedMs).toBeLessThan(5_000);
      // The intent is durable although the row is held, and the next event was
      // handled in the same pass.
      expect(await owedLookup(heldId)).toMatchObject({ teamId: TEAM, channel, messageTs: heldTs, slackUserId: SUNDAR });
      expect((await runRow(heldId)).connector).toBeNull();
      expect((await stampedRow(await runIdForMessage(channel, nextTs))).connector?.sender_name).toBe("Priya");
    } finally {
      release.resolve();
      await holder;
    }
    // Once the row is free the stamp that was waiting lands and the owed row goes.
    expect((await stampedRow(heldId)).connector?.sender_name).toBe("Sundar");
    await waitFor(async () => ((await owedLookup(heldId)) === null ? true : null));
  });

  test("a turn typed in the product carries no connector", async () => {
    const id = uid("web");
    await createRun({
      id,
      prompt: "typed here",
      model: "claude-opus-5",
      engine: "mock",
      orgId: org.orgId,
      userId,
      parentRunId: null,
      threadId: id,
      repos: [],
      memoryScope: "org",
    });
    const single = await json<{ connector: unknown }>(`/api/runs/${id}`, { cookies: org.cookies });
    expect(single.status).toBe(200);
    expect(single.body.connector).toBeNull();
  });
});

describe("stampSlackTurnIdentity", () => {
  test("stamps once, wakes the thread stream, and is a no-op afterwards", async () => {
    const id = uid("stamp");
    await createRun({
      id,
      prompt: "from slack",
      model: "claude-opus-5",
      engine: "mock",
      orgId: org.orgId,
      userId,
      parentRunId: null,
      threadId: id,
      repos: [],
      memoryScope: "org",
    });
    const signals: ThreadChange[] = [];
    const unsubscribe = subscribeThread(id, (change) => signals.push(change));
    try {
      const before = (await runRow(id)).updatedAt.getTime();
      const intent = { runId: id, teamId: TEAM, channel: "C0STAMP", messageTs: "1700000001.000100", slackUserId: SUNDAR };
      expect(await recordSlackTurnIdentityIntent(intent)).toBe("recorded");
      expect(await recordSlackTurnIdentityIntent(intent)).toBe("already_recorded");
      expect(await stampSlackTurnIdentity(id)).toBe("stamped");
      expect(signals).toEqual([{ runId: id, kind: "created" }]);
      const row = await runRow(id);
      expect(row.connector?.sender_name).toBe("Sundar");
      expect(await owedLookup(id)).toBeNull();
      // The row's clock moves so an open session merges the stamped projection.
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(await stampSlackTurnIdentity(id)).toBe("unavailable");
      // A late redelivery records the intent again; the stamp finds the row done and cleans up.
      expect(await recordSlackTurnIdentityIntent(intent)).toBe("recorded");
      expect(await stampSlackTurnIdentity(id)).toBe("already_stamped");
      expect(await owedLookup(id)).toBeNull();
      expect(signals).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  test("an owed lookup is never expired while its run is unstamped; only finished or orphaned rows go", async () => {
    const aged = uid("aged");
    await createRun({
      id: aged,
      prompt: "from slack, long ago",
      model: "claude-opus-5",
      engine: "mock",
      orgId: org.orgId,
      userId,
      parentRunId: null,
      threadId: aged,
      repos: [],
      memoryScope: "org",
    });
    const intent = { teamId: TEAM, channel: "C0SWEEP", messageTs: "1700000002.000100", slackUserId: SUNDAR };
    expect(await recordSlackTurnIdentityIntent({ runId: aged, ...intent })).toBe("recorded");
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await db.update(slackIdentityLookups).set({ createdAt: eightDaysAgo }).where(eq(slackIdentityLookups.runId, aged));
    // Rows nothing can finish: a run that is gone, and a run already stamped.
    const orphan = uid("orphan");
    await db.insert(slackIdentityLookups).values({ runId: orphan, ...intent, createdAt: eightDaysAgo });
    const done = uid("done");
    await createRun({
      id: done,
      prompt: "already stamped",
      model: "claude-opus-5",
      engine: "mock",
      orgId: org.orgId,
      userId,
      parentRunId: null,
      threadId: done,
      repos: [],
      memoryScope: "org",
    });
    await db.update(runs).set({ connector: { source: "slack", sender_name: "Done", sender_avatar_url: null, permalink: null } }).where(eq(runs.id, done));
    await db.insert(slackIdentityLookups).values({ runId: done, ...intent });

    expect(await recoverSlackTurnIdentities()).toBeGreaterThanOrEqual(1);
    expect((await runRow(aged)).connector?.sender_name).toBe("Sundar");
    expect(await owedLookup(aged)).toBeNull();
    expect(await owedLookup(orphan)).toBeNull();
    expect(await owedLookup(done)).toBeNull();
    expect((await runRow(done)).connector?.sender_name).toBe("Done");
  });

  test("a run that does not exist or owes nothing is reported, never invented", async () => {
    expect(await stampSlackTurnIdentity(uid("missing"))).toBe("unavailable");
    const id = uid("owes-nothing");
    await createRun({
      id,
      prompt: "typed here",
      model: "claude-opus-5",
      engine: "mock",
      orgId: org.orgId,
      userId,
      parentRunId: null,
      threadId: id,
      repos: [],
      memoryScope: "org",
    });
    expect(await stampSlackTurnIdentity(id)).toBe("unavailable");
    expect((await runRow(id)).connector).toBeNull();
  });
});
