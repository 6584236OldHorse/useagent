import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { createChildSession } from "../src/runs/child-sessions";
import { getRunForOrg } from "../src/runs/repo";
import { acceptThreadFollowup } from "../src/runs/thread-followups";
import { createOrgSession, json, uid } from "./helpers";

// A follow-up accepted outside the HTTP run route (a product thread message, a
// bot handoff reply) goes through runs/thread-followups.ts and must carry the
// thread's reasoning level the way it carries the thread's model, so every
// ingress behaves the same. The Slack ingress has its own case in slack.test.ts.

const rolloutEnv = new Map<string, string | undefined>();
beforeAll(() => {
  for (const key of ["THREAD_RELATIONSHIPS_WRITE", "THREAD_RELATIONSHIPS_READ", "PRODUCT_CHILD_THREADS"]) {
    rolloutEnv.set(key, process.env[key]);
  }
  process.env.THREAD_RELATIONSHIPS_WRITE = "on";
  process.env.THREAD_RELATIONSHIPS_READ = "read";
  process.env.PRODUCT_CHILD_THREADS = "on";
});
afterAll(() => {
  for (const [key, value] of rolloutEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("reasoning effort on follow-ups through the thread door", () => {
  test("a thread message inherits the thread's level, and its keyed replay returns the same run", async () => {
    const owner = await createOrgSession("effort-followup");
    const root = await json<{ id: string }>("/api/runs", {
      method: "POST",
      cookies: owner.cookies,
      body: { prompt: "start the codex thread", engine: "codex", model: "gpt-5.6-sol" },
    });
    expect(root.status, JSON.stringify(root.body)).toBe(201);
    const parent = await getRunForOrg(owner.orgId, root.body.id);
    if (!parent) throw new Error("root run missing");
    const child = await createChildSession({
      orgId: owner.orgId,
      actorId: parent.userId,
      parentRunId: parent.id,
      threadId: parent.threadId,
      title: "Child",
      prompt: "child task",
      engine: parent.engine,
      model: parent.model,
      repos: parent.repos,
      memoryScope: parent.memoryScope,
      idempotencyKey: uid("effort-child"),
    });
    if (child.status === "conflict") throw new Error("child conflict");
    // The child thread carries a level (as a turn chosen in the picker would leave it).
    await db.update(runs).set({ reasoningEffort: "high" }).where(eq(runs.id, child.child.id));

    const key = uid("effort-followup-key");
    const followup = await acceptThreadFollowup({
      orgId: owner.orgId,
      actorId: parent.userId,
      threadId: child.child.threadId,
      text: "keep going",
      attachmentIds: [],
      idempotencyKey: key,
    });
    if (followup.status !== "created") throw new Error(`unexpected follow-up ${followup.status}`);
    const accepted = await json<{ reasoning_effort: string | null; model: string }>(
      `/api/runs/${followup.runId}`,
      { cookies: owner.cookies },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.model).toBe(parent.model);
    expect(accepted.body.reasoning_effort).toBe("high");

    // The level is in the keyed intent on this door too: the same key replays the same run.
    const replay = await acceptThreadFollowup({
      orgId: owner.orgId,
      actorId: parent.userId,
      threadId: child.child.threadId,
      text: "keep going",
      attachmentIds: [],
      idempotencyKey: key,
    });
    expect(replay).toMatchObject({ status: "replayed", runId: followup.runId });
  });
});
