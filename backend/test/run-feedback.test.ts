/**
 * In-app run feedback: POST /api/runs/:id/feedback. Scope (a member of another
 * organisation gets 404), the body shape, one row per run and user updated on
 * resend, the per-user window, and the Slack notice through the outbox with a
 * recording client. The client records what would be posted; nothing reaches
 * Slack.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, runFeedback, slackOutbox, user } from "../src/db/schema";
import { env } from "../src/env";
import {
  admitFeedback,
  FEEDBACK_MAX_PER_WINDOW,
  FEEDBACK_TEXT_MAX,
  FEEDBACK_WINDOW_MS,
  feedbackWindow,
} from "../src/runs/feedback-routes";
import { createRun, setRunStatus } from "../src/runs/repo";
import { startSlackOutbox } from "../src/slack";
import type { SlackClient } from "../src/slack/client";
import { processDue, stopSlackOutboxRelay } from "../src/slack/outbox";
import { upsertSlackWorkspace } from "../src/slack/workspaces";
import { createOrgSession, fetchApi, json, uid, type OrgSession } from "./helpers";

async function completedRun(org: OrgSession): Promise<string> {
  const id = crypto.randomUUID();
  await createRun({
    id,
    prompt: "rate me",
    model: "m",
    engine: "mock",
    orgId: org.orgId,
    userId: null,
    parentRunId: null,
    threadId: id,
    repos: [],
    memoryScope: "org",
  });
  await setRunStatus(id, "completed");
  return id;
}

const send = (runId: string, cookies: string | undefined, body: unknown) =>
  json<any>(`/api/runs/${runId}/feedback`, { method: "POST", cookies, body });

const rowsFor = (runId: string) => db.select().from(runFeedback).where(eq(runFeedback.runId, runId));

/** A second person inside `org`: their own account, switched into that organisation. */
async function joinOrg(org: OrgSession, label: string): Promise<OrgSession> {
  const other = await createOrgSession(label);
  const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, other.email));
  await db.insert(member).values({
    id: uid("member"),
    organizationId: org.orgId,
    userId: account!.id,
    role: "member",
    createdAt: new Date(),
  });
  const setActive = await fetchApi("/api/auth/organization/set-active", {
    method: "POST",
    cookies: other.cookies,
    body: { organizationId: org.orgId },
  });
  expect(setActive.status).toBe(200);
  other.jar.absorb(setActive);
  other.cookies = other.jar.header();
  return other;
}

function recordingClient(posted: Array<{ channel: string; text: string }>): SlackClient {
  const ok = async () => ({ ok: true as const });
  return {
    postMessage: async ({ channel, text }) => {
      posted.push({ channel, text });
      return { ok: true, ts: "1.1" };
    },
    updateMessage: ok,
    addReaction: ok,
    uploadFile: ok,
    setSessionStatus: ok,
    setThreadStatus: ok,
    startStream: ok,
    appendStream: ok,
    stopStream: ok,
  };
}

describe("run feedback", () => {
  test("a member rates a run of their organisation; anyone else gets 404", async () => {
    const org = await createOrgSession("fb-scope");
    const outsider = await createOrgSession("fb-outsider");
    const runId = await completedRun(org);

    expect((await send(runId, outsider.cookies, { verdict: "good" })).status).toBe(404);
    expect((await send(runId, undefined, { verdict: "good" })).status).toBe(404);
    expect(await rowsFor(runId)).toHaveLength(0);

    const own = await send(runId, org.cookies, { verdict: "good", text: " Nice work " });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ run_id: runId, verdict: "good", text: "Nice work", revision: 1 });
    const rows = await rowsFor(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBe(org.orgId);
  });

  test("refuses a missing verdict, an unknown verdict, and a note that is not a bounded string", async () => {
    const org = await createOrgSession("fb-shape");
    const runId = await completedRun(org);
    expect((await send(runId, org.cookies, {})).status).toBe(400);
    expect((await send(runId, org.cookies, { verdict: "meh" })).status).toBe(400);
    expect((await send(runId, org.cookies, { verdict: "bad", text: 7 })).status).toBe(400);
    expect((await send(runId, org.cookies, { verdict: "bad", text: null })).status).toBe(400);
    expect((await send(runId, org.cookies, { verdict: "bad", text: "a\u0000b" })).status).toBe(400);
    const long = await send(runId, org.cookies, { verdict: "bad", text: "x".repeat(FEEDBACK_TEXT_MAX + 1) });
    expect(long.status).toBe(400);
    expect(await rowsFor(runId)).toHaveLength(0);
  });

  test("a resend by the same person updates their row; a colleague gets their own", async () => {
    const org = await createOrgSession("fb-again");
    const runId = await completedRun(org);
    const first = await send(runId, org.cookies, { verdict: "good", text: "first take" });
    expect(first.status).toBe(200);
    const second = await send(runId, org.cookies, { verdict: "bad", text: "changed my mind" });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ id: first.body.id, verdict: "bad", text: "changed my mind", revision: 2 });

    const colleague = await joinOrg(org, "fb-colleague");
    const theirs = await send(runId, colleague.cookies, { verdict: "good" });
    expect(theirs.status).toBe(200);
    expect(theirs.body.id).not.toBe(first.body.id);
    expect(theirs.body.revision).toBe(1);

    const rows = await rowsFor(runId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.body.id)?.verdict).toBe("bad");
  });

  test("the window forgets people once their window has elapsed", () => {
    const t0 = Date.now() + 10 * FEEDBACK_WINDOW_MS; // clear of every stamp the route tests left
    expect(admitFeedback("fb-user-a", t0)).toEqual({ ok: true });
    expect(admitFeedback("fb-user-b", t0 + 1)).toEqual({ ok: true });
    expect(feedbackWindow.has("fb-user-a")).toBe(true);
    // b's next call lands once a's window has elapsed but b's has not: a is dropped, b is kept.
    expect(admitFeedback("fb-user-b", t0 + FEEDBACK_WINDOW_MS)).toEqual({ ok: true });
    expect(feedbackWindow.has("fb-user-a")).toBe(false);
    expect(feedbackWindow.get("fb-user-b")).toEqual([t0 + 1, t0 + FEEDBACK_WINDOW_MS]);
  });

  test("one person is held to the window; the refused resend changes nothing", async () => {
    const org = await createOrgSession("fb-window");
    const runId = await completedRun(org);
    for (let i = 0; i < FEEDBACK_MAX_PER_WINDOW; i++) {
      expect((await send(runId, org.cookies, { verdict: "good", text: `take ${i}` })).status).toBe(200);
    }
    const refused = await send(runId, org.cookies, { verdict: "bad" });
    expect(refused.status).toBe(429);
    expect(refused.body.error).toBe("rate_limited");
    expect(refused.body.retry_after_ms).toBeGreaterThan(0);
    const [row] = await rowsFor(runId);
    expect(row).toMatchObject({ verdict: "good", revision: FEEDBACK_MAX_PER_WINDOW });
  });
});

describe("run feedback Slack notice", () => {
  const teamId = `T${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const channel = `C${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const saved = { channel: process.env.FEEDBACK_SLACK_CHANNEL, team: process.env.FEEDBACK_SLACK_TEAM_ID };

  // Only the explicit processDue() calls below deliver, so each assertion reads
  // exactly what the route queued.
  beforeAll(async () => {
    stopSlackOutboxRelay();
    // Earlier suites' due rows must not consume this test's twenty-row delivery pass.
    await db.delete(slackOutbox);
    process.env.FEEDBACK_SLACK_CHANNEL = channel;
    process.env.FEEDBACK_SLACK_TEAM_ID = teamId;
  });
  afterAll(() => {
    if (saved.channel === undefined) delete process.env.FEEDBACK_SLACK_CHANNEL;
    else process.env.FEEDBACK_SLACK_CHANNEL = saved.channel;
    if (saved.team === undefined) delete process.env.FEEDBACK_SLACK_TEAM_ID;
    else process.env.FEEDBACK_SLACK_TEAM_ID = saved.team;
    startSlackOutbox();
  });

  test("the notice names the verdict, the sender and organisation, links the run and quotes the note, posted as the bound workspace", async () => {
    // The workspace that owns the feedback channel belongs to one organisation;
    // feedback from any other organisation still posts with that workspace's bot.
    const vendor = await createOrgSession("fb-vendor");
    const [operator] = await db.select({ id: user.id }).from(user).where(eq(user.email, vendor.email));
    await upsertSlackWorkspace({ teamId, orgId: vendor.orgId, userId: operator!.id });

    const org = await createOrgSession("fb-notice");
    const runId = await completedRun(org);
    const sent = await send(runId, org.cookies, {
      verdict: "bad",
      text: "Broke <!channel> & the build\nsecond line",
    });
    expect(sent.status).toBe(200);

    const [queued] = await db
      .select()
      .from(slackOutbox)
      .where(eq(slackOutbox.idempotencyKey, `run-feedback:${sent.body.id}:1`));
    expect(queued).toBeTruthy();
    expect(JSON.parse(queued!.payload)).toMatchObject({ orgId: vendor.orgId, teamId, channel });

    const posted: Array<{ channel: string; text: string }> = [];
    await processDue(recordingClient(posted));
    const notice = posted.find((message) => message.channel === channel);
    expect(notice).toBeTruthy();
    expect(notice!.text).toContain(":-1: Bad run feedback from User fb-notice");
    expect(notice!.text).toContain(`(${org.email})`);
    expect(notice!.text).toContain("at Org fb-notice");
    expect(notice!.text).toContain(`<${env.FRONTEND_ORIGIN}/session/${runId}|run ${runId}>`);
    expect(notice!.text).toContain("channel &amp; the build\n> second line");
    expect(notice!.text).not.toContain("<!channel>");

    // A resend posts again, marked as an update.
    const again = await send(runId, org.cookies, { verdict: "good", text: "fixed now" });
    expect(again.status).toBe(200);
    posted.length = 0;
    await processDue(recordingClient(posted));
    const update = posted.find((message) => message.channel === channel);
    expect(update?.text).toContain(":+1: Good run feedback (updated) from User fb-notice");
    expect(update?.text).toContain("\n> fixed now");
  });

  test("without a configured channel the row still stands and nothing is queued", async () => {
    delete process.env.FEEDBACK_SLACK_CHANNEL;
    try {
      const org = await createOrgSession("fb-quiet");
      const runId = await completedRun(org);
      const sent = await send(runId, org.cookies, { verdict: "good" });
      expect(sent.status).toBe(200);
      expect(await rowsFor(runId)).toHaveLength(1);
      const queued = await db
        .select()
        .from(slackOutbox)
        .where(eq(slackOutbox.idempotencyKey, `run-feedback:${sent.body.id}:1`));
      expect(queued).toHaveLength(0);
    } finally {
      process.env.FEEDBACK_SLACK_CHANNEL = channel;
    }
  });
});
