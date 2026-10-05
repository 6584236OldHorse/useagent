/**
 * Slack-born turns carry who sent them for the web. Fully in-process, zero live
 * Slack: events enter through the durable inbox and the same claim handler the
 * boot pump runs; users.info and chat.getPermalink are answered by a recording
 * client (this is a recording transport, not a live Slack certification).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { commands, runs, user } from "../src/db/schema";
import { createRun } from "../src/runs/repo";
import { subscribeThread, type ThreadChange } from "../src/runs/thread-signals";
import { handleSlackInboxClaim, setSlackClientForTest, type SlackClient } from "../src/slack";
import type { SlackEnvelope } from "../src/slack/events";
import {
  persistSlackInboxEvent,
  processSlackInbox,
  startSlackInboxPump,
  stopSlackInboxPumpForTest,
} from "../src/slack/inbox";
import { stampSlackTurnIdentity } from "../src/slack/turn-identity";
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
    if (id === STUCK) {
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => {
          stuckAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    }
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
  for (const slackUserId of [SUNDAR, PRIYA, GHOST, STUCK]) {
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
    const row = await stampedRow(await runIdForMessage(channel, ghostTs));
    expect(row.connector).toEqual({
      source: "slack",
      sender_name: null,
      sender_avatar_url: null,
      permalink: permalinkFor(channel, ghostTs),
    });
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
      const input = { runId: id, orgId: org.orgId, teamId: TEAM, channel: "C0STAMP", messageTs: "1700000001.000100", slackUserId: SUNDAR };
      expect(await stampSlackTurnIdentity(input)).toBe("stamped");
      expect(signals).toEqual([{ runId: id, kind: "created" }]);
      const row = await runRow(id);
      expect(row.connector?.sender_name).toBe("Sundar");
      // The row's clock moves so an open session merges the stamped projection.
      expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(await stampSlackTurnIdentity(input)).toBe("already_stamped");
      expect(signals).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  test("a run that does not exist is reported, never invented", async () => {
    expect(
      await stampSlackTurnIdentity({
        runId: uid("missing"),
        orgId: org.orgId,
        teamId: TEAM,
        channel: "C0STAMP",
        messageTs: "1700000001.000200",
        slackUserId: SUNDAR,
      }),
    ).toBe("unavailable");
  });
});
