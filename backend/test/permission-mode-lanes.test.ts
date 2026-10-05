import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createOrgSession, json, uid } from "./helpers";
import { createChildSession } from "../src/runs/child-sessions";
import { acceptThreadFollowup } from "../src/runs/thread-followups";
import { createRun, getRun, getRunForOrg } from "../src/runs/repo";

// The permission mode on every lane that continues an existing turn: a child
// session may not run on an engine that cannot honour the parent's mode, a
// product child thread's reply carries the chip's choice, and a bot handoff
// into an existing thread never widens what the asking turn was allowed to do.

const rolloutEnv = new Map<string, string | undefined>();
beforeAll(() => {
  for (const key of ["THREAD_RELATIONSHIPS_WRITE", "THREAD_RELATIONSHIPS_READ", "PRODUCT_CHILD_THREADS", "PRODUCT_CHILD_CANARY_ORG_IDS"]) {
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

async function rootRun(cookies: string, permissionMode: string) {
  const created = await json<{ id: string }>("/api/runs", {
    method: "POST",
    cookies,
    headers: { "Idempotency-Key": uid("root") },
    body: { prompt: `root ${permissionMode} ${uid("p")}`, engine: "mock", permission_mode: permissionMode },
  });
  expect(created.status).toBe(201);
  return created.body.id;
}

describe("permission mode across the lanes that continue a turn", () => {
  test("a child of a read-only turn keeps read only, and cannot be spawned on an engine that ignores it", async () => {
    const owner = await createOrgSession("perm-child-owner");
    const parent = await getRunForOrg(owner.orgId, await rootRun(owner.cookies, "read-only"));
    if (!parent) throw new Error("root run missing");
    const spawn = (engine: "mock" | "pi", key: string) => createChildSession({
      orgId: owner.orgId,
      actorId: parent.userId,
      parentRunId: parent.id,
      threadId: parent.threadId,
      title: `child on ${engine}`,
      prompt: "look around",
      engine,
      model: parent.model,
      repos: parent.repos,
      memoryScope: parent.memoryScope,
      idempotencyKey: key,
    });
    const child = await spawn("mock", uid("child"));
    if (child.status === "conflict") throw new Error("child conflict");
    expect((await getRun(child.child.id))?.permissionMode).toBe("read-only");
    // Pi is refused before a child session reaches the insert here (readiness), so the
    // guard every lane shares is exercised at the insert point itself.
    const id = crypto.randomUUID();
    await expect(createRun({
      id,
      prompt: "look around",
      model: parent.model,
      engine: "pi",
      orgId: owner.orgId,
      userId: parent.userId,
      parentRunId: null,
      threadId: id,
      repos: [],
      memoryScope: "org",
      permissionMode: "read-only",
    })).rejects.toMatchObject({ code: "permission_mode_unsupported" });
    expect(await getRun(id)).toBeNull();
  });

  test("a message into a product child thread carries the chip's choice and otherwise keeps the thread's mode", async () => {
    const owner = await createOrgSession("perm-message-owner");
    const parent = await getRunForOrg(owner.orgId, await rootRun(owner.cookies, "full-access"));
    if (!parent) throw new Error("root run missing");
    const child = await createChildSession({
      orgId: owner.orgId,
      actorId: parent.userId,
      parentRunId: parent.id,
      threadId: parent.threadId,
      title: "child",
      prompt: "child task",
      engine: parent.engine,
      model: parent.model,
      repos: parent.repos,
      memoryScope: parent.memoryScope,
      idempotencyKey: uid("child"),
    });
    if (child.status === "conflict") throw new Error("child conflict");
    const post = (body: Record<string, unknown>) =>
      json<{ id: string; error?: string }>(`/api/threads/${child.child.threadId}/messages`, {
        method: "POST",
        cookies: owner.cookies,
        headers: { "Idempotency-Key": uid("msg") },
        body,
      });

    const chosen = await post({ text: "look, do not touch", permission_mode: "read-only" });
    expect(chosen.status).toBe(201);
    expect((await getRun(chosen.body.id))?.permissionMode).toBe("read-only");

    const kept = await post({ text: "and now?" });
    expect(kept.status).toBe(201);
    expect((await getRun(kept.body.id))?.permissionMode).toBe("read-only");

    const invalid = await post({ text: "anything", permission_mode: "yolo" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_body");
  });

  test("a bot handoff into an existing thread narrows to the asking turn's mode", async () => {
    const owner = await createOrgSession("perm-handoff-owner");
    const asking = await getRunForOrg(owner.orgId, await rootRun(owner.cookies, "read-only"));
    const botRoot = await getRunForOrg(owner.orgId, await rootRun(owner.cookies, "full-access"));
    if (!asking || !botRoot) throw new Error("root runs missing");
    const botThread = await createChildSession({
      orgId: owner.orgId,
      actorId: botRoot.userId,
      parentRunId: botRoot.id,
      threadId: botRoot.threadId,
      title: "bot thread",
      prompt: "bot task",
      engine: botRoot.engine,
      model: botRoot.model,
      repos: botRoot.repos,
      memoryScope: botRoot.memoryScope,
      idempotencyKey: uid("bot"),
    });
    if (botThread.status === "conflict") throw new Error("bot thread conflict");
    expect((await getRun(botThread.child.id))?.permissionMode).toBe("full-access");

    const handoff = await acceptThreadFollowup({
      orgId: owner.orgId,
      actorId: asking.userId,
      threadId: botThread.child.threadId,
      text: "please look into this",
      attachmentIds: [],
      idempotencyKey: uid("handoff"),
      botHandoff: {
        kind: "bot_handoff_followup",
        sourceRunId: asking.id,
        parentThreadId: asking.threadId,
        botId: "bot-under-test",
      },
    });
    if (handoff.status !== "created") throw new Error(`handoff not created: ${handoff.status}`);
    expect((await getRun(handoff.runId))?.permissionMode).toBe("read-only");
  });
});
