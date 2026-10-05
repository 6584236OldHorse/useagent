import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { acceptRunCommand } from "../src/commands";
import { CANCEL_SUMMARY } from "../src/commands/cancel";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { stopRun } from "../src/runs/stop";
import "./helpers"; // side-effect: imports src/index → migrate + seed

// Stop reaches the whole delegation tree below a run's thread and nothing
// else: children and grandchildren still working are cancelled the durable
// way, siblings and parents are left alone.

const ORG = "org-skynet-dev";

/** A queued run opening its own thread (root: runId === threadId), with the relationship the product records. */
async function enqueue(threadRelationship?: { parentThreadId: string; familyThreadId: string }): Promise<string> {
  const id = crypto.randomUUID();
  const out = await acceptRunCommand({
    idempotencyKey: null,
    orgId: ORG,
    actorId: null,
    run: { id, prompt: "x", model: "claude-opus-5", engine: "mock", parentRunId: null, threadId: id },
    ...(threadRelationship
      ? { threadRelationship: { ...threadRelationship, kind: "delegated" as const, title: "child", sourceRunId: threadRelationship.parentThreadId } }
      : {}),
  });
  expect(out.status).toBe("created");
  return id;
}

const root = () => enqueue();
/** A queued run in a new thread the parent thread delegated to. */
const delegate = (parentThreadId: string, familyThreadId: string) => enqueue({ parentThreadId, familyThreadId });

async function record(runId: string): Promise<{ status: string; summary: string | null }> {
  const [row] = await db
    .select({ status: runs.status, summary: runs.summary })
    .from(runs)
    .where(and(eq(runs.orgId, ORG), eq(runs.id, runId)))
    .limit(1);
  return { status: row!.status, summary: row!.summary };
}

describe("stop reaches delegated threads", () => {
  test("stopping a run stops every live run below its thread, nearest first", async () => {
    const parent = await root();
    const child = await delegate(parent, parent);
    const grandchild = await delegate(child, parent);
    const sibling = await root();

    const outcome = await stopRun({ orgId: ORG, actorId: null, runId: parent });
    expect(outcome).toEqual({ status: "cancelling", replay: false, children: 2 });
    for (const id of [parent, child, grandchild]) {
      expect(await record(id)).toEqual({ status: "failed", summary: CANCEL_SUMMARY });
    }
    expect((await record(sibling)).status).toBe("queued");
  });

  test("a repeated Stop replays without counting children twice", async () => {
    const parent = await root();
    await delegate(parent, parent);
    await stopRun({ orgId: ORG, actorId: null, runId: parent });
    expect(await stopRun({ orgId: ORG, actorId: null, runId: parent })).toEqual({
      status: "cancelling",
      replay: true,
      children: 0,
    });
  });

  test("stopping a child leaves its parent and siblings working", async () => {
    const parent = await root();
    const child = await delegate(parent, parent);
    const sibling = await delegate(parent, parent);

    const outcome = await stopRun({ orgId: ORG, actorId: null, runId: child });
    expect(outcome).toEqual({ status: "cancelling", replay: false, children: 0 });
    expect((await record(child)).status).toBe("failed");
    expect((await record(parent)).status).toBe("queued");
    expect((await record(sibling)).status).toBe("queued");
  });

  test("a settled run is reported as such and its delegated threads are left alone", async () => {
    const parent = await root();
    const child = await delegate(parent, parent);
    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, parent));
    expect(await stopRun({ orgId: ORG, actorId: null, runId: parent })).toEqual({ status: "settled", runStatus: "completed" });
    expect((await record(child)).status).toBe("queued");
    expect(await stopRun({ orgId: ORG, actorId: null, runId: "missing" })).toEqual({ status: "not_found" });
  });
});
