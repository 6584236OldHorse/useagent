import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../index"; // side-effect: run committed migrations before DB assertions
import { db } from "../db/client";
import { runs } from "../db/schema";
import { threadSandboxWatched, watchThreadSandbox } from "../engines/sandbox-runtime";
import { withThreadLifecycleLock } from "../runs/thread-lifecycle-lock";
import { deleteExpiredSandboxes, pauseIdleSandboxes } from "./idle-sandboxes";
import { idleRetainedSandboxes } from "./lease-repo";

const orgId = `org-idle-${crypto.randomUUID()}`;
const originalDeleteMin = process.env.SANDBOX_AUTO_DELETE_MIN;

afterEach(async () => {
  await db.delete(runs).where(eq(runs.orgId, orgId));
  if (originalDeleteMin === undefined) delete process.env.SANDBOX_AUTO_DELETE_MIN;
  else process.env.SANDBOX_AUTO_DELETE_MIN = originalDeleteMin;
});

/** A thread whose last turn settled `minutesAgo` on a retained sandbox, optionally with a new turn queued. */
async function settledThread(name: string, minutesAgo: number, options: { readonly queued?: boolean } = {}) {
  const threadId = `${name}-${crypto.randomUUID()}`;
  const sandboxId = `sandbox-${threadId}`;
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const base = { orgId, userId: "user-idle", prompt: "p", model: "gpt-5", engine: "codex" as const, threadId };
  await db.insert(runs).values({
    ...base, id: threadId, status: "completed", threadSeq: 0, sandboxId, sandboxCredential: "env",
    createdAt: at, updatedAt: at, settledAt: at,
  });
  if (options.queued) {
    await db.insert(runs).values({ ...base, id: `${threadId}-next`, status: "queued", threadSeq: 1 });
  }
  return { threadId, sandboxId, runId: threadId };
}

describe("idle thread sandboxes", () => {
  test("pauses a settled thread's sandbox after two minutes, once, unless a turn or a viewer holds it", async () => {
    const idle = await settledThread("idle", 3);
    const fresh = await settledThread("fresh", 1);
    const busy = await settledThread("busy", 3, { queued: true });
    const watched = await settledThread("watched", 3);
    const pausedItself = await settledThread("paused-itself", 120);
    const mine = new Set([idle, fresh, busy, watched, pausedItself].map((thread) => thread.sandboxId));
    const pausedIds: string[] = [];
    const deps = {
      candidates: idleRetainedSandboxes,
      binding: async (sandboxId: string) => {
        if (!mine.has(sandboxId)) throw new Error("not this test's sandbox");
        return { provider: { pause: async (id: string) => { pausedIds.push(id); } } } as never;
      },
      watched: threadSandboxWatched,
      withLock: withThreadLifecycleLock,
    };

    const unwatch = watchThreadSandbox(watched.threadId);
    try {
      await pauseIdleSandboxes(deps);
      await pauseIdleSandboxes(deps);
    } finally {
      unwatch();
    }
    expect(pausedIds).toEqual([idle.sandboxId]);
  });

  test("deletes a sandbox idle past SANDBOX_AUTO_DELETE_MIN through the release path, never under a queued turn", async () => {
    process.env.SANDBOX_AUTO_DELETE_MIN = "60";
    // Settled far in the past so these sort ahead of any other suite's rows.
    const expired = await settledThread("expired", 10_000_000);
    const expiredBusy = await settledThread("expired-busy", 10_000_000, { queued: true });
    const recent = await settledThread("recent", 30);
    const mine = new Set([expired, expiredBusy, recent].map((thread) => thread.runId));
    const released: string[] = [];

    await deleteExpiredSandboxes({
      candidates: idleRetainedSandboxes,
      release: async (releaseOrgId, runId) => {
        if (mine.has(runId)) released.push(`${releaseOrgId}:${runId}`);
        return { ok: true, released: true, sandboxId: "released" };
      },
    });
    expect(released).toEqual([`${orgId}:${expired.runId}`]);
  });
});
