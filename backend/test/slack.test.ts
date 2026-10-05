/**
 * Slack adapter tests — fully in-process, zero live Slack. Inbound events are
 * signed with the test signing secret (preload.ts) and posted to the mounted
 * route; outbound Slack calls are intercepted with setSlackClientForTest, so
 * addReaction/postMessage are recorded, never sent.
 *
 * Covers: signature verification (valid / bad / stale / missing), the
 * url_verification handshake, event dedupe, app_mention → root run, thread
 * reply → parent_run_id, thread-follow via the durable mapping, DM handling,
 * non-mention channel chatter ignored, the 👀 ack, and the completion post-back.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { artifacts, commands, member, runs, slackOutbox, slackRunResponses, slackThreads, user, userUploads } from "../src/db/schema";
import { artifactStorage } from "../src/artifacts/storage";
import { finalizeRun } from "../src/runs/finalize";
import { createRun, insertStep, updateStepCode } from "../src/runs/repo";
import { bus, channel as runChannel } from "../src/worker";
import { CARD_FLUSH_MS, watchSlackRun } from "../src/slack/watcher";
import {
  createSlackRunResponse,
  findSlackRunResponse,
  linkSlackThread,
} from "../src/slack/repo";
import {
  enqueueAddReaction,
  enqueueAppendStream,
  enqueuePostCard,
  enqueueStartStream,
  enqueueThreadStatus,
  getSlackOutbox,
  kickSlackOutbox,
} from "../src/slack/outbox";
import { buildRunCard } from "../src/slack/card";
import { markdownChunksFor, openingStreamChunks, taskUpdateChunk } from "../src/slack/streaming";
import { turnStream } from "../src/runs/turn-stream";
import { DEV_ORG_ID, DEV_USER_ID } from "../src/seed";
import { setSlackClientForTest, type SlackClient } from "../src/slack";
import { bindInvitedSlackSender, requestSlackAccess } from "../src/slack/access-requests";
import { handleSlackEvent, resetSlackDeduperForTest, type SlackEnvelope } from "../src/slack/events";
import { setInboundFileDownloaderForTest } from "../src/slack/inbound-files";
import {
  persistSlackInboxEvent,
  processSlackInbox,
  maintainSlackInboxRetention,
  setSlackInboxBeforePersistInsertForTest,
  setSlackInboxPersisterForTest,
  slackInboxKey,
  slackInboxThreadId,
  SLACK_INBOX_EVENT,
  startSlackInboxPump,
  stopSlackInboxPumpForTest,
  verifySlackInboxIdentity,
  type SlackInboxClaim,
  type SlackInboxOutcome,
  type SlackInboxPayload,
} from "../src/slack/inbox";
import { dispatchSocketFrame } from "../src/slack/socket-mode";
import { composeSlackReplyText } from "../src/slack/reply";
import {
  findSlackUser,
  findSlackWorkspace,
  syncSlackWorkspaceBindings,
  upsertSlackUser,
  upsertSlackWorkspace,
} from "../src/slack/workspaces";
import { createOrgSession, fetchApi, json, uid, waitFor } from "./helpers";
import { acceptConnectorRunCommand, acceptRunCommand, setRunAdmission } from "../src/commands";
import { UploadScanError, setUploadScannerForTest } from "../src/uploads/scan";

// This DB-backed integration suite shares the CI Postgres service with the
// full backend matrix. Keep its bounded async waits above Bun's 5s unit-test
// default so normal runner contention is not misclassified as a product hang.
setDefaultTimeout(15_000);

const SECRET = "test-signing-secret"; // this suite signs every inbound event with it
const BOT = "U0BOTBOT";
// The mapped test workspace: registered in beforeAll (slack_workspaces), so its
// events are attributed to the dev org/user. Unmapped teams must be IGNORED.
const TEAM = "T0TESTTEAM";

// Hermetic Slack env. Bun auto-loads backend/.env, so the REAL SLACK_* creds
// leak into the test process and would override what this suite assumes: the
// real signing secret makes every signed event fail verification (401), and a
// real app token could open a live Socket Mode WS. Pin the values this suite
// depends on and restore whatever .env carried, so it is hermetic regardless of
// the machine's .env.
const SLACK_ENV_OVERRIDES: Record<string, string | undefined> = {
  SLACK_SIGNING_SECRET: SECRET,
  SLACK_BOT_TOKEN: "xoxb-test-token",
  SLACK_LEGACY_TEAM_ID: TEAM,
  SLACK_APP_TOKEN: undefined, // keep a real app token out of the suite entirely
  // Operator scoping must not leak in from a machine's .env: an allowlist
  // would silently drop this suite's random channels, org/user pinning would
  // break the dev-org assertions, and a real engine/model selection (codex)
  // needs live provider credentials this suite does not have.
  SLACK_CHANNEL_ALLOWLIST: undefined,
  SLACK_DEFAULT_ORG_ID: undefined,
  SLACK_DEFAULT_USER_ID: undefined,
  SLACK_DEFAULT_ENGINE: undefined,
  SLACK_DEFAULT_MODEL: undefined,
};
const savedSlackEnv: Record<string, string | undefined> = {};

interface Recorded {
  reactions: Array<{ channel: string; timestamp: string; name: string }>;
  messages: Array<{ channel: string; text: string; threadTs?: string; blocks?: unknown[] }>;
  updates: Array<{ channel: string; ts: string; text: string; blocks?: unknown[] }>;
  sessionStatuses: Array<{ channel: string; threadTs: string; status: "processing" | "active" }>;
  threadStatuses: Array<{ channel: string; threadTs: string; status: string }>;
  streams: Array<{
    op: "start" | "append" | "stop";
    channel: string;
    threadTs: string;
    messageTs?: string;
    mode?: string;
    recipientTeamId?: string;
    recipientUserId?: string;
    blocks?: readonly unknown[];
    chunks?: readonly unknown[];
  }>;
  uploads: Array<{ channel: string; filename: string; threadTs?: string; bytes: Buffer }>;
}
const rec: Recorded = {
  reactions: [],
  messages: [],
  updates: [],
  sessionStatuses: [],
  threadStatuses: [],
  streams: [],
  uploads: [],
};
/** When true the mock rejects agents.sessions.setStatus — the non-assistant fallback case. */
let statusFails = false;
/** When set, chat.update returns this failure (drives the update-fallback path). */
let updateResult: import("../src/slack/client").DeliveryResult = { ok: true };
/** When set, chat.startStream returns this failure (drives the fallback-once path). */
let startStreamResult: import("../src/slack/client").DeliveryResult | null = null;
/** When set, chat.appendStream returns this failure (drives the mid-run fallback). */
let appendStreamResult: import("../src/slack/client").DeliveryResult | null = null;
/** When set, chat.stopStream returns this failure (drives stream fallback paths). */
let stopStreamResult: import("../src/slack/client").DeliveryResult = { ok: true };
/** Synthetic message ts source — the card post returns one so updates can target it. */
let tsSeq = 1000;

/** The FINAL answer text delivered to a thread: the last card update (in place)
 *  when the card path drove it, else the last posted message. One helper so an
 *  assertion is agnostic to whether the answer updated the card or fell back to a
 *  fresh post. */
function finalAnswerFor(channel: string, threadTs: string): string | null {
  const stopped = [...rec.streams].reverse().find((s) => s.op === "stop" && s.channel === channel && s.threadTs === threadTs);
  if (stopped?.chunks) {
    const text = stopped.chunks
      .map((chunk) => {
        const c = chunk as { type?: unknown; text?: unknown };
        return c && typeof c === "object" && c.type === "markdown_text" ? String(c.text ?? "") : "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  const update = [...rec.updates].reverse().find((u) => u.channel === channel);
  if (update) return update.text;
  const msg = [...rec.messages].reverse().find((m) => m.channel === channel && m.threadTs === threadTs);
  return msg?.text ?? null;
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(SLACK_ENV_OVERRIDES)) {
    savedSlackEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Bind the test workspace to the dev org/user — ingress fails closed for any
  // team without such a row (covered below).
  await upsertSlackWorkspace({ teamId: TEAM, orgId: DEV_ORG_ID, userId: DEV_USER_ID });
  await upsertSlackUser({
    teamId: TEAM,
    slackUserId: "U-HUMAN",
    orgId: DEV_ORG_ID,
    userId: DEV_USER_ID,
  });
  setSlackClientForTest({
    addReaction: async (a) => {
      rec.reactions.push(a);
      return { ok: true };
    },
    postMessage: async (m) => {
      rec.messages.push(m);
      // A card post (carries blocks) returns a ts so later chat.update targets it.
      return m.blocks ? { ok: true, ts: `${tsSeq++}.1` } : { ok: true };
    },
    updateMessage: async (u) => {
      if (updateResult.ok) rec.updates.push(u);
      return updateResult;
    },
    setSessionStatus: async (s) => {
      if (statusFails) return { ok: false, class: "permanent", message: "invalid_thread" };
      rec.sessionStatuses.push(s);
      return { ok: true };
    },
    setThreadStatus: async (s) => {
      rec.threadStatuses.push(s);
      return { ok: true };
    },
    startStream: async (s) => {
      if (startStreamResult) return startStreamResult;
      rec.streams.push({
        op: "start",
        channel: s.channel,
        threadTs: s.threadTs,
        mode: s.taskDisplayMode,
        recipientTeamId: s.recipientTeamId,
        recipientUserId: s.recipientUserId,
        chunks: s.chunks,
      });
      return { ok: true, ts: `${tsSeq++}.1` };
    },
    appendStream: async (s) => {
      if (appendStreamResult) return appendStreamResult;
      rec.streams.push({ op: "append", channel: s.channel, threadTs: s.threadTs, messageTs: s.messageTs, chunks: s.chunks });
      return { ok: true };
    },
    stopStream: async (s) => {
      rec.streams.push({ op: "stop", channel: s.channel, threadTs: s.threadTs, messageTs: s.messageTs, chunks: s.chunks, blocks: s.blocks });
      return stopStreamResult;
    },
    uploadFile: async (u) => {
      rec.uploads.push(u);
      return { ok: true };
    },
  });
});

afterAll(() => {
  setSlackClientForTest(null);
  for (const [k, saved] of Object.entries(savedSlackEnv)) {
    if (saved === undefined) delete process.env[k];
    else process.env[k] = saved;
  }
});

function sign(timestamp: string, raw: string): string {
  return "v0=" + createHmac("sha256", SECRET).update(`v0:${timestamp}:${raw}`).digest("hex");
}

async function postSlack(
  envelope: unknown,
  opts: { timestamp?: string; signature?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const raw = JSON.stringify(envelope);
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const signature = opts.signature ?? sign(ts, raw);
  return fetchApi("/api/slack/events", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": ts,
      ...(opts.headers ?? {}),
    },
  });
}

function eventCallback(
  event: Record<string, unknown>,
  /** The envelope's workspace; `null` omits team_id entirely (fail-closed case). */
  teamId: string | null = TEAM,
): Record<string, unknown> {
  return {
    type: "event_callback",
    event_id: `Ev${uid("id")}`,
    ...(teamId === null ? {} : { team_id: teamId }),
    authorizations: [{ user_id: BOT }],
    event,
  };
}

/** Find a Slack-created run (dev org) by its exact cleaned prompt. */
async function findRunByPrompt(prompt: string): Promise<any | null> {
  const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
  return body.runs.find((r) => r.prompt === prompt) ?? null;
}

async function deleteSlackDeliveryRows(runId: string, teamId = TEAM): Promise<void> {
  await db.delete(slackRunResponses).where(eq(slackRunResponses.runId, runId));
  await db.execute(sql`
    delete from ${slackOutbox}
    where idempotency_key in (
      ${`slack-status:start:${teamId}:${runId}`},
      ${`slack-stream:start:${teamId}:${runId}`},
      ${`slack-status:final:${teamId}:${runId}`},
      ${`slack-reply:${teamId}:${runId}`}
    )
  `);
}

async function replaySlackInboxClaim(claim: SlackInboxClaim): Promise<SlackInboxOutcome> {
  const identity = await verifySlackInboxIdentity(claim.payload);
  if (identity.status === "ignored") return { status: "completed" };
  if (identity.status === "rebound") return { status: "permanent", error: identity.error };
  const outcome = await handleSlackEvent(claim.payload.envelope, {
    identity,
    stagedAttachmentIds: claim.payload.stagedAttachmentIds,
    checkpointStagedAttachmentIds: claim.checkpointStagedAttachmentIds,
  });
  if (
    outcome.status === "accepted" ||
    outcome.status === "replayed" ||
    outcome.status === "permanent_noop"
  ) {
    return { status: "completed" };
  }
  if (outcome.status === "waiting_for_root") return { status: "waiting_for_root" };
  return { status: "retryable_unavailable", error: outcome.reason };
}

function restartSlackInboxPumpForTest(): void {
  startSlackInboxPump(replaySlackInboxClaim);
}

describe("slack signature verification", () => {
  test("url_verification handshake echoes the challenge (signed)", async () => {
    const res = await postSlack({ type: "url_verification", challenge: "c-123" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "c-123" });
  });

  test("a bad signature is rejected 401", async () => {
    const res = await postSlack({ type: "url_verification", challenge: "x" }, {
      signature: "v0=deadbeef",
    });
    expect(res.status).toBe(401);
  });

  test("a stale timestamp (>5m) is rejected 401", async () => {
    const old = (Math.floor(Date.now() / 1000) - 600).toString();
    // Sign correctly for the stale ts — it must still fail on the skew check.
    const res = await postSlack({ type: "url_verification", challenge: "x" }, {
      timestamp: old,
    });
    expect(res.status).toBe(401);
  });

  test("a missing signature header is rejected 401", async () => {
    const res = await fetchApi("/api/slack/events", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "x" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  test("a verified HTTP event is not ACKed when inbox persistence fails", async () => {
    const marker = uid("persist-fail");
    setSlackInboxPersisterForTest(async () => {
      throw new Error("synthetic inbox outage");
    });
    try {
      const res = await postSlack(eventCallback({
        type: "app_mention",
        channel: `C${uid("ch")}`,
        user: "U-HUMAN",
        text: `<@${BOT}> ${marker}`,
        ts: `${uid("ts")}.1`,
      }));
      expect(res.status).toBe(503);
      expect(await findRunByPrompt(marker)).toBeNull();
    } finally {
      setSlackInboxPersisterForTest(null);
    }
  });
});

describe("slack event → run", () => {
  test("connector provenance rejects source-null replays even with historical Slack receipts", async () => {
    const channel = `C${uid("source")}`;
    const ts = `${uid("ts")}.1`;
    const threadTs = `${uid("thread")}.1`;
    const rootRunId = crypto.randomUUID();
    const reservedKey = `slack-event:${TEAM}:${channel}:${ts}`;
    const command = (
      id: string,
      idempotencyKey: string,
      threadId = id,
      parentRunId: string | null = null,
    ) => ({
      idempotencyKey,
      orgId: DEV_ORG_ID,
      actorId: DEV_USER_ID,
      run: {
        id,
        prompt: "source replay",
        model: "claude-opus-5",
        engine: "mock" as const,
        parentRunId,
        threadId,
        repos: [],
        resolvedResources: [],
        attachmentIds: [],
        memoryScope: "org" as const,
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    });

    expect(await acceptRunCommand(command(crypto.randomUUID(), reservedKey))).toEqual({
      status: "conflict",
      reason: "source_mismatch",
    });

    await createRun({
      id: rootRunId,
      prompt: "linked root",
      model: "claude-opus-5",
      engine: "mock",
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
      parentRunId: null,
      threadId: rootRunId,
    });
    await linkSlackThread({
      teamId: TEAM,
      channel,
      threadTs,
      rootRunId,
      orgId: DEV_ORG_ID,
    });
    const original = command(
      crypto.randomUUID(),
      uid("legacy-source"),
      rootRunId,
      rootRunId,
    );
    const created = await acceptRunCommand(original);
    expect(created.status).toBe("created");
    await db
      .update(commands)
      .set({ idempotencyKey: reservedKey })
      .where(eq(commands.runId, original.run.id));
    await finalizeRun(original.run.id, "completed", "web reply", 1);
    expect(await findSlackRunResponse(original.run.id)).toMatchObject({
      runId: original.run.id,
      teamId: TEAM,
      channel,
      threadTs,
    });

    const envelope = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> source replay`,
      ts,
      thread_ts: threadTs,
    });
    expect(await persistSlackInboxEvent(envelope)).toBe("created");
    const replay = () => acceptConnectorRunCommand({
      ...command(crypto.randomUUID(), reservedKey, rootRunId, rootRunId),
      source: "slack" as const,
    });
    expect(await replay()).toEqual({ status: "conflict", reason: "source_mismatch" });
    const [stored] = await db
      .select({ payload: commands.payload })
      .from(commands)
      .where(eq(commands.runId, original.run.id));
    expect(JSON.parse(stored!.payload!).source).toBeNull();

    await enqueueAddReaction({
      idempotencyKey: `slack-ack:${TEAM}:${channel}:${ts}`,
      orgId: DEV_ORG_ID,
      teamId: TEAM,
      channel,
      timestamp: ts,
      name: "eyes",
    });
    // Historical Slack and public collisions are indistinguishable once the
    // old classifier has minted these same receipts, so neither may be adopted.
    expect(await replay()).toEqual({ status: "conflict", reason: "source_mismatch" });
    const [stillUntrusted] = await db
      .select({ payload: commands.payload })
      .from(commands)
      .where(eq(commands.runId, original.run.id));
    expect(JSON.parse(stillUntrusted!.payload!).source).toBeNull();

    expect(await acceptRunCommand(
      command(crypto.randomUUID(), reservedKey, rootRunId, rootRunId),
    )).toEqual({
      status: "conflict",
      reason: "source_mismatch",
    });
    const [unchanged] = await db
      .select({ payload: commands.payload })
      .from(commands)
      .where(eq(commands.runId, original.run.id));
    expect(JSON.parse(unchanged!.payload!).source).toBeNull();
  });

  test("an unavailable linked GitHub repo blocks the run with actionable guidance", async () => {
    const marker = uid("repo");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const res = await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> test ${marker} <https://github.com/upstream-org/backend/pull/19625>`,
        ts,
      }),
    );
    expect(res.status).toBe(200);
    const outcome = await waitFor(async () => {
      const run = await findRunByPrompt(
        `test ${marker} <https://github.com/upstream-org/backend/pull/19625>`,
      );
      const guidance = rec.messages.find(
        (message) =>
          message.channel === channel &&
          message.threadTs === ts &&
          /upstream-org\/backend/i.test(message.text) &&
          /access|connect|select/i.test(message.text),
      );
      return run || guidance ? { run, guidance } : null;
    });
    expect(outcome.run).toBeNull();
    expect(outcome.guidance?.text).toMatch(/access|connect|select/i);
  });

  test("app_mention creates a root run, 👀-acks, and posts the summary", async () => {
    const marker = uid("mention");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const res = await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> build ${marker}`,
        ts,
      }),
    );
    expect(res.status).toBe(200);

    // Prompt is cleaned (mention stripped) and scoped to the dev org.
    const run = await waitFor(async () => findRunByPrompt(`build ${marker}`));
    expect(run.prompt).toBe(`build ${marker}`);
    expect(run.org_id).toBe("org-skynet-dev");
    expect(run.parent_run_id).toBeNull();
    expect(run.thread_id).toBe(run.id); // a root run threads under itself
    const [persisted] = await db
      .select({ origin: runs.origin })
      .from(runs)
      .where(eq(runs.id, run.id))
      .limit(1);
    expect(persisted?.origin).toBeNull();

    // 👀 ack targeted the triggering message (now delivered via the durable
    // outbox relay, so wait for it rather than asserting synchronously).
    await waitFor(async () =>
      rec.reactions.some((r) => r.channel === channel && r.timestamp === ts && r.name === "eyes") || null,
    );

    // A Slack-native stream opens in the thread; on settle it is stopped with
    // final chunks and Block Kit blocks.
    await waitFor(async () =>
      rec.streams.find((s) => s.op === "start" && s.channel === channel && s.threadTs === ts) ?? null,
    );
    const answer = await waitFor(async () => finalAnswerFor(channel, ts));
    expect(answer!.length).toBeGreaterThan(0);
    // The native stream body closes with the reply text (the summary for a
    // completed run, the failure line for a failed one).
    const done = await json<any>(`/api/runs/${run.id}`);
    expect(answer).toContain(done.body.summary);
    const stopped = rec.streams.find((s) => s.op === "stop" && s.channel === channel && s.threadTs === ts);
    // The root task card settles alongside (complete or error, never spinning).
    const runTask = (stopped?.chunks as any[]).find((c) => c.type === "task_update" && c.id === "run");
    expect(["complete", "error"]).toContain(runTask.status);
    const actions = (stopped?.blocks as any[]).find((b) => b.type === "actions");
    expect(actions.elements[0].url).toContain(`/session/${run.thread_id}`);
  });

  test("a model directive picks the model for a new thread and strips from the prompt", async () => {
    const marker = uid("directive");
    const channel = `C${uid("ch")}`;
    const res = await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> model:sonnet build ${marker}`,
        ts: `${uid("ts")}.1`,
      }),
    );
    expect(res.status).toBe(200);
    const run = await waitFor(async () => findRunByPrompt(`build ${marker}`));
    expect(run.model).toBe("claude-sonnet-5");
    expect(run.engine).toBe("opencode");
  });

  test("a mid-thread engine switch request gets guidance instead of a cross-engine run", async () => {
    const marker = uid("engswitch");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> build ${marker}`,
        ts: rootTs,
      }),
    );
    const root = await waitFor(async () => findRunByPrompt(`build ${marker}`));

    const res = await postSlack(
      eventCallback({
        type: "message",
        channel,
        user: "U-HUMAN",
        text: `engine:codex continue ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );
    expect(res.status).toBe(200);
    // Guidance reply lands in the thread; NO cross-engine run is created.
    const msg = await waitFor(async () =>
      rec.messages.find((m) => m.channel === channel && m.threadTs === rootTs && m.text.includes("cannot switch engines")) ?? null,
    );
    expect(msg.text).toContain(root.engine);
    expect(await findRunByPrompt(`continue ${marker}`)).toBeNull();
  });

  test("a completed slack run shares its artifacts back into the thread", async () => {
    // Build a running run directly (finalizeRun is now first-writer-wins, so a
    // re-finalize of an already-settled run is a no-op by design - the artifact
    // must exist BEFORE the single finalize). Root a Slack thread, publish the
    // artifact, then finalize ONCE as completed.
    const runId = crypto.randomUUID();
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    await createRun({ id: runId, prompt: "share build", model: "claude-opus-5", engine: "mock", orgId: DEV_ORG_ID, userId: null, parentRunId: null, threadId: runId });
    await linkSlackThread({ teamId: TEAM, channel, threadTs: ts, rootRunId: runId, orgId: DEV_ORG_ID });
    await createSlackRunResponse({ runId, teamId: TEAM, channel, threadTs: ts });
    const artifactBytes = Buffer.from("png-bytes");
    const storageKey = createHash("sha256").update(artifactBytes).digest("hex");
    await artifactStorage().put(storageKey, artifactBytes);
    await db.insert(artifacts).values({
      orgId: DEV_ORG_ID,
      runId,
      threadId: runId,
      sourcePath: "/work/shot.png",
      name: "shot.png",
      contentType: "image/png",
      sizeBytes: 9,
      sha256: storageKey,
      storageKey,
    });
    await finalizeRun(runId, "completed", "All done, screenshot attached.", 1);

    const upload = await waitFor(async () =>
      rec.uploads.find((u) => u.channel === channel && u.filename === "shot.png") ?? null,
    );
    expect(upload.threadTs).toBe(ts);
    expect(Buffer.from(upload.bytes).toString()).toBe("png-bytes");
  });

  test("a long reply is CHUNKED into sequential thread messages, in order", async () => {
    // Root a Slack thread directly (no HTTP round trip needed) and finalize with
    // a summary far past one Slack message: the outbox relay must deliver it as
    // ordered chunks in the SAME thread, continuation-marked, none truncated.
    const runId = crypto.randomUUID();
    const channel = `C${uid("long")}`;
    const ts = `${uid("ts")}.1`;
    await createRun({ id: runId, prompt: "long reply", model: "claude-opus-5", engine: "mock", orgId: DEV_ORG_ID, userId: null, parentRunId: null, threadId: runId });
    await linkSlackThread({ teamId: TEAM, channel, threadTs: ts, rootRunId: runId, orgId: DEV_ORG_ID });
    await createSlackRunResponse({ runId, teamId: TEAM, channel, threadTs: ts });
    const summary = Array.from({ length: 50 }, (_, i) => `finding ${i}: ${"detail ".repeat(30)}`).join("\n\n");
    await finalizeRun(runId, "completed", summary, 1);

    await waitFor(async () =>
      rec.messages.filter((m) => m.channel === channel).length >= 3 ? true : null,
    );
    const mine = rec.messages.filter((m) => m.channel === channel);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const m of mine) {
      expect(m.threadTs).toBe(ts); // every chunk stays in the thread
      expect(m.text.length).toBeLessThanOrEqual(3900);
    }
    expect(mine[0]!.text.startsWith("finding 0:")).toBe(true); // head first
    for (const m of mine.slice(0, -1)) expect(m.text.endsWith("_(continued…)_")).toBe(true);
    expect(mine.at(-1)!.text).toContain("finding 49:"); // nothing dropped
  });

  test("the channel allowlist drops events from unlisted channels and admits listed ones", async () => {
    const allowed = `C${uid("ok")}`;
    process.env.SLACK_CHANNEL_ALLOWLIST = ` ${allowed} , C0LISTED2 `;
    try {
      const blockedMarker = uid("blocked");
      const blockedRes = await postSlack(
        eventCallback({
          type: "app_mention",
          channel: `C${uid("nope")}`,
          user: "U-HUMAN",
          text: `<@${BOT}> build ${blockedMarker}`,
          ts: `${uid("ts")}.1`,
        }),
      );
      expect(blockedRes.status).toBe(200); // acked to Slack, silently dropped
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await findRunByPrompt(`build ${blockedMarker}`)).toBeNull();

      const allowedMarker = uid("allowed");
      const allowedRes = await postSlack(
        eventCallback({
          type: "app_mention",
          channel: allowed,
          user: "U-HUMAN",
          text: `<@${BOT}> build ${allowedMarker}`,
          ts: `${uid("ts")}.1`,
        }),
      );
      expect(allowedRes.status).toBe(200);
      const run = await waitFor(async () => findRunByPrompt(`build ${allowedMarker}`));
      expect(run.prompt).toBe(`build ${allowedMarker}`);
    } finally {
      delete process.env.SLACK_CHANNEL_ALLOWLIST;
    }
  });

  test("a thread reply becomes a parent_run_id follow-up in the same thread", async () => {
    const marker = uid("thread");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("ts")}.1`;

    await postSlack(
      eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> root ${marker}`, ts: rootTs }),
    );
    const root = await waitFor(async () => findRunByPrompt(`root ${marker}`));

    // A mention inside the same Slack thread (Slack sends app_mention w/ thread_ts).
    await postSlack(
      eventCallback({
        type: "app_mention",
        channel,
        user: "U-HUMAN",
        text: `<@${BOT}> more ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );
    const reply = await waitFor(async () => findRunByPrompt(`more ${marker}`));

    expect(reply.parent_run_id).toBe(root.id);
    expect(reply.thread_id).toBe(root.id); // shares the root's thread
    const [command] = await db
      .select({ payload: commands.payload })
      .from(commands)
      .where(and(eq(commands.runId, reply.id), eq(commands.kind, "run.create")))
      .limit(1);
    expect(JSON.parse(command!.payload).source).toBe("slack");
    expect(await getSlackOutbox(`slack-web-user:${TEAM}:${reply.id}`)).toBeNull();

    // The whole thread reads back oldest→newest from the run API.
    const thread = await json<{ thread: any[] }>(`/api/runs/${root.id}?thread=1`);
    expect(thread.body.thread.map((r) => r.id)).toEqual([root.id, reply.id]);
  });

  test("a web reply mirrors its author into the linked Slack thread once without arming mentions", async () => {
    const rootId = crypto.randomUUID();
    const channel = `C${uid("web-mirror")}`;
    const threadTs = `${uid("ts")}.1`;
    await createRun({
      id: rootId,
      prompt: "linked root",
      model: "claude-opus-5",
      engine: "mock",
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
      parentRunId: null,
      threadId: rootId,
    });
    await linkSlackThread({ teamId: TEAM, channel, threadTs, rootRunId: rootId, orgId: DEV_ORG_ID });
    await finalizeRun(rootId, "completed", "root ready", 1);

    const prompt = `web _mirror_ ${uid("prompt")} <!channel>\n\`code * ~ & <tag>\``;
    const idempotencyKey = uid("web-mirror-key");
    const body = { prompt, parent_run_id: rootId };
    const first = await json<{ id: string }>("/api/runs", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body,
    });
    const replay = await json<{ id: string }>("/api/runs", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body,
    });
    expect(first.status).toBe(201);
    expect(replay).toEqual({ status: 200, body: { id: first.body.id } });

    const mirror = await waitFor(async () =>
      rec.messages.find((message) =>
        message.channel === channel && message.text.includes(" in useAgent:")
      ) ?? null,
    );
    expect(mirror.threadTs).toBe(threadTs);
    expect(mirror.text).toContain("@\u200bchannel");
    expect(mirror.text).not.toContain("<!channel>");
    expect(mirror.text).toContain("\n`code * ~ &amp; &lt;tag&gt;`");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      rec.messages.filter((message) =>
        message.channel === channel && message.text.includes(" in useAgent:")
      ),
    ).toHaveLength(1);
  });

  test("finalization heals a missing web mirror before its bot result", async () => {
    const rootId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const channel = `C${uid("web-heal")}`;
    const threadTs = `${uid("ts")}.1`;
    await createRun({
      id: rootId,
      prompt: "linked root",
      model: "claude-opus-5",
      engine: "mock",
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
      parentRunId: null,
      threadId: rootId,
    });
    await linkSlackThread({ teamId: TEAM, channel, threadTs, rootRunId: rootId, orgId: DEV_ORG_ID });
    const prompt = `healed mirror ${uid("prompt")}`;
    await acceptRunCommand({
      idempotencyKey: uid("web-heal-key"),
      orgId: DEV_ORG_ID,
      actorId: DEV_USER_ID,
      run: {
        id: runId,
        prompt,
        model: "claude-opus-5",
        engine: "mock",
        parentRunId: rootId,
        threadId: rootId,
        repos: [],
        resolvedResources: [],
        attachmentIds: [],
        memoryScope: "org",
        skillId: null,
        skillVersion: null,
        skillContentHash: null,
        commandName: null,
        commandProvider: null,
        commandSessionId: null,
        commandCatalogRevision: null,
      },
    });

    await finalizeRun(runId, "completed", "healed result", 1);
    await waitFor(async () =>
      rec.messages.filter((message) => message.channel === channel).length >= 2 ? true : null,
    );
    const delivered = rec.messages
      .filter((message) => message.channel === channel)
      .map((message) => message.text);
    expect(delivered[0]).toContain(" in useAgent:");
    expect(delivered[0]).toContain(prompt);
    expect(delivered.at(-1)).toContain("healed result");
  });

  test("a link-free thread reply reauthorizes a legacy repository before inheriting it", async () => {
    const rootId = crypto.randomUUID();
    const marker = uid("repo-follow");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("ts")}.1`;
    await createRun({
      id: rootId,
      prompt: `test the linked PR ${marker}`,
      model: "claude-opus-5",
      engine: "mock",
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
      parentRunId: null,
      threadId: rootId,
      repos: ["upstream-org/backend:feature/pr-19625"],
      memoryScope: "org",
    });
    await linkSlackThread({
      teamId: TEAM,
      channel,
      threadTs: rootTs,
      rootRunId: rootId,
      orgId: DEV_ORG_ID,
    });

    await postSlack(
      eventCallback({
        type: "message",
        channel,
        channel_type: "channel",
        user: "U-HUMAN",
        text: `verify both deployments ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await findRunByPrompt(`verify both deployments ${marker}`)).toBeNull();
    await waitFor(
      async () =>
        rec.messages.find(
          (message) =>
            message.channel === channel &&
            message.threadTs === rootTs &&
            message.text.includes("GitHub is not connected"),
        ) ?? null,
      { timeoutMs: 14_000 },
    );
  });

  test("a non-mention thread reply is followed when the bot rooted that thread", async () => {
    const marker = uid("follow");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> start ${marker}`, ts: rootTs }),
    );
    const root = await waitFor(async () => findRunByPrompt(`start ${marker}`));

    // Plain channel message (NO mention) in the known thread → still ours.
    await postSlack(
      eventCallback({
        type: "message",
        channel,
        channel_type: "channel",
        user: "U-HUMAN",
        text: `follow ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );
    const follow = await waitFor(async () => findRunByPrompt(`follow ${marker}`));
    expect(follow.parent_run_id).toBe(root.id);
  });

  test("a DM message creates a run without a mention", async () => {
    const marker = uid("dm");
    const res = await postSlack(
      eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: `hey ${marker}`,
        ts: `${uid("ts")}.1`,
      }),
    );
    expect(res.status).toBe(200);
    const run = await waitFor(async () => findRunByPrompt(`hey ${marker}`));
    expect(run.parent_run_id).toBeNull();
  });

  test("duplicate delivery (same channel:ts) creates only one run", async () => {
    const marker = uid("dup");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const event = { type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> once ${marker}`, ts };
    // Slack retries reuse the same (channel, ts); envelopes may differ (event_id).
    await postSlack(eventCallback(event));
    await postSlack(eventCallback(event));
    const run = await waitFor(async () => findRunByPrompt(`once ${marker}`));

    const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
    expect(body.runs.filter((r) => r.prompt === `once ${marker}`).length).toBe(1);
    const [command] = await db
      .select({ payload: commands.payload })
      .from(commands)
      .where(and(eq(commands.runId, run.id), eq(commands.kind, "run.create")))
      .limit(1);
    expect(JSON.parse(command!.payload).source).toBe("slack");
    expect(await getSlackOutbox(`slack-web-user:${TEAM}:${run.id}`)).toBeNull();
  });

  test("a non-mention channel message in an unknown thread is ignored", async () => {
    const marker = uid("ignore");
    const envelope = eventCallback({
      type: "message",
      channel: `C${uid("ch")}`,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `noise ${marker}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const res = await postSlack(envelope);
    expect(res.status).toBe(200); // acknowledged...
    // ...but no run created (give any async work a beat to NOT happen).
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`noise ${marker}`)).toBeNull();
    const [inbox] = await db.select().from(commands).where(eq(commands.id, slackInboxKey(envelope)));
    expect(inbox).toBeUndefined(); // pure envelope gate runs before persistence
  });

  test("the bot's own message is ignored (loop guard)", async () => {
    const marker = uid("self");
    await postSlack(
      eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: BOT, // authored by the bot itself
        text: `echo ${marker}`,
        ts: `${uid("ts")}.1`,
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`echo ${marker}`)).toBeNull();
  });

  test("assistant status: shimmer set on start, cleared before the summary posts", async () => {
    const marker = uid("status");
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({ type: "message", channel, channel_type: "im", user: "U-HUMAN", text: `go ${marker}`, ts }),
    );
    const run = await waitFor(async () => findRunByPrompt(`go ${marker}`));

    // The official Agents session status clears back to "active" when the run settles.
    await waitFor(
      async () =>
        rec.sessionStatuses.some((s) => s.channel === channel && s.threadTs === ts && s.status === "active") || null,
      { timeoutMs: 14_000 },
    );

    const mine = rec.sessionStatuses.filter((s) => s.channel === channel && s.threadTs === ts);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine[0]?.status).toBe("processing");
    expect(mine[mine.length - 1]?.status).toBe("active");
    expect(run.id).toBeTruthy();
  });

  test("DM shimmer: free-text status set at accept and cleared when the run settles", async () => {
    const marker = uid("shimmertext");
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({ type: "message", channel, channel_type: "im", user: "U-HUMAN", text: `go ${marker}`, ts }),
    );
    await waitFor(async () => findRunByPrompt(`go ${marker}`));
    // Cleared (empty status) once the run settles - durably, from finalize.
    await waitFor(
      async () => rec.threadStatuses.some((s) => s.channel === channel && s.status === "") || null,
      { timeoutMs: 14_000 },
    );
    const mine = rec.threadStatuses.filter((s) => s.channel === channel && s.threadTs === ts);
    expect(mine[0]?.status).toBe("is thinking...");
    expect(mine[mine.length - 1]?.status).toBe("");
  });

  test("a channel thread never gets the DM-only free-text status", async () => {
    const marker = uid("noshimmer");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    await postSlack(
      eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> run ${marker}`, ts }),
    );
    await waitFor(async () => findRunByPrompt(`run ${marker}`));
    await waitFor(async () => finalAnswerFor(channel, ts), { timeoutMs: 14_000 });
    expect(rec.threadStatuses.some((s) => s.channel === channel)).toBe(false);
  });

  test("assistant status failing (non-assistant context) never blocks the summary post", async () => {
    statusFails = true;
    try {
      const marker = uid("nostatus");
      const channel = `C${uid("ch")}`;
      const ts = `${uid("ts")}.1`;
      await postSlack(
        eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> run ${marker}`, ts }),
      );
      await waitFor(async () => findRunByPrompt(`run ${marker}`));
      // setStatus rejects every call, yet the completion surface still lands.
      const answer = await waitFor(async () => finalAnswerFor(channel, ts), { timeoutMs: 14_000 });
      expect(answer!.length).toBeGreaterThan(0);
    } finally {
      statusFails = false;
    }
  });
});

// Slack-native stream delivery keeps the legacy Block Kit card as fallback. The
// durable outbox relay delivers each row; assertions waitFor the delivered state.
describe("slack native stream and Block Kit fallback", () => {
  /** Root a Slack thread with a run, WITHOUT posting a card (card_ts stays null). */
  async function rootThread(prompt: string): Promise<{ runId: string; channel: string; ts: string }> {
    const runId = crypto.randomUUID();
    const channel = `C${uid("card")}`;
    const ts = `${uid("ts")}.1`;
    await createRun({ id: runId, prompt, model: "claude-opus-5", engine: "mock", orgId: DEV_ORG_ID, userId: null, parentRunId: null, threadId: runId });
    await linkSlackThread({ teamId: TEAM, channel, threadTs: ts, rootRunId: runId, orgId: DEV_ORG_ID });
    await createSlackRunResponse({ runId, teamId: TEAM, channel, threadTs: ts });
    return { runId, channel, ts };
  }

  test("post_card posts blocks + a url button and stores the returned message ts", async () => {
    const { runId, channel, ts } = await rootThread("card post");
    const card = buildRunCard({
      title: "card post",
      phase: "queued",
      model: "claude-opus-5",
      repoSpecs: [{ repo: "loop/backend", branch: "main" }],
      webUrl: `https://app.example.com/session/${runId}`,
    });
    await enqueuePostCard({
      idempotencyKey: `slack-card:${TEAM}:${runId}`,
      orgId: DEV_ORG_ID,
      teamId: TEAM,
      channel,
      threadTs: ts,
      runId,
      blocks: card.blocks,
      text: card.text,
    });

    const posted = await waitFor(async () =>
      rec.messages.find((m) => m.channel === channel && m.blocks) ?? null,
    );
    const actions = (posted.blocks as any[]).find((b) => b.type === "actions");
    expect(actions.elements[0].url).toBe(`https://app.example.com/session/${runId}`);
    // The returned ts is persisted on the thread for later chat.update.
    const link = await waitFor(async () => {
      const l = await findSlackRunResponse(runId);
      return l?.fallbackMessageTs ? l : null;
    });
    expect(link.fallbackMessageTs).toBeTruthy();
  });

  test("finalize updates the fallback card when only a fallback message ts exists", async () => {
    const { runId, channel, ts } = await rootThread("stream stop");
    const queued = buildRunCard({ title: "stream stop", phase: "queued", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
    await enqueuePostCard({ idempotencyKey: `slack-card:${TEAM}:${runId}`, orgId: DEV_ORG_ID, teamId: TEAM, channel, threadTs: ts, runId, blocks: queued.blocks, text: queued.text });
    const cardTs = (await waitFor(async () => {
      const l = await findSlackRunResponse(runId);
      return l?.fallbackMessageTs ? l : null;
    })).fallbackMessageTs!;
    expect(cardTs).toBeTruthy();

    const beforeMessages = rec.messages.length;
    await finalizeRun(runId, "completed", "the answer", 1);
    const update = await waitFor(async () =>
      rec.updates.find((u) => u.channel === channel && u.ts === cardTs) ?? null,
    );
    expect(update.channel).toBe(channel);
    expect(finalAnswerFor(channel, ts)).toBe(composeSlackReplyText("completed", "the answer"));
    // Re-finalizing never double-posts (idempotent by slack-reply:<runId>).
    const before = rec.streams.length + rec.updates.length + rec.messages.length;
    await finalizeRun(runId, "completed", "the answer", 1);
    await new Promise((r) => setTimeout(r, 150));
    expect(rec.streams.length + rec.updates.length + rec.messages.length).toBe(before);
    expect(rec.messages.length).toBe(beforeMessages);
  });

  test("update_card falls back to a plain post when there is NO card ts (answer never lost)", async () => {
    const { runId, channel, ts } = await rootThread("no card");
    // No post_card enqueued → card_ts is null. Finalize must still deliver the
    // answer as a plain message.
    await finalizeRun(runId, "completed", "fallback answer", 1);
    const msg = await waitFor(async () =>
      rec.messages.find((m) => m.channel === channel && m.threadTs === ts && !m.blocks && m.text.includes("fallback answer")) ?? null,
    );
    expect(msg.text).toContain("fallback answer");
    // Nothing was updated (no card to update).
    expect(rec.updates.some((u) => u.channel === channel)).toBe(false);
  });

  test("permanent stream and card update failures fall back to a fresh reply", async () => {
    const { runId, channel, ts } = await rootThread("stream update fails");
    const queued = buildRunCard({ title: "stream update fails", phase: "queued", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
    await enqueuePostCard({ idempotencyKey: `slack-card:${TEAM}:${runId}`, orgId: DEV_ORG_ID, teamId: TEAM, channel, threadTs: ts, runId, blocks: queued.blocks, text: queued.text });
    await waitFor(async () => {
      const l = await findSlackRunResponse(runId);
      return l?.fallbackMessageTs ? true : null;
    });

    stopStreamResult = { ok: false, class: "permanent", message: "stream_not_found" };
    updateResult = { ok: false, class: "permanent", message: "message_not_found" };
    try {
      await finalizeRun(runId, "completed", "recovered answer", 1);
      // The permanent stream/card failures must not strand the answer: it posts fresh.
      const msg = await waitFor(async () =>
        rec.messages.find((m) => m.channel === channel && !m.blocks && m.text.includes("recovered answer")) ?? null,
      );
      expect(msg.threadTs).toBe(ts);
    } finally {
      stopStreamResult = { ok: true };
      updateResult = { ok: true };
    }
  });

  test("progress fallback card carries a 'working: <step>' line", () => {
    const running = buildRunCard({ title: "progress", phase: "running", model: "m", repoSpecs: [], webUrl: "https://x/session/1", workingStep: "cloning repo" });
    const contexts = (running.blocks as any[]).filter((b) => b.type === "context");
    expect(contexts.some((c) => c.elements[0].text.includes("working: cloning repo"))).toBe(true);
  });

  /** Enqueue the run's native stream start (timeline mode, wire-shape chunks). */
  async function startNativeStream(t: { runId: string; channel: string; ts: string }, title: string): Promise<void> {
    const card = buildRunCard({ title, phase: "queued", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
    await enqueueStartStream({
      idempotencyKey: `slack-stream:start:${TEAM}:${t.runId}`,
      orgId: DEV_ORG_ID,
      teamId: TEAM,
      channel: t.channel,
      threadTs: t.ts,
      runId: t.runId,
      taskDisplayMode: "timeline",
      chunks: openingStreamChunks(title),
      recipientTeamId: TEAM,
      recipientUserId: "U-HUMAN",
      fallbackBlocks: card.blocks,
      fallbackText: card.text,
    });
  }

  test("start_stream sends timeline mode, recipient identity, and FLAT task chunks", async () => {
    const t = await rootThread("wire shapes");
    await startNativeStream(t, "wire shapes");
    const started = await waitFor(async () =>
      rec.streams.find((s) => s.op === "start" && s.channel === t.channel) ?? null,
    );
    expect(started.mode).toBe("timeline");
    expect(started.recipientTeamId).toBe(TEAM);
    expect(started.recipientUserId).toBe("U-HUMAN");
    expect(started.chunks?.[0]).toEqual({
      type: "task_update",
      id: "run",
      title: "wire shapes",
      status: "in_progress",
    });
  });

  test("a start_stream API error falls back ONCE to the Block Kit card (no retry storm)", async () => {
    const t = await rootThread("stream unavailable");
    startStreamResult = { ok: false, class: "transient", message: "feature_not_enabled" };
    try {
      await startNativeStream(t, "stream unavailable");
      // The SAME delivery attempt posts the card fallback and settles the row.
      const posted = await waitFor(async () =>
        rec.messages.find((m) => m.channel === t.channel && m.blocks) ?? null,
      );
      expect(posted.threadTs).toBe(t.ts);
      const row = await waitFor(async () => {
        const candidate = await getSlackOutbox(`slack-stream:start:${TEAM}:${t.runId}`);
        return candidate?.state === "delivered" ? candidate : null;
      });
      expect(row.state).toBe("delivered");
      expect(row?.attemptCount).toBe(0); // never re-attempted
      const response = await findSlackRunResponse(t.runId);
      expect(response?.nativeStreamTs).toBeNull();
      expect(response?.fallbackMessageTs).toBeTruthy();
    } finally {
      startStreamResult = null;
    }
  });

  test("narration appends fence on their offset and the stop appends ONLY the tail", async () => {
    const t = await rootThread("narration tail");
    await startNativeStream(t, "narration tail");
    await waitFor(async () => ((await findSlackRunResponse(t.runId))?.nativeStreamTs ? true : null));

    const card = buildRunCard({ title: "narration tail", phase: "running", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
    const append = (seq: number, text: string, offset: number) =>
      enqueueAppendStream({
        idempotencyKey: `slack-stream:text:${TEAM}:${t.runId}:${seq}`,
        orgId: DEV_ORG_ID,
        teamId: TEAM,
        channel: t.channel,
        threadTs: t.ts,
        runId: t.runId,
        chunks: markdownChunksFor(text),
        narrationOffset: offset,
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
    // OUT OF ORDER on purpose: the second segment lands first and must wait on
    // the offset fence until the first is accepted.
    await append(2, "world", 6);
    await append(1, "Hello ", 0);
    await waitFor(async () => {
      kickSlackOutbox(); // the test relay never ticks; drive retry passes
      const response = await findSlackRunResponse(t.runId);
      return response?.streamedChars === 11 ? true : null;
    });

    // The live narration buffer carries the full reply; the stop appends only
    // the un-streamed tail ("!") plus no closing (the reply was streamed).
    turnStream.publish(t.runId, "Hello world!");
    await finalizeRun(t.runId, "completed", "Hello world!", 1);
    const stopped = await waitFor(async () =>
      rec.streams.find((s) => s.op === "stop" && s.channel === t.channel) ?? null,
    );
    expect(finalAnswerFor(t.channel, t.ts)).toBe("!");
    // The native-stop card stays chrome-only: linked title, no answer section.
    const sections = (stopped.blocks as any[]).filter((b) => b.type === "section");
    expect(sections).toHaveLength(1);
    expect(sections[0].text.text).toContain("narration tail");
    expect(sections[0].text.text).not.toContain("Hello world!");
  });

  test("an append API error disables the native stream without stray posts", async () => {
    const t = await rootThread("append dies");
    await startNativeStream(t, "append dies");
    await waitFor(async () => ((await findSlackRunResponse(t.runId))?.nativeStreamTs ? true : null));

    appendStreamResult = { ok: false, class: "permanent", message: "message_not_in_streaming_state" };
    const messagesBefore = rec.messages.length;
    try {
      const card = buildRunCard({ title: "append dies", phase: "running", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
      await enqueueAppendStream({
        idempotencyKey: `slack-stream:step:${TEAM}:${t.runId}:s1`,
        orgId: DEV_ORG_ID,
        teamId: TEAM,
        channel: t.channel,
        threadTs: t.ts,
        runId: t.runId,
        chunks: [taskUpdateChunk({ id: "step_s1", title: "working", status: "in_progress" })],
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
      await waitFor(async () => {
        const response = await findSlackRunResponse(t.runId);
        return response && response.nativeStreamTs === null ? true : null;
      });
      const row = await getSlackOutbox(`slack-stream:step:${TEAM}:${t.runId}:s1`);
      expect(row?.state).toBe("delivered"); // dropped progress, not a storm
      expect(rec.messages.length).toBe(messagesBefore); // and no stray surfaces
    } finally {
      appendStreamResult = null;
    }
  });

  /** Attach the live watcher to a streaming thread and return a step emitter
   *  that persists each step (finalize reads the durable rows) and publishes it
   *  on the run bus exactly as the worker does. */
  async function watchedThread(prompt: string) {
    const t = await rootThread(prompt);
    await startNativeStream(t, prompt);
    await waitFor(async () => ((await findSlackRunResponse(t.runId))?.nativeStreamTs ? true : null));
    watchSlackRun({ runId: t.runId, rootRunId: t.runId, orgId: DEV_ORG_ID, teamId: TEAM, channel: t.channel, threadTs: t.ts });
    let idx = 0;
    const publish = (step: Awaited<ReturnType<typeof insertStep>>) => {
      bus.emit(runChannel(t.runId), { type: "step", step });
      return step;
    };
    const emit = async (input: { kind: "command" | "file" | "task" | "done"; label: string; chip: string | null; code: unknown }) =>
      publish(await insertStep({ runId: t.runId, idx: idx++, ...input }));
    const revise = async (step: Awaited<ReturnType<typeof insertStep>>, code: unknown) =>
      publish((await updateStepCode(step.id, code))!);
    const cards = () =>
      rec.streams
        .filter((s) => s.op === "append" && s.channel === t.channel)
        .flatMap((s) => (s.chunks ?? []) as Array<Record<string, unknown>>)
        .filter((c) => c.type === "task_update");
    return { ...t, emit, revise, cards };
  }

  test("several tool calls stream one card each, revised in place, with the chatter absent and the answer last", async () => {
    const t = await watchedThread("quiet steps");
    const search = (query: string, activityKind: string, output?: string) => ({
      source: "t3", activityKind, tool: "web_search", input: { query }, ...(output ? { output } : {}), error: false,
    });
    await t.emit({ kind: "task", label: "Preparing context and runtime…", chip: "boot", code: { phase: "preparing" } });
    await t.emit({ kind: "task", label: "Waiting for provider activity…", chip: "runtime:claude", code: null });
    const first = await t.emit({ kind: "command", label: "Web search started", chip: "search", code: search("bun test timeout", "tool.started") });
    await t.revise(first, search("bun test timeout", "tool.completed", "Results:\nhttps://bun.sh/docs/cli/test"));
    const second = await t.emit({ kind: "command", label: "Web search started", chip: "search", code: search("bun bail flag", "tool.started") });
    await t.emit({ kind: "task", label: "Context window updated", chip: "thread.context.updated", code: { source: "t3", activityKind: "thread.context.updated" } });
    await t.emit({ kind: "done", label: "Done", chip: null, code: null }); // flushes the pending cards
    await waitFor(async () => t.cards().some((c) => c.id === `step_${second.id}`) || null);

    await finalizeRun(t.runId, "completed", "Use --timeout.", 1);
    const stopped = await waitFor(async () => rec.streams.find((s) => s.op === "stop" && s.channel === t.channel) ?? null);
    bus.emit(runChannel(t.runId), { type: "end", status: "completed" });

    // Chatter never became a card: only the two calls, under their stable ids
    // and the web UI's verb, the first settled in place with its sources.
    const cards = t.cards();
    expect(new Set(cards.map((c) => c.id))).toEqual(new Set([`step_${first.id}`, `step_${second.id}`]));
    expect(cards.every((c) => c.title === "Searched the web")).toBe(true);
    expect(cards.filter((c) => c.id === `step_${first.id}`).at(-1)).toMatchObject({
      status: "complete",
      details: "bun test timeout",
      sources: [{ type: "url", text: "https://bun.sh/docs/cli/test", url: "https://bun.sh/docs/cli/test" }],
    });
    // The stop carries the answer, restates the settled card, closes the call
    // still open, then the root task.
    expect(stopped.chunks).toEqual([
      { type: "markdown_text", text: "Use --timeout." },
      expect.objectContaining({ id: `step_${first.id}`, status: "complete", sources: [expect.objectContaining({ url: "https://bun.sh/docs/cli/test" })] }),
      expect.objectContaining({ id: `step_${second.id}`, title: "Searched the web", status: "complete", details: "bun bail flag" }),
      expect.objectContaining({ id: "run", status: "complete" }),
    ]);
  });

  test("finalizing right after a completion revision settles the card from its durable row", async () => {
    const t = await watchedThread("immediate stop");
    const call = await t.emit({ kind: "command", label: "Web search started", chip: "search", code: { source: "t3", activityKind: "tool.started", tool: "web_search", input: { query: "bun bail" } } });
    await t.revise(call, { source: "t3", activityKind: "tool.completed", tool: "web_search", input: { query: "bun bail" }, output: "https://bun.sh/docs/cli/test" });
    // Ten trailing chatter rows must not hide the call from finalization.
    for (let i = 0; i < 10; i++) {
      await t.emit({ kind: "task", label: "Context window updated", chip: "thread.context.updated", code: { source: "t3", activityKind: "thread.context.updated" } });
    }
    // No wait for the live append: the stop alone must carry the final card.
    await finalizeRun(t.runId, "completed", "Use --bail.", 1);
    const stopped = await waitFor(async () => rec.streams.find((s) => s.op === "stop" && s.channel === t.channel) ?? null);
    bus.emit(runChannel(t.runId), { type: "end", status: "completed" });
    expect(stopped.chunks).toEqual([
      { type: "markdown_text", text: "Use --bail." },
      expect.objectContaining({ id: `step_${call.id}`, title: "Searched the web", status: "complete", details: "bun bail", sources: [expect.objectContaining({ url: "https://bun.sh/docs/cli/test" })] }),
      expect.objectContaining({ id: "run", status: "complete" }),
    ]);
  });

  test("a retried older card batch keeps the cards it alone revised and drops the ones a newer batch already did", async () => {
    const t = await rootThread("stale retry");
    await startNativeStream(t, "stale retry");
    await waitFor(async () => ((await findSlackRunResponse(t.runId))?.nativeStreamTs ? true : null));
    const card = buildRunCard({ title: "stale retry", phase: "running", model: "m", repoSpecs: [], webUrl: "https://x/session/1" });
    const chunk = (id: string, status: "in_progress" | "complete") => taskUpdateChunk({ id, title: "Ran a command", status });
    const batch = (cardSeq: number, chunks: ReturnType<typeof chunk>[]) =>
      enqueueAppendStream({
        idempotencyKey: `slack-stream:step:${TEAM}:${t.runId}:${cardSeq}`,
        orgId: DEV_ORG_ID,
        teamId: TEAM,
        channel: t.channel,
        threadTs: t.ts,
        runId: t.runId,
        chunks,
        cardSeq,
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
    const appendsWith = (id: string) =>
      rec.streams.filter((s) => s.op === "append" && s.channel === t.channel && (s.chunks as any[]).some((c) => c.id === id));
    // Batch 2 (newer) completes B and lands first; batch 1 (older, a backed-off
    // retry) completes A and still shows B in progress. A's completion must land;
    // B's stale state must not. The fence is durable on the response row.
    await batch(2, [chunk("step_b", "complete")]);
    await waitFor(async () => appendsWith("step_b")[0] ?? null);
    await batch(1, [chunk("step_a", "complete"), chunk("step_b", "in_progress")]);
    await waitFor(async () => {
      const row = await getSlackOutbox(`slack-stream:step:${TEAM}:${t.runId}:1`);
      return row?.state === "delivered" ? row : null;
    });
    expect(appendsWith("step_a")).toHaveLength(1);
    expect(appendsWith("step_a")[0]!.chunks).toEqual([chunk("step_a", "complete")]);
    expect(appendsWith("step_b")).toHaveLength(1);
    expect((await findSlackRunResponse(t.runId))?.cardRevisions).toEqual({ step_a: 1, step_b: 2 });
  });

  test("finalization survives ten cards with long sources and a long answer", async () => {
    const t = await watchedThread("big stop");
    const url = (i: number) => `https://example.com/${i}/${"x".repeat(1800)}`;
    for (let i = 0; i < 10; i++) {
      const search = (activityKind: string, output?: string) => ({
        source: "t3", activityKind, tool: "web_search", input: { query: `q${i}` }, ...(output ? { output } : {}),
      });
      const call = await t.emit({ kind: "command", label: "Web search started", chip: "search", code: search("tool.started") });
      await t.revise(call, search("tool.completed", [1, 2, 3, 4, 5].map((k) => url(i * 10 + k)).join("\n")));
    }
    await finalizeRun(t.runId, "completed", "A".repeat(6_000), 1); // must not throw on payload size
    const stopped = await waitFor(async () => rec.streams.find((s) => s.op === "stop" && s.channel === t.channel) ?? null);
    bus.emit(runChannel(t.runId), { type: "end", status: "completed" });
    expect(stopped.chunks!.at(-1)).toMatchObject({ id: "run", status: "complete" });
    expect(JSON.stringify(stopped.chunks).length).toBeLessThan(20_000);
  });

  test("ten plan rows and ten native todowrite rows after an open call do not hide it from finalization", async () => {
    const t = await watchedThread("plan crowd");
    const call = await t.emit({ kind: "command", label: "bash", chip: null, code: { source: "t3", activityKind: "tool.started", tool: "bash", input: { command: "bun test" } } });
    for (let i = 0; i < 10; i++) {
      await t.emit({ kind: "command", label: "Update plan", chip: "plan", code: { source: "t3", activityKind: "turn.plan.updated", tool: "todowrite", input: { todos: [] } } });
      // A native todowrite call projects as a plain tool row (chip = its
      // activity kind, tool = todowrite), which only toolTaskChunk drops.
      await t.emit({ kind: "command", label: "todowrite", chip: "tool.completed", code: { source: "t3", activityKind: "tool.completed", tool: "todowrite", input: { todos: [{ content: `step ${i}`, status: "in_progress" }] }, output: "", error: false } });
    }
    await finalizeRun(t.runId, "completed", "Done.", 1);
    const stopped = await waitFor(async () => rec.streams.find((s) => s.op === "stop" && s.channel === t.channel) ?? null);
    bus.emit(runChannel(t.runId), { type: "end", status: "completed" });
    expect(stopped.chunks).toEqual([
      { type: "markdown_text", text: "Done." },
      expect.objectContaining({ id: `step_${call.id}`, title: "Ran a command", status: "complete" }),
      expect.objectContaining({ id: "run", status: "complete" }),
    ]);
  });

  test("a burst of card revisions coalesces into one append carrying the last revision", async () => {
    const t = await watchedThread("coalesce");
    const shell = (activityKind: string, output?: string) => ({
      source: "t3", activityKind, tool: "bash", input: { command: "bun test" }, ...(output ? { output } : {}),
    });
    const call = await t.emit({ kind: "command", label: "bash", chip: null, code: shell("tool.started") });
    for (let i = 1; i <= 20; i++) {
      bus.emit(runChannel(t.runId), { type: "step", step: { ...call, code_json: JSON.stringify(shell("tool.updated", `line ${i}`)) } });
    }
    await waitFor(async () => t.cards().length > 0 || null);
    await new Promise((r) => setTimeout(r, CARD_FLUSH_MS * 2));
    expect(rec.streams.filter((s) => s.op === "append" && s.channel === t.channel)).toHaveLength(1);
    expect(t.cards()).toEqual([
      { type: "task_update", id: `step_${call.id}`, title: "Ran a command", status: "in_progress", details: "bun test", output: "line 20" },
    ]);
    bus.emit(runChannel(t.runId), { type: "end", status: "completed" }); // detach the watcher
  });

  test("set_thread_status delivers once per idempotency key (replay-safe)", async () => {
    const marker = uid("shimmer");
    const runId = crypto.randomUUID();
    await createRun({ id: runId, prompt: marker, model: "m", engine: "mock", orgId: DEV_ORG_ID, userId: null, parentRunId: null, threadId: runId });
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    const entry = {
      idempotencyKey: `slack-thread-status:step:${TEAM}:${marker}`,
      orgId: DEV_ORG_ID,
      teamId: TEAM,
      channel,
      threadTs: ts,
      runId,
      status: `is working: ${marker}`,
    };
    await enqueueThreadStatus(entry);
    await enqueueThreadStatus(entry); // replay collapses on the key
    await waitFor(async () =>
      rec.threadStatuses.some((s) => s.status === `is working: ${marker}`) || null,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(rec.threadStatuses.filter((s) => s.status === `is working: ${marker}`)).toHaveLength(1);
  });
});

describe("slack durable inbox", () => {
  test("persists one duplicate event while closed and drains it once after restart/open", async () => {
    await stopSlackInboxPumpForTest();
    const operationId = `slack-deferred-test:${crypto.randomUUID()}`;
    const marker = uid("deferred");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const envelope = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> queued ${marker}`,
      ts,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);

    await setRunAdmission({
      open: false,
      operationId,
      actor: "test",
      reason: "Slack deployment deferral test",
    });
    try {
      expect((await postSlack(envelope)).status).toBe(200);
      resetSlackDeduperForTest();
      expect((await postSlack(envelope)).status).toBe(200);

      const inbox = await waitFor(async () => {
        const rows = await db
          .select()
          .from(commands)
          .where(eq(commands.id, inboxKey));
        return rows.length > 0 ? rows : null;
      });
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.kind).toBe(SLACK_INBOX_EVENT);
      expect(inbox[0]!.state).toBe("queued");
      expect(inbox[0]!.orgId).toBe(DEV_ORG_ID);
      expect(inbox[0]!.actorId).toBe(DEV_USER_ID);
      expect(await findRunByPrompt(`queued ${marker}`)).toBeNull();

      restartSlackInboxPumpForTest();
      await waitFor(async () => {
        const rows = await db
          .select({ payload: slackOutbox.payload })
          .from(slackOutbox)
          .where(eq(
            slackOutbox.idempotencyKey,
            `slack-admission-queued:${TEAM}:${channel}:${ts}`,
          ));
        return rows[0] ?? null;
      });
      await waitFor(async () => {
        const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
        return row?.state === "queued" && row.attemptCount === 0 ? row : null;
      });
      await stopSlackInboxPumpForTest();
      const [delayed] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      const defer = (JSON.parse(delayed.payload!) as {
        defer: { reason: string; nextAttemptAt: string };
      }).defer;
      expect(defer.reason).toBe("run_admission_closed");
      expect(Date.parse(defer.nextAttemptAt)).toBeGreaterThan(Date.now());
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({ claimed: 0 });
      expect(await findRunByPrompt(`queued ${marker}`)).toBeNull();

      // Simulate the deployment restart: the inbox row remains authoritative.
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "deployment complete",
      });
      restartSlackInboxPumpForTest();
      await waitFor(async () => findRunByPrompt(`queued ${marker}`));

      resetSlackDeduperForTest();
      expect((await postSlack(envelope)).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
      expect(body.runs.filter((run) => run.prompt === `queued ${marker}`)).toHaveLength(1);
      const [completed] = await db
        .select({ state: commands.state, attemptCount: commands.attemptCount })
        .from(commands)
        .where(eq(commands.id, inboxKey));
      expect(completed).toEqual({ state: "completed", attemptCount: 1 });
      const queuedNotices = await db
        .select({ payload: slackOutbox.payload })
        .from(slackOutbox)
        .where(eq(
          slackOutbox.idempotencyKey,
          `slack-admission-queued:${TEAM}:${channel}:${ts}`,
        ));
      expect(queuedNotices).toHaveLength(1);
      expect(queuedNotices[0]!.payload).toContain("start automatically");
      expect(
        rec.messages.some(
          (message) => message.channel === channel && message.text.includes("Retry this message"),
        ),
      ).toBe(false);
    } finally {
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "test cleanup",
      });
      restartSlackInboxPumpForTest();
    }
  });

  test("fails closed when the persisted sender binding changes before replay", async () => {
    await stopSlackInboxPumpForTest();
    const marker = uid("rebind");
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> rebind ${marker}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      expect((await postSlack(envelope)).status).toBe(200);
      await db.execute(sql`delete from slack_users where team_id = ${TEAM} and slack_user_id = 'U-HUMAN'`);
      restartSlackInboxPumpForTest();
      const failed = await waitFor(async () => {
        const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
        return row?.state === "failed" ? row : null;
      });
      expect(failed.error).toBe("slack_sender_binding_changed");
      expect(await findRunByPrompt(`rebind ${marker}`)).toBeNull();
    } finally {
      await upsertSlackUser({
        teamId: TEAM,
        slackUserId: "U-HUMAN",
        orgId: DEV_ORG_ID,
        userId: DEV_USER_ID,
      });
      restartSlackInboxPumpForTest();
    }
  });

  test("a stale worker cannot complete a claim reclaimed by a new worker", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> fence ${uid("fence")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    await persistSlackInboxEvent(envelope);
    let entered!: () => void;
    const claimed = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const staleWorker = processSlackInbox(async () => {
      entered();
      await blocked;
      return { status: "completed" };
    });
    await claimed;
    await db
      .update(commands)
      .set({ updatedAt: new Date(Date.now() - 31_000) })
      .where(eq(commands.id, inboxKey));
    expect(await processSlackInbox(async () => ({ status: "completed" }))).toMatchObject({
      claimed: 1,
      completed: 1,
    });
    release();
    expect(await staleWorker).toMatchObject({ claimed: 1, completed: 0 });
    const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
    expect(row.state).toBe("completed");
    restartSlackInboxPumpForTest();
  });

  test("the eighth processing error permanently fails the inbox row", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> retry cap ${uid("cap")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    await persistSlackInboxEvent(envelope);
    for (let attempt = 1; attempt <= 8; attempt++) {
      await processSlackInbox(async () => { throw new Error(`failure ${attempt}`); });
    }
    const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
    expect(row).toMatchObject({ state: "failed", attemptCount: 8, error: "failure 8" });
    restartSlackInboxPumpForTest();
  });

  test("retryable unavailability is delayed and resumes when due", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> unavailable ${uid("unavailable")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      await persistSlackInboxEvent(envelope);
      await processSlackInbox(async (claim) =>
        slackInboxKey(claim.payload.envelope) === inboxKey
          ? { status: "retryable_unavailable", error: "provider_unavailable" }
          : replaySlackInboxClaim(claim));
      let [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      const deferred = (JSON.parse(row.payload!) as {
        defer: { count: number; reason: string; nextAttemptAt: string };
      }).defer;
      expect(deferred).toMatchObject({ count: 1, reason: "provider_unavailable" });
      expect(Date.parse(deferred.nextAttemptAt)).toBeGreaterThan(Date.now());

      await processSlackInbox(async () => ({ status: "completed" }));
      [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row.state).toBe("queued");
      expect(row.attemptCount).toBe(0);

      const payload = JSON.parse(row.payload!) as SlackInboxPayload;
      await db.update(commands).set({
        payload: JSON.stringify({
          ...payload,
          defer: { ...payload.defer!, nextAttemptAt: new Date(Date.now() - 1_000).toISOString() },
        }),
      }).where(eq(commands.id, inboxKey));
      await processSlackInbox(async (claim) =>
        slackInboxKey(claim.payload.envelope) === inboxKey
          ? { status: "completed" }
          : replaySlackInboxClaim(claim));
      [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row.state).toBe("completed");
    } finally {
      restartSlackInboxPumpForTest();
    }
  });

  test("an unrelated reply probation expires once into a retention-eligible no-op", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "message",
      channel: `C${uid("ch")}`,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `unrelated ${uid("expire")}`,
      ts: `${uid("ts")}.1`,
      thread_ts: `${uid("unrelated-root")}.0`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      expect((await postSlack(envelope)).status).toBe(200);
      const [queued] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      const payload = JSON.parse(queued.payload!) as SlackInboxPayload;
      expect(payload.defer).toMatchObject({ reason: "awaiting_root_commit", count: 0 });
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({ claimed: 0 });

      await db.update(commands).set({
        payload: JSON.stringify({
          ...payload,
          defer: {
            ...payload.defer!,
            count: 11,
            firstDeferredAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
            nextAttemptAt: new Date(Date.now() - 1_000).toISOString(),
          },
        }),
      }).where(eq(commands.id, inboxKey));
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({
        claimed: 1,
        completed: 1,
        requeued: 0,
      });
      const [completed] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(completed.state).toBe("completed");
      expect(completed.error).toBe("permanent_noop:awaiting_root_commit_expired");
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({ claimed: 0 });
      expect((await postSlack(envelope)).status).toBe(200);
      const [retried] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(retried.state).toBe("completed");
      expect(await processSlackInbox(replaySlackInboxClaim)).toMatchObject({ claimed: 0 });
    } finally {
      restartSlackInboxPumpForTest();
    }
  });

  test("fails an exhausted stale dispatch left by a crashed process", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> exhausted crash ${uid("crash")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      await persistSlackInboxEvent(envelope);
      await db
        .update(commands)
        .set({
          state: "dispatched",
          attemptCount: 8,
          error: "dead-worker-token",
          updatedAt: new Date(Date.now() - 31_000),
        })
        .where(eq(commands.id, inboxKey));
      let invoked = false;
      expect(await processSlackInbox(async () => {
        invoked = true;
        return { status: "completed" };
      })).toMatchObject({ claimed: 0, failed: 1 });
      expect(invoked).toBe(false);
      const [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row).toMatchObject({
        state: "failed",
        attemptCount: 8,
        error: "retry_exhausted_after_restart",
      });
    } finally {
      restartSlackInboxPumpForTest();
    }
  });

  test("reply persists before the root INSERT commits, then attaches exactly once", async () => {
    await stopSlackInboxPumpForTest();
    const marker = uid("root-commit-race");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("root")}.1`;
    const replyTs = `${uid("reply")}.2`;
    const root = eventCallback({
      type: "app_mention",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `<@${BOT}> race root ${marker}`,
      ts: rootTs,
    }) as SlackEnvelope;
    const reply = eventCallback({
      type: "message",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `race reply ${marker}`,
      ts: replyTs,
      thread_ts: rootTs,
    }) as SlackEnvelope;
    let rootReachedInsert!: () => void;
    const rootInsertBlocked = new Promise<void>((resolve) => { rootReachedInsert = resolve; });
    let releaseRootInsert!: () => void;
    const rootInsertRelease = new Promise<void>((resolve) => { releaseRootInsert = resolve; });
    let rootReleased = false;
    setSlackInboxBeforePersistInsertForTest(async (envelope) => {
      if (slackInboxKey(envelope) !== slackInboxKey(root)) return;
      rootReachedInsert();
      await rootInsertRelease;
    });
    try {
      const rootRequest = postSlack(root);
      await rootInsertBlocked;

      const replyResponse = await postSlack(reply);
      expect(replyResponse.status).toBe(200);
      const [persistedReply] = await db
        .select()
        .from(commands)
        .where(eq(commands.id, slackInboxKey(reply)));
      expect(persistedReply).toMatchObject({
        state: "queued",
        threadId: slackInboxThreadId(reply),
      });
      expect((JSON.parse(persistedReply.payload!) as SlackInboxPayload).defer).toMatchObject({
        reason: "awaiting_root_commit",
        count: 0,
      });
      const [notYetCommittedRoot] = await db
        .select({ id: commands.id })
        .from(commands)
        .where(eq(commands.id, slackInboxKey(root)));
      expect(notYetCommittedRoot).toBeUndefined();

      rootReleased = true;
      releaseRootInsert();
      expect((await rootRequest).status).toBe(200);
      const [persistedRoot] = await db
        .select()
        .from(commands)
        .where(eq(commands.id, slackInboxKey(root)));
      expect(persistedRoot.threadId).toBe(slackInboxThreadId(root));

      restartSlackInboxPumpForTest();
      const rootRun = await waitFor(async () => findRunByPrompt(`race root ${marker}`));
      const replyRun = await waitFor(async () => findRunByPrompt(`race reply ${marker}`));
      expect(replyRun.parent_run_id).toBe(rootRun.id);
      const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
      expect(body.runs.filter((run) => run.prompt === `race reply ${marker}`)).toHaveLength(1);
      const completedReply = await waitFor(async () => {
        const [row] = await db
          .select({ state: commands.state })
          .from(commands)
          .where(eq(commands.id, slackInboxKey(reply)));
        return row?.state === "completed" ? row : null;
      });
      expect(completedReply.state).toBe("completed");
    } finally {
      setSlackInboxBeforePersistInsertForTest(null);
      if (!rootReleased) releaseRootInsert();
      restartSlackInboxPumpForTest();
    }
  });

  test("Slack root-thread lookup uses the existing commands thread-state index", async () => {
    await stopSlackInboxPumpForTest();
    const prefix = `slack-plan-${crypto.randomUUID()}`;
    const targetThread = `${prefix}-target`;
    try {
      await db.execute(sql`
        insert into commands (id, kind, thread_id, state, attempt_count, created_at, updated_at)
        select
          ${prefix} || '-' || g::text,
          ${SLACK_INBOX_EVENT},
          case when g = 1 then ${targetThread} else ${prefix} || '-thread-' || g::text end,
          'queued',
          0,
          now() - (g * interval '1 millisecond'),
          now()
        from generate_series(1, 4000) as g`);
      await db.execute(sql`analyze commands`);
      const plan = await db.execute(sql`
        explain (format text)
        select id from commands
        where thread_id = ${targetThread}
          and state in ('queued', 'dispatched')
        order by created_at asc
        limit 1`);
      const rendered = plan
        .map((row) => String((row as Record<string, unknown>)["QUERY PLAN"] ?? ""))
        .join("\n");
      expect(rendered).toContain("idx_commands_thread_state");
    } finally {
      await db.execute(sql`delete from commands where id like ${`${prefix}%`}`);
      restartSlackInboxPumpForTest();
    }
  });

  test("closed root then reply both drain after admission reopens", async () => {
    await stopSlackInboxPumpForTest();
    const operationId = `slack-root-reply:${crypto.randomUUID()}`;
    const marker = uid("closed-thread");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("root")}.1`;
    const replyTs = `${uid("reply")}.2`;
    const root = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> root ${marker}`,
      ts: rootTs,
    }) as SlackEnvelope;
    const reply = eventCallback({
      type: "message",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `reply ${marker}`,
      ts: replyTs,
      thread_ts: rootTs,
    }) as SlackEnvelope;
    await setRunAdmission({
      open: false,
      operationId,
      actor: "test",
      reason: "closed root/reply ordering proof",
    });
    try {
      expect((await postSlack(root)).status).toBe(200);
      expect((await postSlack(reply)).status).toBe(200);
      restartSlackInboxPumpForTest();
      await waitFor(async () => {
        const rows = await db.select().from(commands).where(sql`${commands.id} in (${slackInboxKey(root)}, ${slackInboxKey(reply)})`);
        return rows.length === 2 && rows.every((row) => row.state === "queued") ? rows : null;
      });
      expect(await findRunByPrompt(`root ${marker}`)).toBeNull();
      expect(await findRunByPrompt(`reply ${marker}`)).toBeNull();
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "reopen root/reply ordering proof",
      });
      const rootRun = await waitFor(async () => findRunByPrompt(`root ${marker}`));
      const replyRun = await waitFor(async () => findRunByPrompt(`reply ${marker}`));
      expect(replyRun.parent_run_id).toBe(rootRun.id);
      expect(replyRun.thread_id).toBe(rootRun.id);
    } finally {
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "test cleanup",
      });
      restartSlackInboxPumpForTest();
    }
  });

  test("a reply processed before its pending root waits durably then attaches", async () => {
    await stopSlackInboxPumpForTest();
    const marker = uid("reverse-thread");
    const channel = `C${uid("ch")}`;
    const rootTs = `${uid("root")}.1`;
    const reply = eventCallback({
      type: "message",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `reply first ${marker}`,
      ts: `${uid("reply")}.2`,
      thread_ts: rootTs,
    }) as SlackEnvelope;
    const root = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> root later ${marker}`,
      ts: rootTs,
    }) as SlackEnvelope;
    try {
      expect((await postSlack(root)).status).toBe(200);
      expect((await postSlack(reply)).status).toBe(200);
      // The root is durably pending, but force the reply to be claimed first.
      await db
        .update(commands)
        .set({ createdAt: new Date(Date.now() - 1_000) })
        .where(eq(commands.id, slackInboxKey(reply)));
      restartSlackInboxPumpForTest();
      const rootRun = await waitFor(async () => findRunByPrompt(`root later ${marker}`));
      const replyRun = await waitFor(async () => findRunByPrompt(`reply first ${marker}`));
      expect(replyRun.parent_run_id).toBe(rootRun.id);
      const replyInbox = await waitFor(async () => {
        const [row] = await db.select().from(commands).where(eq(commands.id, slackInboxKey(reply)));
        return row?.state === "completed" ? row : null;
      });
      expect(replyInbox.attemptCount).toBe(1);
    } finally {
      restartSlackInboxPumpForTest();
    }
  });

  test("a healthy claim heartbeat prevents reclaim after more than 30 seconds", async () => {
    await stopSlackInboxPumpForTest();
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> long healthy claim ${uid("lease")}`,
      ts: `${uid("ts")}.1`,
    }) as SlackEnvelope;
    try {
      await persistSlackInboxEvent(envelope);
      let entered!: () => void;
      const claimed = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const firstReplica = processSlackInbox(async (claim) => {
        await claim.checkpointStagedAttachmentIds(["upload-long-running"]);
        entered();
        await blocked;
        return { status: "completed" };
      });
      await claimed;
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      expect(await processSlackInbox(async () => ({ status: "completed" }))).toMatchObject({
        claimed: 0,
      });
      const [leased] = await db
        .select({ payload: commands.payload, state: commands.state })
        .from(commands)
        .where(eq(commands.id, slackInboxKey(envelope)));
      expect(leased.state).toBe("dispatched");
      expect(leased.payload).toContain("upload-long-running");
      release();
      expect(await firstReplica).toMatchObject({ claimed: 1, completed: 1 });
    } finally {
      restartSlackInboxPumpForTest();
    }
  }, 45_000);

  test("canonical storage drops unknown fields and terminal retention redacts then deletes", async () => {
    await stopSlackInboxPumpForTest();
    const secret = `provider-secret-${uid("secret")}`;
    const envelope = {
      ...eventCallback({
        type: "app_mention",
        channel: `C${uid("ch")}`,
        user: "U-HUMAN",
        text: `<@${BOT}> retain ${uid("retain")}`,
        ts: `${uid("ts")}.1`,
        hidden_provider_field: secret,
        files: [{
          id: `F${uid("f")}`,
          name: "proof.txt",
          size: 4,
          mimetype: "text/plain",
          url_private_download: `https://files.slack.com/${secret}`,
          hidden_file_field: secret,
        }],
      }),
      hidden_envelope_field: secret,
    } as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    try {
      await persistSlackInboxEvent(envelope);
      let [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row.payload).not.toContain("hidden_provider_field");
      expect(row.payload).not.toContain("hidden_file_field");
      expect(row.payload).not.toContain("hidden_envelope_field");
      expect(row.payload).toContain(secret); // allowlisted file URL is needed until terminal.

      await db
        .update(commands)
        .set({ state: "completed", createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
        .where(eq(commands.id, inboxKey));
      expect(await maintainSlackInboxRetention()).toMatchObject({ redacted: 1 });
      [row] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(row.payload).toContain('"redacted"');
      expect(row.payload).not.toContain(secret);

      await db
        .update(commands)
        .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
        .where(eq(commands.id, inboxKey));
      expect(await maintainSlackInboxRetention()).toMatchObject({ deleted: 1 });
      const [deleted] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(deleted).toBeUndefined();
    } finally {
      restartSlackInboxPumpForTest();
    }
  });
});

// Durable inbound dedupe: the command lane is keyed by the Slack event identity
// (slack-event:<team>:<event_id>, channel:ts fallback), so a duplicate that
// OUTLIVES a process restart or cross-lane double delivery and still collapses
// to one run through the inbox + run-command identities.
describe("slack durable inbound dedupe (survives a restart)", () => {
  test("the same event_id re-delivered after a 'restart' does not create a second run", async () => {
    const marker = uid("durable");
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> durable ${marker}`,
      ts: `${uid("ts")}.1`,
    });
    await postSlack(envelope);
    await waitFor(async () => findRunByPrompt(`durable ${marker}`));

    resetSlackDeduperForTest(); // the in-memory fast path forgets everything
    const res = await postSlack(envelope); // same event_id -> durable replay
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
    expect(body.runs.filter((r) => r.prompt === `durable ${marker}`).length).toBe(1);
  });

  test("replay heals a missing response row and non-terminal start stream", async () => {
    const marker = uid("healstart");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const envelope = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> heal ${marker}`,
      ts,
    });
    await postSlack(envelope);
    const run = await waitFor(async () => findRunByPrompt(`heal ${marker}`));
    await waitFor(async () => finalAnswerFor(channel, ts));

    await db.update(runs).set({ status: "queued", summary: null }).where(eq(runs.id, run.id));
    await deleteSlackDeliveryRows(run.id);
    const beforeStarts = rec.streams.filter((s) => s.op === "start" && s.channel === channel && s.threadTs === ts).length;
    resetSlackDeduperForTest();

    expect((await postSlack(envelope)).status).toBe(200);

    await waitFor(async () => {
      const response = await findSlackRunResponse(run.id);
      const starts = rec.streams.filter((s) => s.op === "start" && s.channel === channel && s.threadTs === ts);
      return response && starts.length > beforeStarts ? { response, starts } : null;
    });
    expect(rec.sessionStatuses.some((s) => s.channel === channel && s.threadTs === ts && s.status === "processing")).toBe(true);
    expect(rec.reactions.some((r) => r.channel === channel && r.timestamp === ts && r.name === "eyes")).toBe(true);
  });

  test("replay heals a missing response row for an already-terminal run", async () => {
    const marker = uid("healfinal");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const envelope = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> final ${marker}`,
      ts,
    });
    await postSlack(envelope);
    const run = await waitFor(async () => findRunByPrompt(`final ${marker}`));
    await waitFor(async () => finalAnswerFor(channel, ts));

    await deleteSlackDeliveryRows(run.id);
    const beforeMessages = rec.messages.filter((m) => m.channel === channel && m.threadTs === ts && !m.blocks).length;
    resetSlackDeduperForTest();

    expect((await postSlack(envelope)).status).toBe(200);

    const healed = await waitFor(async () => {
      const response = await findSlackRunResponse(run.id);
      const replies = rec.messages.filter((m) => m.channel === channel && m.threadTs === ts && !m.blocks);
      return response && replies.length > beforeMessages ? replies.at(-1) : null;
    });
    expect(healed.text.length).toBeGreaterThan(0);
    expect(rec.sessionStatuses.some((s) => s.channel === channel && s.threadTs === ts && s.status === "active")).toBe(true);
  });

  test("an attachment replay returns before restaging provider files", async () => {
    let downloads = 0;
    setInboundFileDownloaderForTest(async () => {
      downloads += 1;
      return new TextEncoder().encode("dup bytes");
    });
    try {
      const marker = uid("dupconflict");
      const envelope = eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: `attach ${marker}`,
        ts: `${uid("ts")}.1`,
        files: [
          {
            id: `F${uid("f")}`,
            name: `${marker}.txt`,
            size: 9,
            mimetype: "text/plain",
            url_private_download: `https://files.slack.com/files-pri/${TEAM}/${marker}.txt`,
          },
        ],
      });
      await postSlack(envelope);
      await waitFor(async () => findRunByPrompt(`attach ${marker}`));
      expect(downloads).toBe(1);

      resetSlackDeduperForTest();
      // Stable Slack file identity matches the durable raw intent, so the
      // replay is recognized before downloading or staging the file again.
      expect((await postSlack(envelope)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(downloads).toBe(1);
      const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
      expect(body.runs.filter((r) => r.prompt === `attach ${marker}`).length).toBe(1);
    } finally {
      setInboundFileDownloaderForTest(null);
    }
  });

  test("an envelope with NO event_id falls back to the channel:ts durable key", async () => {
    const marker = uid("fallback");
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> fallback ${marker}`,
      ts: `${uid("ts")}.1`,
    });
    delete (envelope as Record<string, unknown>).event_id;
    await postSlack(envelope);
    await waitFor(async () => findRunByPrompt(`fallback ${marker}`));

    resetSlackDeduperForTest();
    expect((await postSlack(envelope)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
    expect(body.runs.filter((r) => r.prompt === `fallback ${marker}`).length).toBe(1);
  });
});

describe("slack legacy team adoption", () => {
  test("a matching __legacy__ thread is atomically adopted for the resolved workspace", async () => {
    const marker = uid("legacy");
    const channel = `C${uid("legacy")}`;
    const rootTs = `${uid("ts")}.1`;
    const rootRunId = crypto.randomUUID();
    await createRun({
      id: rootRunId,
      prompt: `legacy root ${marker}`,
      model: "claude-opus-5",
      engine: "mock",
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
      parentRunId: null,
      threadId: rootRunId,
      repos: [],
      memoryScope: "org",
    });
    await db.insert(slackThreads).values({
      teamId: "__legacy__",
      channel,
      threadTs: rootTs,
      rootRunId,
      orgId: DEV_ORG_ID,
    });
    await createSlackRunResponse({ runId: rootRunId, teamId: "__legacy__", channel, threadTs: rootTs });

    const res = await postSlack(
      eventCallback({
        type: "message",
        channel,
        user: "U-HUMAN",
        text: `continue ${marker}`,
        ts: `${uid("ts")}.2`,
        thread_ts: rootTs,
      }),
    );
    expect(res.status).toBe(200);

    const reply = await waitFor(async () => findRunByPrompt(`continue ${marker}`));
    expect(reply.parent_run_id).toBe(rootRunId);
    const [adopted] = await db.select().from(slackThreads).where(eq(slackThreads.rootRunId, rootRunId)).limit(1);
    expect(adopted?.teamId).toBe(TEAM);
    const rootResponse = await findSlackRunResponse(rootRunId);
    expect(rootResponse?.teamId).toBe(TEAM);
  });

  test("a cross-org __legacy__ thread is not adopted", async () => {
    const marker = uid("legacyxorg");
    const channel = `C${uid("legacy")}`;
    const rootTs = `${uid("ts")}.1`;
    const rootRunId = crypto.randomUUID();
    const otherOrgId = `org-other-${uid("org")}`;
    await createRun({
      id: rootRunId,
      prompt: `legacy cross root ${marker}`,
      model: "claude-opus-5",
      engine: "mock",
      orgId: otherOrgId,
      userId: null,
      parentRunId: null,
      threadId: rootRunId,
      repos: [],
      memoryScope: "org",
    });
    await db.insert(slackThreads).values({
      teamId: "__legacy__",
      channel,
      threadTs: rootTs,
      rootRunId,
      orgId: otherOrgId,
    });

    expect((await postSlack(eventCallback({
      type: "message",
      channel,
      user: "U-HUMAN",
      text: `ignored ${marker}`,
      ts: `${uid("ts")}.2`,
      thread_ts: rootTs,
    }))).status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    expect(await findRunByPrompt(`ignored ${marker}`)).toBeNull();
    const [legacy] = await db.select().from(slackThreads).where(eq(slackThreads.rootRunId, rootRunId)).limit(1);
    expect(legacy?.teamId).toBe("__legacy__");
  });
});

// Durable-ack ingress: the events route commits the small inbox row before its
// 200; slower staging and run acceptance still happen behind that ACK.
describe("slack durable-ack ingress", () => {
  test("the 200 does not wait for event processing (slow attachment staging)", async () => {
    // A 600ms attachment download would blow a synchronous handler way past
    // this assertion; durable-ack returns while staging is still in flight.
    setInboundFileDownloaderForTest(async () => {
      await new Promise((r) => setTimeout(r, 600));
      return new TextEncoder().encode("slow bytes");
    });
    try {
      const marker = uid("ackfirst");
      const started = Date.now();
      const res = await postSlack(
        eventCallback({
          type: "message",
          channel: `D${uid("dm")}`,
          channel_type: "im",
          user: "U-HUMAN",
          text: `stage ${marker}`,
          ts: `${uid("ts")}.1`,
          files: [
            {
              id: `F${uid("f")}`,
              name: `${marker}.txt`,
              size: 10,
              mimetype: "text/plain",
              url_private_download: `https://files.slack.com/files-pri/${TEAM}/${marker}.txt`,
            },
          ],
        }),
      );
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(400); // acked BEFORE the 600ms download
      // The event still fully processes after the ack.
      const run = await waitFor(async () => findRunByPrompt(`stage ${marker}`));
      expect(run.id).toBeTruthy();
    } finally {
      setInboundFileDownloaderForTest(null);
    }
  });

  test("a Slack retry delivery (x-slack-retry-num) is acked without a second run", async () => {
    const marker = uid("retry");
    const channel = `C${uid("ch")}`;
    const envelope = eventCallback({
      type: "app_mention",
      channel,
      user: "U-HUMAN",
      text: `<@${BOT}> retry ${marker}`,
      ts: `${uid("ts")}.1`,
    });
    await postSlack(envelope);
    await waitFor(async () => findRunByPrompt(`retry ${marker}`));

    const res = await postSlack(envelope, { headers: { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" } });
    expect(res.status).toBe(200); // acked immediately...
    await new Promise((r) => setTimeout(r, 300));
    const { body } = await json<{ runs: any[] }>("/api/runs?all=1");
    expect(body.runs.filter((r) => r.prompt === `retry ${marker}`).length).toBe(1); // ...never reprocessed
  });
});

// The Socket Mode ingest lane feeds the SAME handleSlackEvent as the HTTP route,
// so a socket-ingested event must create a run AND attach the live-status/reply
// watcher (watchSlackRun) exactly as HTTP does. Drive the frame dispatcher
// directly (no live WebSocket) and assert the full downstream.
describe("slack socket-mode ingest shares the HTTP handler", () => {
  function socketFrame(envelope: Record<string, unknown>, envelopeId = `env-${uid("e")}`): { raw: string; envelopeId: string } {
    return { raw: JSON.stringify({ type: "events_api", envelope_id: envelopeId, payload: envelope }), envelopeId };
  }

  test("an events_api app_mention frame acks, creates a run, and attaches the watcher", async () => {
    const marker = uid("socket");
    const channel = `C${uid("ch")}`;
    const ts = `${uid("ts")}.1`;
    const acked: string[] = [];
    const { raw, envelopeId } = socketFrame(
      eventCallback({ type: "app_mention", channel, user: "U-HUMAN", text: `<@${BOT}> socket ${marker}`, ts }),
    );

    await dispatchSocketFrame(raw, (id) => acked.push(id), () => {});

    expect(acked).toEqual([envelopeId]); // acked after inbox commit, before processing

    // Run created via the shared handler, scoped to the dev org.
    const run = await waitFor(async () => findRunByPrompt(`socket ${marker}`));
    expect(run.org_id).toBe("org-skynet-dev");

    // watchSlackRun attached downstream: the 👀 ack + native stream land, and the
    // settled answer stops the stream.
    await waitFor(async () =>
      rec.reactions.some((r) => r.channel === channel && r.timestamp === ts && r.name === "eyes") || null,
    );
    await waitFor(async () => rec.streams.find((s) => s.op === "start" && s.channel === channel && s.threadTs === ts) ?? null);
    const answer = await waitFor(async () => finalAnswerFor(channel, ts));
    expect(answer!.length).toBeGreaterThan(0);
  });

  test("a socket event is not ACKed when inbox persistence fails", async () => {
    const acked: string[] = [];
    const { raw } = socketFrame(eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> persist failure`,
      ts: `${uid("ts")}.1`,
    }));
    setSlackInboxPersisterForTest(async () => { throw new Error("synthetic inbox outage"); });
    try {
      await dispatchSocketFrame(raw, (id) => acked.push(id), () => {});
      expect(acked).toEqual([]);
    } finally {
      setSlackInboxPersisterForTest(null);
    }
  });

  test("hello is a no-op; disconnect asks us to close", async () => {
    let closed = 0;
    await dispatchSocketFrame(JSON.stringify({ type: "hello" }), () => {}, () => closed++);
    expect(closed).toBe(0);
    await dispatchSocketFrame(JSON.stringify({ type: "disconnect" }), () => {}, () => closed++);
    expect(closed).toBe(1);
  });
});

// Workspace identity fails CLOSED: only events from a team with a
// slack_workspaces mapping are accepted; there is no seeded-org fallback.
describe("slack workspace identity (fail closed)", () => {
  test("rejects an existing thread link owned by another organization", async () => {
    const marker = uid("cross-org");
    const channel = `C${uid("ch")}`;
    const threadTs = `${uid("ts")}.1`;
    const rootRunId = crypto.randomUUID();
    const otherOrgId = `org-other-${uid("org")}`;
    await createRun({
      id: rootRunId,
      prompt: `other org root ${marker}`,
      model: "claude-opus-5",
      engine: "mock",
      orgId: otherOrgId,
      userId: null,
      parentRunId: null,
      threadId: rootRunId,
    });
    await linkSlackThread({
      teamId: TEAM,
      channel,
      threadTs,
      rootRunId,
      orgId: otherOrgId,
    });

    await postSlack(eventCallback({
      type: "message",
      channel,
      channel_type: "channel",
      user: "U-HUMAN",
      text: `cross org ${marker}`,
      ts: `${uid("ts")}.2`,
      thread_ts: threadTs,
    }));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await findRunByPrompt(`cross org ${marker}`)).toBeNull();
  });

  test("uses an explicit Slack-sender mapping for run attribution", async () => {
    const marker = uid("sender");
    await postSlack(eventCallback({
      type: "message",
      channel: `D${uid("dm")}`,
      channel_type: "im",
      user: "U-HUMAN",
      text: `sender ${marker}`,
      ts: `${uid("ts")}.1`,
    }));
    const run = await waitFor(async () => findRunByPrompt(`sender ${marker}`));
    expect(run.user_id).toBe(DEV_USER_ID);
  });

  test("blocks every run for an unmapped Slack sender", async () => {
    const marker = uid("unmapped-sender");
    const channel = `D${uid("dm")}`;
    await postSlack(eventCallback({
      type: "message",
      channel,
      channel_type: "im",
      user: `U-${uid("unknown")}`,
      text: `summarize this workspace ${marker}`,
      ts: `${uid("ts")}.1`,
    }));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await findRunByPrompt(`summarize this workspace ${marker}`)).toBeNull();
    await waitFor(async () =>
      rec.messages.find(
        (message) => message.channel === channel && message.text.includes("asked this workspace's admins to let you in"),
      ) ?? null,
    );
  });

  test("an unknown sender is recorded, a typed address invites them, and accepting binds them", async () => {
    const slackUserId = `U-${uid("newcomer")}`;
    const channel = `D${uid("dm")}`;
    const first = uid("first");
    await postSlack(eventCallback({
      type: "message",
      channel,
      channel_type: "im",
      user: slackUserId,
      text: `hello ${first}`,
      ts: `${uid("ts")}.1`,
    }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await findRunByPrompt(`hello ${first}`)).toBeNull();
    // The bound admin (U-HUMAN, an owner of the dev org) hears about it by DM.
    await waitFor(async () =>
      rec.messages.find((m) => m.channel === "U-HUMAN" && m.text.includes("asked to use useAgent from Slack")) ?? null,
    );
    const listed = await json<{ requests: Array<{ id: string; name: string; email: string | null }> }>("/api/team/access-requests");
    expect(listed.status).toBe(200);
    const request = listed.body.requests.find((r) => r.name === slackUserId);
    expect(request?.email).toBeNull(); // the recording client has no profile lookup

    // A second message does not ask twice, it just says it is waiting.
    const second = uid("second");
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `again ${second}`, ts: `${uid("ts")}.2` }));
    await waitFor(async () => rec.messages.find((m) => m.channel === channel && m.text.includes("Still waiting")) ?? null);
    const again = await json<{ requests: Array<{ name: string }> }>("/api/team/access-requests");
    expect(again.body.requests.filter((r) => r.name === slackUserId)).toHaveLength(1);

    // Only the admin's word about the address: that is an invitation, not a binding.
    const email = `${uid("newcomer")}@example.test`;
    const invited = await json<{ status: string }>(`/api/team/access-requests/${request!.id}/allow`, { method: "POST", body: { email } });
    expect(invited.status).toBe(200);
    expect(invited.body.status).toBe("invited");
    const [row] = await db.execute(sql`select i.id, i.email from invitation i join slack_access_requests r on r.invitation_id = i.id where r.id = ${request!.id}`);
    expect((row as { email: string }).email).toBe(email);
    expect((await json<{ requests: Array<{ id: string }> }>("/api/team/access-requests")).body.requests.some((r) => r.id === request!.id)).toBe(false);
    const third = uid("third");
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `work ${third}`, ts: `${uid("ts")}.3` }));
    await waitFor(async () => rec.messages.find((m) => m.channel === channel && m.text.includes("invitation")) ?? null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await findRunByPrompt(`work ${third}`)).toBeNull();

    // The address's owner signs up and accepts: now the sender is that person.
    const signUp = await fetchApi("/api/auth/sign-up/email", { method: "POST", body: { name: "New Comer", email, password: "password-1234" } });
    expect(signUp.status).toBe(200);
    const cookies = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const accepted = await json("/api/auth/organization/accept-invitation", { method: "POST", cookies, body: { invitationId: (row as { id: string }).id } });
    expect(accepted.status).toBe(200);
    await waitFor(async () => rec.messages.find((m) => m.channel === slackUserId && m.text.includes("You are in")) ?? null);
    const fourth = uid("fourth");
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `work ${fourth}`, ts: `${uid("ts")}.4` }));
    const run = await waitFor(async () => findRunByPrompt(`work ${fourth}`));
    const [newcomer] = await db.execute(sql`select id from "user" where email = ${email}`);
    expect(run.user_id).toBe((newcomer as { id: string }).id);
    expect(run.user_id).not.toBe(DEV_USER_ID);
  });

  test("a denied sender is remembered and not asked about again", async () => {
    const slackUserId = `U-${uid("denied")}`;
    const channel = `D${uid("dm")}`;
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `let me in ${uid("x")}`, ts: `${uid("ts")}.1` }));
    await waitFor(async () => rec.messages.find((m) => m.channel === channel && m.text.includes("asked this workspace's admins")) ?? null);
    const listed = await json<{ requests: Array<{ id: string; name: string }> }>("/api/team/access-requests");
    const request = listed.body.requests.find((r) => r.name === slackUserId)!;
    const denied = await json<{ status: string }>(`/api/team/access-requests/${request.id}/deny`, { method: "POST", body: {} });
    expect(denied.body.status).toBe("denied");
    const before = rec.messages.length;
    const marker = uid("silent");
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `hello ${marker}`, ts: `${uid("ts")}.2` }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await findRunByPrompt(`hello ${marker}`)).toBeNull();
    expect(rec.messages.slice(before).filter((m) => m.channel === channel)).toHaveLength(0);
    const after = await json<{ requests: Array<{ name: string }> }>("/api/team/access-requests");
    expect(after.body.requests.some((r) => r.name === slackUserId)).toBe(false);
  });

  test("a typed address of an existing account only invites that account, and a bad address is refused", async () => {
    const slackUserId = `U-${uid("typed")}`;
    const channel = `D${uid("dm")}`;
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `hi ${uid("x")}`, ts: `${uid("ts")}.1` }));
    await waitFor(async () => rec.messages.find((m) => m.channel === channel && m.text.includes("asked this workspace's admins")) ?? null);
    const listed = await json<{ requests: Array<{ id: string; name: string }> }>("/api/team/access-requests");
    const request = listed.body.requests.find((r) => r.name === slackUserId)!;
    const bad = await json<{ message?: string }>(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: { email: "not an email\r\nRCPT TO:<x@y>" } });
    expect(bad.status).toBe(400);
    const stillPending = await json<{ requests: Array<{ name: string }> }>("/api/team/access-requests");
    expect(stillPending.body.requests.some((r) => r.name === slackUserId)).toBe(true);
    // Typing an existing account's address never binds the sender to it: the
    // account's owner gets an invitation and decides.
    const other = await createOrgSession("typed-target");
    const invited = await json<{ status?: string; message?: string }>(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: { email: other.email } });
    expect(`${invited.status} ${invited.body.status ?? invited.body.message}`).toBe("200 invited");
    const [binding] = await db.execute(sql`select user_id from slack_users where team_id = ${TEAM} and slack_user_id = ${slackUserId}`);
    expect(binding).toBeUndefined();
    // The decision is final: a second answer finds nothing open.
    const again = await json(`/api/team/access-requests/${request.id}/deny`, { method: "POST", body: {} });
    expect(again.status).toBe(404);
  });

  test("a stale event never reopens a live membership, and a bad Slack-reported address is dropped", async () => {
    const slackUserId = `U-${uid("stale")}`;
    const email = `${uid("stale")}@example.test`;
    let profile = { name: "Stale Sender", email: "stale\u0001@example.test", image: null as string | null };
    const client = { userInfo: async () => profile } as unknown as SlackClient;
    const ask = () => requestSlackAccess({ teamId: TEAM, slackUserId, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.1`, client });
    expect(await ask()).toBe("asked");
    const listed = () => json<{ requests: Array<{ id: string; name: string; email: string | null }> }>("/api/team/access-requests");
    let request = (await listed()).body.requests.find((r) => r.name === "Stale Sender")!;
    expect(request.email).toBeNull(); // the control character disqualified Slack's address
    profile = { name: "Stale Sender", email, image: null };
    expect(await ask()).toBe("waiting"); // and the next look brings a usable one
    request = (await listed()).body.requests.find((r) => r.id === request.id)!;
    expect(request.email).toBe(email);
    const allowed = await json<{ status: string }>(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: {} });
    expect(allowed.body.status).toBe("allowed");
    // A brand-new account gets what a sign-up gives: this workspace and one of its own.
    const [created] = await db.execute(sql`select id from "user" where email = ${email}`);
    expect(await db.select({ id: member.id }).from(member).where(eq(member.userId, (created as { id: string }).id))).toHaveLength(2);
    // The event that was in flight before the decision lands now: nothing reopens.
    expect(await ask()).toBe("already_in");
    const [row] = await db.execute(sql`select status from slack_access_requests where id = ${request.id}`);
    expect((row as { status: string }).status).toBe("allowed");
  });

  test("a missed profile is refreshed on the next message, and Slack's address then matches an existing account", async () => {
    const slackUserId = `U-${uid("refresh")}`;
    const email = `${uid("refresh")}@example.test`;
    const [account] = await db.execute(sql`insert into "user" (id, name, email, email_verified) values (${crypto.randomUUID()}, 'Already Here', ${email}, true) returning id`);
    let profile: { name: string; email: string | null; image: string | null } | null = null;
    const client = { userInfo: async () => profile } as unknown as SlackClient;
    const ask = () => requestSlackAccess({ teamId: TEAM, slackUserId, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.1`, client });
    expect(await ask()).toBe("asked");
    const listed = () => json<{ requests: Array<{ id: string; name: string; email: string | null }> }>("/api/team/access-requests");
    let request = (await listed()).body.requests.find((r) => r.name === slackUserId)!;
    expect(request.email).toBeNull();
    await waitFor(async () => rec.messages.find((m) => m.channel === "U-HUMAN" && m.text.includes(slackUserId)) ?? null);
    // A lookup that brings a name but no address still improves the row.
    profile = { name: "Named Later", email: null, image: null };
    expect(await ask()).toBe("waiting");
    request = (await listed()).body.requests.find((r) => r.id === request.id)!;
    expect(request.name).toBe("Named Later");
    expect(request.email).toBeNull();
    profile = { name: "Refreshed Name", email, image: null };
    const before = rec.messages.length;
    expect(await ask()).toBe("waiting");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(rec.messages.length).toBe(before); // no second notice to the admins
    request = (await listed()).body.requests.find((r) => r.id === request.id)!;
    expect(request.email).toBe(email);
    expect(request.name).toBe("Refreshed Name");
    // Slack vouched for the address, so Allow without typing attaches the existing account.
    const allowed = await json<{ status: string }>(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: {} });
    expect(allowed.body.status).toBe("allowed");
    const [binding] = await db.execute(sql`select user_id from slack_users where team_id = ${TEAM} and slack_user_id = ${slackUserId}`);
    expect((binding as { user_id: string }).user_id).toBe((account as { id: string }).id);
  });

  test("a workspace rebound to another org takes its open requests off this org's list", async () => {
    const teamId = `T-${uid("rebound")}`;
    await upsertSlackWorkspace({ teamId, orgId: DEV_ORG_ID, userId: DEV_USER_ID });
    const id = crypto.randomUUID();
    await db.execute(sql`insert into slack_access_requests (id, team_id, slack_user_id, org_id, name) values (${id}, ${teamId}, 'U-LEFT-BEHIND', ${DEV_ORG_ID}, 'Left Behind')`);
    const listed = () => json<{ requests: Array<{ id: string }> }>("/api/team/access-requests");
    expect((await listed()).body.requests.some((r) => r.id === id)).toBe(true);
    await upsertSlackWorkspace({ teamId, orgId: `org-${uid("elsewhere")}`, userId: DEV_USER_ID });
    expect((await listed()).body.requests.some((r) => r.id === id)).toBe(false);
    const decide = await json(`/api/team/access-requests/${id}/deny`, { method: "POST", body: {} });
    expect(decide.status).toBe(404);
  });

  test("a lapsed invitation leaves nothing behind: the typed address is no evidence", async () => {
    const slackUserId = `U-${uid("lapsed")}`;
    const channel = `D${uid("dm")}`;
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `hi ${uid("x")}`, ts: `${uid("ts")}.1` }));
    await waitFor(async () => rec.messages.find((m) => m.channel === channel && m.text.includes("asked this workspace's admins")) ?? null);
    const listed = () => json<{ requests: Array<{ id: string; name: string; email: string | null }> }>("/api/team/access-requests");
    const request = (await listed()).body.requests.find((r) => r.name === slackUserId)!;
    const victim = await createOrgSession("victim");
    const invited = await json<{ status: string }>(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: { email: victim.email } });
    expect(invited.body.status).toBe("invited");
    const [inv] = await db.execute(sql`select invitation_id from slack_access_requests where id = ${request.id}`);
    // The admin cancels it (what the library's cancel-invitation writes).
    await db.execute(sql`update invitation set status = 'canceled' where id = ${(inv as { invitation_id: string }).invitation_id}`);
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `hi ${uid("y")}`, ts: `${uid("ts")}.2` }));
    await waitFor(async () => (await listed()).body.requests.find((r) => r.id === request.id) ?? null);
    const reopened = (await listed()).body.requests.find((r) => r.id === request.id)!;
    expect(reopened.email).toBeNull();
    const again = await json<{ message?: string }>(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: {} });
    expect(again.status).toBe(400); // nothing to bind to without an address
    const [binding] = await db.execute(sql`select user_id from slack_users where team_id = ${TEAM} and slack_user_id = ${slackUserId}`);
    expect(binding).toBeUndefined();
  });

  test("a member invited on a Slack sender's behalf accepts with the membership they have", async () => {
    const slackUserId = `U-${uid("insider")}`;
    const insider = await createOrgSession("insider");
    const [insiderUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, insider.email));
    await db.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: DEV_ORG_ID, userId: insiderUser!.id, role: "member", createdAt: new Date() });
    const client = { userInfo: async () => null } as unknown as SlackClient;
    expect(await requestSlackAccess({ teamId: TEAM, slackUserId, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.1`, client })).toBe("asked");
    const request = (await json<{ requests: Array<{ id: string; name: string }> }>("/api/team/access-requests")).body.requests.find((r) => r.name === slackUserId)!;
    const invited = await json<{ status: string }>(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: { email: insider.email } });
    expect(invited.body.status).toBe("invited");
    const [inv] = await db.execute(sql`select invitation_id from slack_access_requests where id = ${request.id}`);
    const invitationId = (inv as { invitation_id: string }).invitation_id;
    // The direct path keeps the library's rule about where a request may come from.
    const elsewhere = await json("/api/auth/organization/accept-invitation", { method: "POST", cookies: insider.cookies, headers: { origin: "https://elsewhere.example" }, body: { invitationId } });
    expect(elsewhere.status).toBe(403);
    const accepted = await json<{ organizationId?: string }>("/api/auth/organization/accept-invitation", { method: "POST", cookies: insider.cookies, body: { invitationId } });
    expect(accepted.status).toBe(200);
    expect(accepted.body.organizationId).toBe(DEV_ORG_ID);
    const [binding] = await db.execute(sql`select user_id from slack_users where team_id = ${TEAM} and slack_user_id = ${slackUserId}`);
    expect((binding as { user_id: string }).user_id).toBe(insiderUser!.id);
    const memberships = await db.select({ id: member.id }).from(member).where(and(eq(member.organizationId, DEV_ORG_ID), eq(member.userId, insiderUser!.id)));
    expect(memberships).toHaveLength(1);
    // And the accepted workspace is the active one afterwards.
    const now = await json<{ session?: { activeOrganizationId?: string | null } }>("/api/auth/get-session", { cookies: insider.cookies });
    expect(now.body.session?.activeOrganizationId).toBe(DEV_ORG_ID);
  });

  test("an invitation accepted before the bind still binds on the next message, and a rebound workspace refuses an old one", async () => {
    const slackUserId = `U-${uid("early")}`;
    const channel = `D${uid("dm")}`;
    const client = { userInfo: async () => null } as unknown as SlackClient;
    expect(await requestSlackAccess({ teamId: TEAM, slackUserId, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.1`, client })).toBe("asked");
    const request = (await json<{ requests: Array<{ id: string; name: string }> }>("/api/team/access-requests")).body.requests.find((r) => r.name === slackUserId)!;
    const email = `${uid("early")}@example.test`;
    await json(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: { email } });
    const [inv] = await db.execute(sql`select invitation_id from slack_access_requests where id = ${request.id}`);
    const invitationId = (inv as { invitation_id: string }).invitation_id;
    // Accepted with the membership in place, but our binding never ran: the next message finishes it.
    const [account] = await db.execute(sql`insert into "user" (id, name, email, email_verified) values (${crypto.randomUUID()}, 'Early Bird', ${email}, true) returning id`);
    await db.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: DEV_ORG_ID, userId: (account as { id: string }).id, role: "member", createdAt: new Date() });
    await db.execute(sql`update invitation set status = 'accepted' where id = ${invitationId}`);
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `hi ${uid("z")}`, ts: `${uid("ts")}.2` }));
    await waitFor(async () => rec.messages.find((m) => m.channel === channel && m.text.includes("You are in now")) ?? null);
    const [binding] = await db.execute(sql`select user_id from slack_users where team_id = ${TEAM} and slack_user_id = ${slackUserId}`);
    expect((binding as { user_id: string }).user_id).toBe((account as { id: string }).id);

    // Accepted, but the membership was removed before anything bound: the request returns to the admins, nothing is created.
    const gone = `U-${uid("gone")}`;
    const goneChannel = `D${uid("dm")}`;
    expect(await requestSlackAccess({ teamId: TEAM, slackUserId: gone, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.1`, client })).toBe("asked");
    const goneRequest = (await json<{ requests: Array<{ id: string; name: string }> }>("/api/team/access-requests")).body.requests.find((r) => r.name === gone)!;
    const goneEmail = `${uid("gone")}@example.test`;
    await json(`/api/team/access-requests/${goneRequest.id}/allow`, { method: "POST", body: { email: goneEmail } });
    const [goneInv] = await db.execute(sql`select invitation_id from slack_access_requests where id = ${goneRequest.id}`);
    await db.execute(sql`insert into "user" (id, name, email, email_verified) values (${crypto.randomUUID()}, 'Gone Again', ${goneEmail}, true)`);
    await db.execute(sql`update invitation set status = 'accepted' where id = ${(goneInv as { invitation_id: string }).invitation_id}`);
    await postSlack(eventCallback({ type: "message", channel: goneChannel, channel_type: "im", user: gone, text: `hi ${uid("g")}`, ts: `${uid("ts")}.2` }));
    await waitFor(async () => (await json<{ requests: Array<{ id: string }> }>("/api/team/access-requests")).body.requests.find((r) => r.id === goneRequest.id) ?? null);
    expect(await db.execute(sql`select 1 from slack_users where team_id = ${TEAM} and slack_user_id = ${gone}`)).toHaveLength(0);
    expect(await db.execute(sql`select 1 from member m join "user" u on u.id = m.user_id where u.email = ${goneEmail}`)).toHaveLength(0);

    // A workspace rebound elsewhere: an old invitation for it binds nothing.
    const teamId = `T-${uid("moved")}`;
    await upsertSlackWorkspace({ teamId, orgId: DEV_ORG_ID, userId: DEV_USER_ID });
    const other = `U-${uid("moved")}`;
    const requestId = crypto.randomUUID();
    const oldInvitation = crypto.randomUUID();
    await db.execute(sql`insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id) values (${oldInvitation}, ${DEV_ORG_ID}, ${`${uid("moved")}@example.test`}, 'member', 'pending', now() + interval '1 day', ${DEV_USER_ID})`);
    await db.execute(sql`insert into slack_access_requests (id, team_id, slack_user_id, org_id, name, status, invitation_id) values (${requestId}, ${teamId}, ${other}, ${DEV_ORG_ID}, 'Moved', 'invited', ${oldInvitation})`);
    await upsertSlackWorkspace({ teamId, orgId: `org-${uid("elsewhere")}`, userId: DEV_USER_ID });
    expect(await bindInvitedSlackSender(oldInvitation, DEV_USER_ID)).toBe("none");
    const [none] = await db.execute(sql`select user_id from slack_users where team_id = ${teamId} and slack_user_id = ${other}`);
    expect(none).toBeUndefined();
  });

  test("a lapsed invitation comes back on the admins' list on reload, and a vanished recipient reopens on the next message", async () => {
    const client = { userInfo: async () => null } as unknown as SlackClient;
    const listed = () => json<{ requests: Array<{ id: string; name: string }> }>("/api/team/access-requests");
    // Cancelled invitation, no further Slack message: the Team reload repairs it.
    const quiet = `U-${uid("quiet")}`;
    expect(await requestSlackAccess({ teamId: TEAM, slackUserId: quiet, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.1`, client })).toBe("asked");
    const quietRequest = (await listed()).body.requests.find((r) => r.name === quiet)!;
    await json(`/api/team/access-requests/${quietRequest.id}/allow`, { method: "POST", body: { email: `${uid("quiet")}@example.test` } });
    expect((await listed()).body.requests.some((r) => r.id === quietRequest.id)).toBe(false);
    const [quietInv] = await db.execute(sql`select invitation_id from slack_access_requests where id = ${quietRequest.id}`);
    await db.execute(sql`update invitation set status = 'canceled' where id = ${(quietInv as { invitation_id: string }).invitation_id}`);
    expect((await listed()).body.requests.some((r) => r.id === quietRequest.id)).toBe(true);
    // Accepted, then the recipient's account deleted before anything bound: the next message reopens.
    const orphan = `U-${uid("orphan")}`;
    const orphanChannel = `D${uid("dm")}`;
    expect(await requestSlackAccess({ teamId: TEAM, slackUserId: orphan, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.1`, client })).toBe("asked");
    const orphanRequest = (await listed()).body.requests.find((r) => r.name === orphan)!;
    const orphanEmail = `${uid("orphan")}@example.test`;
    await json(`/api/team/access-requests/${orphanRequest.id}/allow`, { method: "POST", body: { email: orphanEmail } });
    const [orphanInv] = await db.execute(sql`select invitation_id from slack_access_requests where id = ${orphanRequest.id}`);
    await db.execute(sql`update invitation set status = 'accepted' where id = ${(orphanInv as { invitation_id: string }).invitation_id}`);
    await postSlack(eventCallback({ type: "message", channel: orphanChannel, channel_type: "im", user: orphan, text: `hi ${uid("o")}`, ts: `${uid("ts")}.2` }));
    await waitFor(async () => (await listed()).body.requests.find((r) => r.id === orphanRequest.id) ?? null);
    expect(await db.execute(sql`select 1 from slack_users where team_id = ${TEAM} and slack_user_id = ${orphan}`)).toHaveLength(0);
  });

  test("the requests list and the decisions are pinned to an organisation the caller manages", async () => {
    const elsewhere = await createOrgSession("elsewhere");
    const foreign = await json("/api/team/access-requests?organizationId=" + encodeURIComponent(elsewhere.orgId));
    expect(foreign.status).toBe(403); // the dev user manages the dev org, not this one
    const own = await json<{ organizationId: string }>("/api/team/access-requests?organizationId=" + encodeURIComponent(DEV_ORG_ID));
    expect(own.status).toBe(200);
    expect(own.body.organizationId).toBe(DEV_ORG_ID);
    const decide = await json(`/api/team/access-requests/${crypto.randomUUID()}/deny`, { method: "POST", body: { organizationId: elsewhere.orgId } });
    expect(decide.status).toBe(403);
  });

  test("an invitation the address already holds is the one the sender gets, and admission settles it with its role", async () => {
    const client = { userInfo: async () => null } as unknown as SlackClient;
    const listed = () => json<{ requests: Array<{ id: string; name: string }> }>("/api/team/access-requests");
    // Typed path: an admin invitation A for the address exists; the Slack request links to A, no second link.
    const linkedEmail = `${uid("linked")}@example.test`;
    const a = crypto.randomUUID();
    await db.execute(sql`insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id) values (${a}, ${DEV_ORG_ID}, ${linkedEmail}, 'admin', 'pending', now() + interval '1 day', ${DEV_USER_ID})`);
    const linked = `U-${uid("linked")}`;
    expect(await requestSlackAccess({ teamId: TEAM, slackUserId: linked, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.1`, client })).toBe("asked");
    const linkedRequest = (await listed()).body.requests.find((r) => r.name === linked)!;
    const invited = await json<{ status: string }>(`/api/team/access-requests/${linkedRequest.id}/allow`, { method: "POST", body: { email: linkedEmail } });
    expect(invited.body.status).toBe("invited");
    const [row] = await db.execute(sql`select invitation_id from slack_access_requests where id = ${linkedRequest.id}`);
    expect((row as { invitation_id: string }).invitation_id).toBe(a);
    expect(await db.execute(sql`select 1 from invitation where organization_id = ${DEV_ORG_ID} and email = ${linkedEmail} and status = 'pending'`)).toHaveLength(1);
    // Direct admission: Slack vouched for the address; the pending admin invitation is settled and its role applied.
    const vouchedEmail = `${uid("vouched")}@example.test`;
    const b = crypto.randomUUID();
    await db.execute(sql`insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id) values (${b}, ${DEV_ORG_ID}, ${vouchedEmail}, 'admin', 'pending', now() + interval '1 day', ${DEV_USER_ID})`);
    const vouched = `U-${uid("vouched")}`;
    const vouching = { userInfo: async () => ({ name: "Vouched", email: vouchedEmail, image: null }) } as unknown as SlackClient;
    expect(await requestSlackAccess({ teamId: TEAM, slackUserId: vouched, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.1`, client: vouching })).toBe("asked");
    const vouchedRequest = (await listed()).body.requests.find((r) => r.name === "Vouched")!;
    const allowed = await json<{ status: string }>(`/api/team/access-requests/${vouchedRequest.id}/allow`, { method: "POST", body: {} });
    expect(allowed.body.status).toBe("allowed");
    const [inv] = await db.execute(sql`select status from invitation where id = ${b}`);
    expect((inv as { status: string }).status).toBe("accepted");
    const [membership] = await db.execute(sql`select m.role from member m join "user" u on u.id = m.user_id where u.email = ${vouchedEmail} and m.organization_id = ${DEV_ORG_ID}`);
    expect((membership as { role: string }).role).toBe("admin");
  });

  test("a stale link from a workspace that moved on does not block another sender sharing the invitation", async () => {
    const email = `${uid("shared")}@example.test`;
    const shared = crypto.randomUUID();
    await db.execute(sql`insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id) values (${shared}, ${DEV_ORG_ID}, ${email}, 'member', 'pending', now() + interval '1 day', ${DEV_USER_ID})`);
    const movedTeam = `T-${uid("moved")}`;
    await upsertSlackWorkspace({ teamId: movedTeam, orgId: DEV_ORG_ID, userId: DEV_USER_ID });
    const staleId = crypto.randomUUID();
    await db.execute(sql`insert into slack_access_requests (id, team_id, slack_user_id, org_id, name, status, invitation_id) values (${staleId}, ${movedTeam}, 'U-STALE', ${DEV_ORG_ID}, 'Stale', 'invited', ${shared})`);
    const validSender = `U-${uid("valid")}`;
    const validId = crypto.randomUUID();
    await db.execute(sql`insert into slack_access_requests (id, team_id, slack_user_id, org_id, name, status, invitation_id) values (${validId}, ${TEAM}, ${validSender}, ${DEV_ORG_ID}, 'Valid', 'invited', ${shared})`);
    await upsertSlackWorkspace({ teamId: movedTeam, orgId: `org-${uid("elsewhere")}`, userId: DEV_USER_ID });
    // The address's owner is a member here (the library's acceptance would have made them one).
    const [account] = await db.execute(sql`insert into "user" (id, name, email, email_verified) values (${crypto.randomUUID()}, 'Shared Owner', ${email}, true) returning id`);
    await db.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: DEV_ORG_ID, userId: (account as { id: string }).id, role: "member", createdAt: new Date() });
    expect(await bindInvitedSlackSender(shared, (account as { id: string }).id)).toBe("bound");
    const [valid] = await db.execute(sql`select user_id from slack_users where team_id = ${TEAM} and slack_user_id = ${validSender}`);
    expect((valid as { user_id: string }).user_id).toBe((account as { id: string }).id);
    const [stale] = await db.execute(sql`select status from slack_access_requests where id = ${staleId}`);
    expect((stale as { status: string }).status).toBe("invited"); // untouched: its workspace moved on
    expect(await db.execute(sql`select 1 from slack_users where team_id = ${movedTeam} and slack_user_id = 'U-STALE'`)).toHaveLength(0);
  });

  test("an old invitation never overwrites the identity a sender has since been given", async () => {
    const sender = `U-${uid("twice")}`;
    // The sender is a live member here as account A.
    const [a] = await db.execute(sql`insert into "user" (id, name, email, email_verified) values (${crypto.randomUUID()}, 'Account A', ${`${uid("a")}@example.test`}, true) returning id`);
    await db.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: DEV_ORG_ID, userId: (a as { id: string }).id, role: "member", createdAt: new Date() });
    await upsertSlackUser({ teamId: TEAM, slackUserId: sender, orgId: DEV_ORG_ID, userId: (a as { id: string }).id });
    // An older request for the same sender is still linked to an invitation for account B.
    const bEmail = `${uid("b")}@example.test`;
    const inv = crypto.randomUUID();
    await db.execute(sql`insert into invitation (id, organization_id, email, role, status, expires_at, inviter_id) values (${inv}, ${DEV_ORG_ID}, ${bEmail}, 'member', 'accepted', now() + interval '1 day', ${DEV_USER_ID})`);
    const requestId = crypto.randomUUID();
    await db.execute(sql`insert into slack_access_requests (id, team_id, slack_user_id, org_id, name, status, invitation_id) values (${requestId}, ${TEAM}, ${sender}, ${DEV_ORG_ID}, 'Twice', 'invited', ${inv})`);
    const [b] = await db.execute(sql`insert into "user" (id, name, email, email_verified) values (${crypto.randomUUID()}, 'Account B', ${bEmail}, true) returning id`);
    await db.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: DEV_ORG_ID, userId: (b as { id: string }).id, role: "member", createdAt: new Date() });
    expect(await bindInvitedSlackSender(inv, (b as { id: string }).id)).toBe("bound");
    const [binding] = await db.execute(sql`select user_id from slack_users where team_id = ${TEAM} and slack_user_id = ${sender}`);
    expect((binding as { user_id: string }).user_id).toBe((a as { id: string }).id); // A stands
    const [row] = await db.execute(sql`select status from slack_access_requests where id = ${requestId}`);
    expect((row as { status: string }).status).toBe("allowed"); // and the old request is closed
  });

  test("removing the member closes the Slack door, and asking again reopens the request", async () => {
    const slackUserId = `U-${uid("leaver")}`;
    const channel = `D${uid("dm")}`;
    const email = `${uid("leaver")}@example.test`;
    const client = { userInfo: async () => ({ name: "Leaver", email, image: null }) } as unknown as SlackClient;
    expect(await requestSlackAccess({ teamId: TEAM, slackUserId, orgId: DEV_ORG_ID, messageTs: `${uid("ts")}.0`, client })).toBe("asked");
    const listed = await json<{ requests: Array<{ id: string; name: string }> }>("/api/team/access-requests");
    const request = listed.body.requests.find((r) => r.name === "Leaver")!;
    const allowed = await json<{ status: string }>(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: {} });
    expect(allowed.body.status).toBe("allowed");
    const working = uid("working");
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `work ${working}`, ts: `${uid("ts")}.2` }));
    await waitFor(async () => findRunByPrompt(`work ${working}`));
    // The membership goes; the binding row stays but no longer counts.
    await db.execute(sql`delete from member where user_id = (select id from "user" where email = ${email})`);
    const after = uid("after");
    const before = rec.messages.length;
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `work ${after}`, ts: `${uid("ts")}.3` }));
    await waitFor(async () => rec.messages.slice(before).find((m) => m.channel === channel && m.text.includes("asked this workspace's admins")) ?? null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await findRunByPrompt(`work ${after}`)).toBeNull();
    const reopened = await json<{ requests: Array<{ id: string; name: string; account: string | null }> }>("/api/team/access-requests");
    const row = reopened.body.requests.find((r) => r.name === "Leaver");
    expect(row?.id).toBe(request.id);
    expect(row?.account).toBe(email); // the card knows whom Allow restores
    // Allowing again restores the same account, the sender already owns a binding here, and says so on Slack again.
    const told = rec.messages.filter((m) => m.channel === slackUserId && m.text.includes("You are in")).length;
    await json(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: { email: "ignored@example.test" } });
    await waitFor(async () => (rec.messages.filter((m) => m.channel === slackUserId && m.text.includes("You are in")).length > told ? true : null));
    const back = uid("back");
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `work ${back}`, ts: `${uid("ts")}.4` }));
    const run = await waitFor(async () => findRunByPrompt(`work ${back}`));
    const [account] = await db.execute(sql`select id from "user" where email = ${email}`);
    expect(run.user_id).toBe((account as { id: string }).id);
    // The account itself is deleted: the leftover binding is no identity. Slack
    // still vouches for the address, so Allow creates a fresh account for it.
    await db.execute(sql`delete from "user" where id = ${(account as { id: string }).id}`);
    const later = uid("later");
    await postSlack(eventCallback({ type: "message", channel, channel_type: "im", user: slackUserId, text: `work ${later}`, ts: `${uid("ts")}.5` }));
    await waitFor(async () => (await json<{ requests: Array<{ id: string }> }>("/api/team/access-requests")).body.requests.find((r) => r.id === request.id) ?? null);
    const fresh = await json<{ status?: string; message?: string }>(`/api/team/access-requests/${request.id}/allow`, { method: "POST", body: {} });
    expect(`${fresh.status} ${fresh.body.status ?? fresh.body.message}`).toBe("200 allowed");
    const [replacement] = await db.execute(sql`select id from "user" where email = ${email}`);
    expect((replacement as { id: string }).id).not.toBe((account as { id: string }).id);
    const [rebound] = await db.execute(sql`select user_id from slack_users where team_id = ${TEAM} and slack_user_id = ${slackUserId}`);
    expect((rebound as { user_id: string }).user_id).toBe((replacement as { id: string }).id);
  });

  test("an event from an unmapped workspace is ignored", async () => {
    const marker = uid("noteam");
    const envelope = eventCallback(
      {
        type: "app_mention",
        channel: `C${uid("ch")}`,
        user: "U-HUMAN",
        text: `<@${BOT}> hi ${marker}`,
        ts: `${uid("ts")}.1`,
      },
      `T-UNMAPPED-${uid("t")}`,
    ) as SlackEnvelope;
    const res = await postSlack(envelope);
    expect(res.status).toBe(200); // acknowledged to Slack...
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`hi ${marker}`)).toBeNull(); // ...but no run
    const inbox = await waitFor(async () => {
      const [row] = await db.select().from(commands).where(eq(commands.id, slackInboxKey(envelope)));
      return row?.state === "completed" ? row : null;
    });
    expect(inbox.state).toBe("completed");
  });

  test("an event carrying no team_id at all is ignored", async () => {
    const marker = uid("teamless");
    await postSlack(
      eventCallback(
        {
          type: "app_mention",
          channel: `C${uid("ch")}`,
          user: "U-HUMAN",
          text: `<@${BOT}> hi ${marker}`,
          ts: `${uid("ts")}.1`,
        },
        null,
      ),
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(await findRunByPrompt(`hi ${marker}`)).toBeNull();
  });

  test("SLACK_WORKSPACE_BINDINGS syncs mappings at boot (malformed entries skipped)", async () => {
    const team = `T-BIND-${uid("t")}`;
    const saved = process.env.SLACK_WORKSPACE_BINDINGS;
    const savedUsers = process.env.SLACK_USER_BINDINGS;
    process.env.SLACK_WORKSPACE_BINDINGS = `${team}:${DEV_ORG_ID}:${DEV_USER_ID}, malformed-entry`;
    process.env.SLACK_USER_BINDINGS =
      `${team}:U-BOUND:${DEV_ORG_ID}:${DEV_USER_ID}, malformed-user-entry`;
    try {
      await syncSlackWorkspaceBindings();
    } finally {
      if (saved === undefined) delete process.env.SLACK_WORKSPACE_BINDINGS;
      else process.env.SLACK_WORKSPACE_BINDINGS = saved;
      if (savedUsers === undefined) delete process.env.SLACK_USER_BINDINGS;
      else process.env.SLACK_USER_BINDINGS = savedUsers;
    }
    expect(await findSlackWorkspace(team)).toEqual({
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
    });
    expect(await findSlackUser(team, "U-BOUND")).toEqual({
      orgId: DEV_ORG_ID,
      userId: DEV_USER_ID,
    });
    expect(await findSlackWorkspace("malformed-entry")).toBeNull();
  });
});

// Inbound attachments: files on an accepted message are downloaded bounded
// (Slack-hosted URLs only, size + count caps) and staged through the uploads
// lane, then claimed by the created run as its input files.
describe("slack inbound attachments", () => {
  const downloaded: string[] = [];
  let payload = new TextEncoder().encode("hello slack bytes");

  beforeAll(() => {
    setInboundFileDownloaderForTest(async (url) => {
      downloaded.push(url);
      return payload;
    });
  });

  afterAll(() => {
    setInboundFileDownloaderForTest(null);
  });

  function slackFile(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: `F${uid("f")}`,
      name,
      size: payload.byteLength,
      mimetype: "text/plain",
      url_private_download: `https://files.slack.com/files-pri/${TEAM}/${name}`,
      ...extra,
    };
  }

  async function uploadsByName(name: string) {
    return db.select().from(userUploads).where(eq(userUploads.name, name));
  }

  test("a mention with a file stages it and claims it for the created run", async () => {
    const marker = uid("attach");
    const fileName = `${marker}.txt`;
    await postSlack(
      eventCallback({
        type: "app_mention",
        channel: `C${uid("ch")}`,
        user: "U-HUMAN",
        text: `<@${BOT}> summarize ${marker}`,
        ts: `${uid("ts")}.1`,
        files: [slackFile(fileName)],
      }),
    );
    const run = await waitFor(async () => findRunByPrompt(`summarize ${marker}`));

    const rows = await waitFor(async () => {
      const found = await uploadsByName(fileName);
      return found.length > 0 ? found : null;
    });
    expect(rows).toHaveLength(1);
    const upload = rows[0]!;
    expect(upload.runId).toBe(run.id); // claimed atomically with acceptance
    expect(upload.orgId).toBe(DEV_ORG_ID);
    expect(upload.userId).toBe(DEV_USER_ID);
    expect(upload.contentType).toBe("text/plain; charset=utf-8");
    expect(upload.sizeBytes).toBe(payload.byteLength);
    expect(upload.sha256).toBe(
      new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
    );
  });

  test("a close after file staging checkpoints IDs and replay does not redownload", async () => {
    await stopSlackInboxPumpForTest();
    const operationId = `slack-stage-reclose:${crypto.randomUUID()}`;
    const marker = uid("reclose");
    const fileName = `${marker}.txt`;
    const envelope = eventCallback({
      type: "app_mention",
      channel: `C${uid("ch")}`,
      user: "U-HUMAN",
      text: `<@${BOT}> summarize ${marker}`,
      ts: `${uid("ts")}.1`,
      files: [slackFile(fileName)],
    }) as SlackEnvelope;
    const inboxKey = slackInboxKey(envelope);
    const downloadsBefore = downloaded.length;
    let closeAfterCheckpoint = true;
    try {
      expect((await postSlack(envelope)).status).toBe(200);
      await db
        .update(commands)
        .set({ createdAt: new Date(0) })
        .where(eq(commands.id, inboxKey));
      const first = await processSlackInbox(async (claim) => {
        const identity = await verifySlackInboxIdentity(claim.payload);
        if (identity.status !== "verified") return { status: "completed" };
        const outcome = await handleSlackEvent(claim.payload.envelope, {
          identity,
          stagedAttachmentIds: claim.payload.stagedAttachmentIds,
          checkpointStagedAttachmentIds: async (ids) => {
            await claim.checkpointStagedAttachmentIds(ids);
            if (closeAfterCheckpoint) {
              closeAfterCheckpoint = false;
              await setRunAdmission({
                open: false,
                operationId,
                actor: "test",
                reason: "close after Slack upload staging",
              });
            }
          },
        });
        return outcome.status === "retryable_unavailable"
          ? { status: "retryable_unavailable", error: outcome.reason }
          : { status: "completed" };
      });
      expect(first.requeued).toBeGreaterThanOrEqual(1);
      expect(downloaded.length - downloadsBefore).toBe(1);
      const [queued] = await db.select().from(commands).where(eq(commands.id, inboxKey));
      expect(queued.state).toBe("queued");
      expect((JSON.parse(queued.payload!) as { stagedAttachmentIds: string[] }).stagedAttachmentIds).toHaveLength(1);

      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "reopen after checkpoint proof",
      });
      restartSlackInboxPumpForTest();
      const run = await waitFor(async () => findRunByPrompt(`summarize ${marker}`));
      expect(run.id).toBeTruthy();
      expect(downloaded.length - downloadsBefore).toBe(1);
      const [upload] = await uploadsByName(fileName);
      expect(upload.runId).toBe(run.id);
    } finally {
      await setRunAdmission({
        open: true,
        operationId,
        actor: "test",
        reason: "test cleanup",
      });
      restartSlackInboxPumpForTest();
    }
  });

  test("a files-only DM (file_share subtype, no text) still creates a run", async () => {
    const fileName = `${uid("filesonly")}.txt`;
    await postSlack(
      eventCallback({
        type: "message",
        subtype: "file_share",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: "",
        ts: `${uid("ts")}.1`,
        files: [slackFile(fileName)],
      }),
    );
    // Wait for the CLAIMED upload, not merely the row: the files-only path
    // stages the upload before the synthesized run claims it, so a slow runner
    // can observe the legitimate runId=NULL window between the two.
    const upload = await waitFor(async () => {
      const row = (await uploadsByName(fileName))[0];
      return row?.runId ? row : null;
    });
    expect(upload.runId).toBeTruthy();
    const { body: run } = await json<any>(`/api/runs/${upload.runId}`);
    expect(run.prompt).toBe("Review the attached files.");
  });

  test("a scanner rejection is explicit and never starts a text-only run", async () => {
    const marker = uid("scan-reject");
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    setUploadScannerForTest(async () => {
      throw new UploadScanError("scanner unavailable");
    });
    try {
      await postSlack(
        eventCallback({
          type: "message",
          subtype: "file_share",
          channel,
          channel_type: "im",
          user: "U-HUMAN",
          text: `describe ${marker}`,
          ts,
          files: [slackFile(`${marker}.png`, { mimetype: "image/png" })],
        }),
      );

      await waitFor(async () =>
        rec.messages.find((message) =>
          message.channel === channel && message.threadTs === ts
        ) ?? null,
      );
      expect(await findRunByPrompt(`describe ${marker}`)).toBeNull();
      expect(
        rec.messages.find((message) => message.channel === channel && message.threadTs === ts)?.text,
      ).toContain("No run was started");
    } finally {
      setUploadScannerForTest(null);
    }
  });

  test("count cap: only the first 5 of 7 files are staged", async () => {
    const marker = uid("cap");
    const names = Array.from({ length: 7 }, (_, i) => `${marker}-${i}.txt`);
    await postSlack(
      eventCallback({
        type: "message",
        channel: `D${uid("dm")}`,
        channel_type: "im",
        user: "U-HUMAN",
        text: `cap ${marker}`,
        ts: `${uid("ts")}.1`,
        files: names.map((n) => slackFile(n)),
      }),
    );
    await waitFor(async () => findRunByPrompt(`cap ${marker}`));
    const staged = await waitFor(async () => {
      const rows = await Promise.all(names.map(uploadsByName));
      const flat = rows.flat();
      return flat.length >= 5 ? flat : null;
    });
    expect(staged).toHaveLength(5);
    expect(await uploadsByName(names[5]!)).toHaveLength(0);
    expect(await uploadsByName(names[6]!)).toHaveLength(0);
  });

  test("size cap: an over-declared file is skipped without downloading", async () => {
    const marker = uid("big");
    const fileName = `${marker}.bin`;
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    const before = downloaded.length;
    await postSlack(
      eventCallback({
        type: "message",
        channel,
        channel_type: "im",
        user: "U-HUMAN",
        text: `big ${marker}`,
        ts,
        files: [slackFile(fileName, { size: 21 * 1024 * 1024 })],
      }),
    );
    await waitFor(async () =>
      rec.messages.find((message) => message.channel === channel && message.threadTs === ts) ?? null,
    );
    expect(await findRunByPrompt(`big ${marker}`)).toBeNull();
    expect(await uploadsByName(fileName)).toHaveLength(0);
    expect(downloaded.length).toBe(before); // rejected on declared size, never fetched
  });

  test("only Slack-hosted https URLs are fetched (bot token never leaves Slack)", async () => {
    const marker = uid("offhost");
    const fileName = `${marker}.txt`;
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    const before = downloaded.length;
    await postSlack(
      eventCallback({
        type: "message",
        channel,
        channel_type: "im",
        user: "U-HUMAN",
        text: `offhost ${marker}`,
        ts,
        files: [
          slackFile(fileName, {
            url_private_download: `https://evil.example.com/steal-token/${fileName}`,
          }),
        ],
      }),
    );
    await waitFor(async () =>
      rec.messages.find((message) => message.channel === channel && message.threadTs === ts) ?? null,
    );
    expect(await findRunByPrompt(`offhost ${marker}`)).toBeNull();
    expect(await uploadsByName(fileName)).toHaveLength(0);
    expect(downloaded.length).toBe(before);
  });

  test("a lying declared size is caught after download (post-check cap)", async () => {
    const marker = uid("liar");
    const fileName = `${marker}.bin`;
    const channel = `D${uid("dm")}`;
    const ts = `${uid("ts")}.1`;
    const original = payload;
    payload = new Uint8Array(20 * 1024 * 1024 + 1); // real bytes over the cap
    try {
      await postSlack(
        eventCallback({
          type: "message",
          channel,
          channel_type: "im",
          user: "U-HUMAN",
          text: `liar ${marker}`,
          ts,
          files: [slackFile(fileName, { size: 100 })],
        }),
      );
      await waitFor(async () =>
        rec.messages.find((message) => message.channel === channel && message.threadTs === ts) ?? null,
      );
      expect(await findRunByPrompt(`liar ${marker}`)).toBeNull();
      expect(await uploadsByName(fileName)).toHaveLength(0);
    } finally {
      payload = original;
    }
  });
});
