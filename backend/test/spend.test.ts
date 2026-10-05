import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, providerEvents, runs, spendAccounts, spendEntries } from "../src/db/schema";
import { acceptRunCommand } from "../src/commands";
import { runIntentFingerprint, runIntentFromAcceptedRun } from "../src/commands/fingerprint";
import { replayCommittedWinner } from "../src/commands/service";
import { finalizeRun } from "../src/runs/finalize";
import { acceptProductChildBatch } from "../src/runs/child-thread-batch-service";
import {
  accrueRunSpend,
  priceRunUsage,
  SPEND_CHARGE_MAX_USD,
  SpendAllowanceExceededError,
  spendAllowanceDefaultUsd,
} from "../src/runs/spend";
import { providerKeyLimitReason } from "../src/provider-gateway/key-limit";
import { createOrgSession, fetchApi, json, uid, type OrgSession } from "./helpers";

// Spend allowance: accrual from the usage events production drivers emit, the
// per-charge double-count guard (including two finalizations racing), the hard
// cap at every acceptance (runs, thread replies, fleet batches, child batches)
// with keyed replays and the kill switch, org-scoped ledgers, and GET
// /api/spend. Runs use the scripted `mock` engine (no sandbox).

let session: OrgSession;
let userId: string;

async function memberOf(orgId: string): Promise<string> {
  const [row] = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, orgId));
  return row!.userId;
}

beforeAll(async () => {
  session = await createOrgSession("spend");
  userId = await memberOf(session.orgId);
});

afterEach(() => {
  delete process.env.SPEND_ALLOWANCE_USD;
});

async function account(orgId = session.orgId, user = userId) {
  const [row] = await db
    .select({ spent: spendAccounts.spentUsd, runs: spendAccounts.runs, allowance: spendAccounts.allowanceUsd })
    .from(spendAccounts)
    .where(and(eq(spendAccounts.orgId, orgId), eq(spendAccounts.userId, user)));
  return row ?? null;
}

async function setSpent(orgId: string, user: string, spentUsd: number) {
  await db.insert(spendAccounts).values({ orgId, userId: user, spentUsd })
    .onConflictDoUpdate({ target: [spendAccounts.orgId, spendAccounts.userId], set: { spentUsd } });
}

async function entry(chargeKey: string) {
  const [row] = await db.select().from(spendEntries).where(eq(spendEntries.chargeKey, chargeKey));
  return row ?? null;
}

async function runRow(id: string, engine: "opencode" | "claude" = "opencode") {
  await db.insert(runs).values({
    id, orgId: session.orgId, userId, prompt: "price me", model: "claude-opus-5",
    engine, status: "running", threadId: id,
  });
  return { id, orgId: session.orgId, userId };
}

/** Legacy OpenCode / Pi / chat usage: one `part.step-finish` per model call. */
async function stepFinishRun(id: string, payloads: Array<Record<string, unknown>>) {
  const run = await runRow(id);
  await db.insert(providerEvents).values(
    payloads.map((payload, seq) => ({
      id: `${id}-usage-${seq}`, runId: id, threadId: id, seq, provider: "opencode",
      eventType: "part.step-finish", nativeMessageId: `m${seq}`, nativePartId: `p${seq}`,
      payload: JSON.stringify({ type: "step-finish", tokens: { total: 100 }, ...payload }),
    })),
  );
  return run;
}

/** A runtime (t3) activity exactly as runtimeActivityProviderEvent stores it:
 *  the whole activity under `payload`, usage as typedUsage in its payload. */
function activityRow(runId: string, seq: number, activity: {
  id: string; kind: string; callId: string | null; payload: Record<string, unknown>;
}) {
  return {
    id: `pe_${runId}_t3_${activity.id}`, runId, threadId: runId, seq, provider: "t3",
    eventType: `t3.activity.${activity.kind}`, nativeSessionId: "session-1",
    nativePartId: activity.id, nativeCallId: activity.callId,
    payload: JSON.stringify({
      id: activity.id, tone: "tool", kind: activity.kind, summary: activity.kind, turnId: "turn-1",
      payload: activity.payload,
    }),
  };
}

function post(body: Record<string, unknown>, headers: Record<string, string> = {}, cookies = session.cookies) {
  return json<{ id?: string; error?: string; message?: string; spent?: number; allowance?: number }>(
    "/api/runs",
    { method: "POST", body, headers, cookies },
  );
}

describe("spend allowance", () => {
  test("the default is $100 and 0 (or junk) turns the cap off", () => {
    expect(spendAllowanceDefaultUsd({})).toBe(100);
    expect(spendAllowanceDefaultUsd({ SPEND_ALLOWANCE_USD: "250.5" })).toBe(250.5);
    expect(spendAllowanceDefaultUsd({ SPEND_ALLOWANCE_USD: "0" })).toBe(0);
    expect(spendAllowanceDefaultUsd({ SPEND_ALLOWANCE_USD: "lots" })).toBe(0);
  });

  test("settling a run charges the sum of its step-finish cost exactly once", async () => {
    const before = (await account())?.spent ?? 0;
    const run = await stepFinishRun(`spend_${uid()}`, [{ cost: 0.0125 }, { cost: 0.02 }, {}]);
    // A malformed usage payload prices as zero instead of blocking the settlement.
    await db.insert(providerEvents).values({
      id: `${run.id}-usage-bad`, runId: run.id, threadId: run.id, seq: 9, provider: "opencode",
      eventType: "part.step-finish", payload: '{"cost": "not a number", "tokens": {',
    });
    const first = await finalizeRun(run.id, "completed", "done", 10);
    expect(first.applied).toBe(true);
    const charged = await account();
    expect(charged!.spent).toBeCloseTo(before + 0.0325, 6);
    const row = await entry(run.id);
    expect(row!.costUsd).toBeCloseTo(0.0325, 6);
    expect(row!.tokens).toBe(300);
    expect(row!.source).toBe("usage");

    // A second finalize is a no-op, and a repeated accrual of the same run
    // (parallel, no transaction) inserts nothing and charges nothing.
    expect((await finalizeRun(run.id, "failed", "again", 10)).applied).toBe(false);
    await Promise.all([accrueRunSpend(run, db), accrueRunSpend(run, db)]);
    expect((await account())!.spent).toBeCloseTo(charged!.spent, 6);
    expect((await account())!.runs).toBe(charged!.runs);
  });

  test("two finalizations racing for the same run charge it once", async () => {
    const before = (await account())?.spent ?? 0;
    const run = await stepFinishRun(`spend_${uid()}`, [{ cost: 0.4 }]);
    const results = await Promise.all([
      finalizeRun(run.id, "completed", "first", 10),
      finalizeRun(run.id, "failed", "second", 10),
    ]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect((await account())!.spent).toBeCloseTo(before + 0.4, 6);
    expect(await db.select().from(spendEntries).where(eq(spendEntries.chargeKey, run.id))).toHaveLength(1);
  });

  test("a failed turn still spent, and the provider's settled figure is recorded as the winner", async () => {
    const before = (await account())?.spent ?? 0;
    const run = await stepFinishRun(`spend_${uid()}`, [{ cost: 0.5, costSource: "provider_generation" }]);
    await finalizeRun(run.id, "failed", "engine error", 10);
    expect((await account())!.spent).toBeCloseTo(before + 0.5, 6);
    expect((await entry(run.id))!.source).toBe("provider_generation");
  });

  test("a runtime-lane run is priced from the activities its driver emits: the largest cumulative figure per task, tokens kept", async () => {
    const before = (await account())?.spent ?? 0;
    const run = await runRow(`spend_${uid()}`, "claude");
    await db.insert(providerEvents).values([
      // One subagent task reported three times under one call id, cumulatively:
      // the last figure is the whole cost, not the sum of the snapshots.
      activityRow(run.id, 1, { id: "a1", kind: "task.started", callId: "task-1", payload: {
        taskId: "task-1", typedUsage: { inputTokens: 100, outputTokens: 20, costUsd: 0.1 },
      } }),
      activityRow(run.id, 2, { id: "a2", kind: "task.progress", callId: "task-1", payload: {
        taskId: "task-1", typedUsage: { inputTokens: 200, outputTokens: 40, costUsd: 0.2 },
      } }),
      activityRow(run.id, 3, { id: "a3", kind: "task.completed", callId: "task-1", payload: {
        taskId: "task-1", state: { costUsd: 0.3, typedUsage: { inputTokens: 300, outputTokens: 60 } },
      } }),
      // An MCP tool call that reports tokens only.
      activityRow(run.id, 4, { id: "b1", kind: "tool.completed", callId: "call-9", payload: {
        toolCallId: "call-9", data: { item: { typedUsage: { inputTokens: 12, outputTokens: 3 } } },
      } }),
      // A tool call with no usage at all.
      activityRow(run.id, 5, { id: "c1", kind: "tool.completed", callId: "call-10", payload: { toolCallId: "call-10" } }),
    ]);
    expect(await priceRunUsage(run.id)).toEqual({ cost: 0.3, tokens: 375, source: "usage" });
    await finalizeRun(run.id, "completed", "done", 10);
    expect((await account())!.spent).toBeCloseTo(before + 0.3, 6);
    expect(await entry(run.id)).toMatchObject({ costUsd: 0.3, tokens: 375, source: "usage" });
  });

  test("usage under data.item.state, the deepest nesting the harness reads, is priced", async () => {
    const run = await runRow(`spend_${uid()}`, "claude");
    await db.insert(providerEvents).values([
      activityRow(run.id, 1, { id: "d1", kind: "tool.completed", callId: "call-1", payload: {
        toolCallId: "call-1",
        data: { item: { state: { costUsd: 0.25, typedUsage: { inputTokens: 10, outputTokens: 5 } } } },
      } }),
    ]);
    expect(await priceRunUsage(run.id)).toEqual({ cost: 0.25, tokens: 15, source: "usage" });
  });

  test("a token count past the integer column is clamped, not a failed settlement", async () => {
    const run = await stepFinishRun(`spend_${uid()}`, [{ cost: 0.01, tokens: { total: 2_147_483_648 } }, { cost: 0.01, tokens: { total: 5 } }]);
    expect((await finalizeRun(run.id, "completed", "done", 10)).applied).toBe(true);
    expect(await entry(run.id)).toMatchObject({ costUsd: 0.02, tokens: 2_147_483_647, source: "usage" });
  });

  test("a run whose events carry tokens but no cost is charged as unpriced, never a silent zero", async () => {
    const run = await runRow(`spend_${uid()}`, "claude");
    await db.insert(providerEvents).values([
      activityRow(run.id, 1, { id: "b1", kind: "tool.completed", callId: "call-9", payload: {
        toolCallId: "call-9", typedUsage: { inputTokens: 12, outputTokens: 3 },
      } }),
    ]);
    expect(await priceRunUsage(run.id)).toEqual({ cost: 0, tokens: 15, source: "unpriced" });
    await finalizeRun(run.id, "completed", "done", 10);
    expect(await entry(run.id)).toMatchObject({ costUsd: 0, tokens: 15, source: "unpriced" });
  });

  test("a negative cost never subtracts and an absurd one is clamped instead of rolling the settlement back", async () => {
    const before = (await account())?.spent ?? 0;
    const run = await stepFinishRun(`spend_${uid()}`, [{ cost: -5 }, { cost: 5e12 }, { cost: 0.25 }]);
    expect((await priceRunUsage(run.id)).cost).toBe(SPEND_CHARGE_MAX_USD);
    expect((await finalizeRun(run.id, "completed", "done", 10)).applied).toBe(true);
    expect((await entry(run.id))!.costUsd).toBe(SPEND_CHARGE_MAX_USD);
    expect((await account())!.spent).toBe(Math.min(before + SPEND_CHARGE_MAX_USD, SPEND_CHARGE_MAX_USD));
    // Undo the clamp-sized charge so the later cap cases see ordinary figures.
    await setSpent(session.orgId, userId, before);
  });

  test("a member at the allowance is refused new work with the figures, replays and the kill switch still pass", async () => {
    const key = uid("spend-key");
    const accepted = await post({ prompt: "before the cap", engine: "mock" }, { "Idempotency-Key": key });
    expect(accepted.status).toBe(201);

    await setSpent(session.orgId, userId, 100);

    const refused = await post({ prompt: "over the cap", engine: "mock" });
    expect(refused.status).toBe(402);
    expect(refused.body.error).toBe("spend_allowance_exceeded");
    expect(refused.body.message).toBe(
      "You have spent $100.00 of your $100.00 allowance. New tasks are paused until it is raised.",
    );
    expect(refused.body).toMatchObject({ spent: 100, allowance: 100 });

    // The follow-up ingress refuses the same way.
    const reply = await json<{ error?: string }>(
      `/api/threads/${accepted.body.id}/messages`,
      { method: "POST", body: { text: "and again" }, headers: { "Idempotency-Key": uid("spend-reply") }, cookies: session.cookies },
    );
    expect(reply.status).toBe(402);
    expect(reply.body.error).toBe("spend_allowance_exceeded");

    // A keyed replay is a read of the original decision, not new work.
    const replay = await post({ prompt: "before the cap", engine: "mock" }, { "Idempotency-Key": key });
    expect(replay).toMatchObject({ status: 200, body: { id: accepted.body.id } });

    // GET /api/spend shows the member's own figures.
    const mine = await json<{ spent: number; allowance: number | null }>("/api/spend", { cookies: session.cookies });
    expect(mine.status).toBe(200);
    expect(mine.body.spent).toBeCloseTo(100, 6);
    expect(mine.body.allowance).toBe(100);

    // Kill switch: no cap, and the snapshot says so.
    process.env.SPEND_ALLOWANCE_USD = "0";
    expect((await post({ prompt: "cap is off", engine: "mock" })).status).toBe(201);
    expect((await json<{ allowance: number | null }>("/api/spend", { cookies: session.cookies })).body.allowance).toBeNull();
    delete process.env.SPEND_ALLOWANCE_USD;

    // The ledger is per organisation: the same person in a second org starts fresh.
    const create = await fetchApi("/api/auth/organization/create", {
      method: "POST", cookies: session.cookies, body: { name: "Second org", slug: uid("slug") },
    });
    expect(create.status).toBe(200);
    session.jar.absorb(create);
    const created = (await create.json()) as { id?: string; organization?: { id?: string } };
    const otherOrgId = created.id ?? created.organization?.id!;
    const setActive = await fetchApi("/api/auth/organization/set-active", {
      method: "POST", cookies: session.jar.header(), body: { organizationId: otherOrgId },
    });
    expect(setActive.status).toBe(200);
    session.jar.absorb(setActive);
    session = { ...session, cookies: session.jar.header() };
    expect((await post({ prompt: "fresh ledger", engine: "mock" })).status).toBe(201);
    const other = await json<{ spent: number }>("/api/spend", { cookies: session.cookies });
    expect(other.body.spent).toBe(0);
  });

  test("fleet batches and delegated child batches refuse a capped member inside their own acceptance", async () => {
    const batchSession = await createOrgSession("spend-batches");
    const batchUser = await memberOf(batchSession.orgId);
    const parent = await post({ prompt: "parent before the cap", engine: "mock" }, {}, batchSession.cookies);
    expect(parent.status).toBe(201);
    await setSpent(batchSession.orgId, batchUser, 100);

    const previousRollout = process.env.FLEET_BATCH_ROLLOUT;
    process.env.FLEET_BATCH_ROLLOUT = "write";
    let batch;
    try {
      batch = await json<{ error?: string; message?: string }>("/api/fleet/batches", {
        method: "POST", cookies: batchSession.cookies, headers: { "Idempotency-Key": uid("spend-batch") },
        body: { tasks: [{ prompt: "fan out", engine: "mock" }] },
      });
    } finally {
      if (previousRollout === undefined) delete process.env.FLEET_BATCH_ROLLOUT;
      else process.env.FLEET_BATCH_ROLLOUT = previousRollout;
    }
    expect(batch.status).toBe(402);
    expect(batch.body.error).toBe("spend_allowance_exceeded");
    expect(batch.body.message).toContain("$100.00 of your $100.00");

    await expect(acceptProductChildBatch({
      orgId: batchSession.orgId, actorId: batchUser, parentRunId: parent.body.id!, parentThreadId: parent.body.id!,
      idempotencyKey: uid("spend-children"), children: [{ title: "child", prompt: "delegate this" }],
    })).rejects.toBeInstanceOf(SpendAllowanceExceededError);
    expect(await db.select().from(runs).where(and(eq(runs.orgId, batchSession.orgId), like(runs.prompt, "delegate%")))).toHaveLength(0);
  });

  test("a keyed retry that met the cap after its winner committed replays the winner", async () => {
    const orgId = `spend-race-${crypto.randomUUID()}`;
    const key = uid("race-key");
    const runId = crypto.randomUUID();
    const run = {
      id: runId, prompt: "winner", model: "mock-model", engine: "mock" as const, parentRunId: null,
      threadId: runId, repos: [], memoryScope: "org" as const, skillId: null, skillVersion: null,
      skillContentHash: null, commandName: null, commandProvider: null, commandSessionId: null,
      commandCatalogRevision: null,
    };
    expect(await acceptRunCommand({ idempotencyKey: key, orgId, actorId: null, run })).toMatchObject({ status: "created", runId });
    const fingerprint = runIntentFingerprint(runIntentFromAcceptedRun(run));
    expect(await replayCommittedWinner(orgId, key, fingerprint, null, null)).toEqual({ status: "replayed", runId });
    expect(await replayCommittedWinner(orgId, key, "another-payload", null, null)).toMatchObject({ status: "conflict" });
    expect(await replayCommittedWinner(orgId, uid("unknown"), fingerprint, null, null)).toBeNull();
  });

  test("a spent provider key is named plainly, other errors are not", () => {
    expect(providerKeyLimitReason('openrouter 403: {"error":{"message":"Key limit exceeded","code":403}}'))
      .toContain("reached its spending limit");
    expect(providerKeyLimitReason("upstream returned 503")).toBeNull();
  });
});
