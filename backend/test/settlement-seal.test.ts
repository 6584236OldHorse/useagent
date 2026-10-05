import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, providerEvents, runs, spendAccounts, spendEntries } from "../src/db/schema";
import { followRuntimeThreadSnapshots } from "../src/engines/runtime-event-stream";
import { createTurnProjector } from "../src/engines/turn-projector";
import type { EngineRunContext } from "../src/engines/types";
import { settleStoppedTurnUsage } from "../src/engines/runtime-stop-accounting";
import { finalizeRun } from "../src/runs/finalize";
import { drainProviderEvents } from "../src/runs/provider-events";
import { createSecretRedactor } from "../src/secrets/redact";
import { createOrgSession, waitFor } from "./helpers";

// The settlement seal, through the REAL projector, capture chain, finalization
// and charge: a projection captures one usage figure, blocks on its step write,
// the run settles and is charged while it is blocked, the write is released and
// the projection resumes; nothing it records afterwards may land, and the charge
// stays what was captured before settlement.

test("a capture that resumes after settlement writes nothing, and the charge stays what was captured before", async () => {
  const session = await createOrgSession("seal");
  const [who] = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, session.orgId));
  const userId = who!.userId;
  const runId = `seal_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id: runId, orgId: session.orgId, userId, prompt: "seal me", model: "claude-opus-5",
    engine: "claude", status: "running", threadId: runId, origin: "internal:e2e",
  });

  const blocked = Promise.withResolvers<void>();
  const emitted: string[] = [];
  const ctx = {
    runId,
    threadId: runId,
    signal: new AbortController().signal,
    emit: async (step: { label: string }) => {
      emitted.push(step.label);
      if (emitted.length === 1) await blocked.promise; // the socket fails while this write is pending
      return `step-${emitted.length}`;
    },
    setSummary() {},
  } as unknown as EngineRunContext;
  const projector = createTurnProjector({ ctx, redact: createSecretRedactor([]), engine: "codex", seen: new Map() });
  // Tool calls carry usage exactly like subagent tasks but create no execution-graph
  // rows, so the settlement is not held up by an unresolved child execution.
  const usage = (id: string, costUsd: number) => ({
    id, tone: "tool" as const, kind: "tool.completed", summary: `Tool ${id}`,
    payload: { toolCallId: id, status: "completed", typedUsage: { inputTokens: 10, outputTokens: 5, costUsd } },
    turnId: "turn-1", sequence: 1,
  });
  const snapshot = {
    snapshotSequence: 2,
    thread: {
      id: `skynet-thread-${runId}`,
      latestTurn: { turnId: "turn-1", state: "completed" as const, assistantMessageId: null },
      messages: [],
      activities: [usage("task-a", 0.1), usage("task-b", 0.2)],
      session: null,
    },
  };

  // The projection captures task-a and blocks on its step write.
  const projection = projector.apply(snapshot);
  await waitFor(async () => (emitted.length === 1 ? true : null));
  await drainProviderEvents(runId);
  expect(await db.select({ id: providerEvents.id }).from(providerEvents).where(eq(providerEvents.runId, runId))).toHaveLength(1);

  // The stream has failed; finalization settles and charges the run now.
  const finalized = await finalizeRun(runId, "failed", "socket failed", 10);
  expect(finalized.applied).toBe(true);
  const [entry] = await db.select().from(spendEntries).where(eq(spendEntries.chargeKey, runId));
  expect(entry).toMatchObject({ costUsd: 0.1, source: "usage" });

  // The abandoned projection resumes: its next capture must not land.
  blocked.resolve();
  await projection;
  await drainProviderEvents(runId);
  const rows = await db.select({ id: providerEvents.id }).from(providerEvents).where(eq(providerEvents.runId, runId));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toContain("task-a");
  expect(emitted).toHaveLength(1);
  const [account] = await db.select({ spent: spendAccounts.spentUsd }).from(spendAccounts)
    .where(and(eq(spendAccounts.orgId, session.orgId), eq(spendAccounts.userId, userId)));
  expect(account!.spent).toBeCloseTo(0.1, 6);
});

// The stop path's own bound, through the real projector against a live run:
// once the bound fires, the projection records nothing further even when the
// write it was awaiting stalls past the bound.
test("once the stop bound fires the projection records nothing further, even when a write it was awaiting stalls past it", async () => {
  const session = await createOrgSession("seal-stop");
  const [who] = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, session.orgId));
  const runId = `seal_stop_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id: runId, orgId: session.orgId, userId: who!.userId, prompt: "stop me", model: "claude-opus-5",
    engine: "claude", status: "running", threadId: runId, origin: "internal:e2e",
  });
  const stalled = Promise.withResolvers<void>();
  const bound = new AbortController();
  const emitted: string[] = [];
  const ctx = {
    runId,
    threadId: runId,
    signal: new AbortController().signal,
    emit: async (step: { label: string }) => {
      emitted.push(step.label);
      if (emitted.length === 1) {
        bound.abort(new Error("stop accounting bound")); // fires while this write is pending
        await stalled.promise;
      }
      return `step-${emitted.length}`;
    },
    setSummary() {},
  } as unknown as EngineRunContext;
  const projector = createTurnProjector({ ctx, redact: createSecretRedactor([]), engine: "codex", seen: new Map() });
  const usage = (id: string, costUsd: number) => ({
    id, tone: "tool" as const, kind: "tool.completed", summary: `Tool ${id}`,
    payload: { toolCallId: id, status: "completed", typedUsage: { inputTokens: 10, outputTokens: 5, costUsd } },
    turnId: "turn-1", sequence: 1,
  });
  const snapshot = {
    snapshotSequence: 2,
    thread: {
      id: `skynet-thread-${runId}`,
      latestTurn: { turnId: "turn-1", state: "completed" as const, assistantMessageId: null },
      messages: [],
      activities: [usage("tool-a", 0.1), usage("tool-b", 0.2)],
      session: null,
    },
  };
  const landed = await settleStoppedTurnUsage({
    cancel: async () => undefined,
    read: async () => snapshot,
    apply: (snap, signal) => projector.apply(snap, undefined, { signal }),
    deadlineSignal: bound.signal,
  });
  expect(landed).toBe(false);
  expect(emitted).toHaveLength(1);
  stalled.resolve();
  await Bun.sleep(30);
  await drainProviderEvents(runId);
  expect(emitted).toHaveLength(1);
  expect(projector.seen().has("tool-a")).toBe(true);
  expect(projector.seen().has("tool-b")).toBe(false);
  const rows = await db.select({ id: providerEvents.id }).from(providerEvents).where(eq(providerEvents.runId, runId));
  expect(rows.map((row) => row.id)).toEqual([`pe_${runId}_t3_tool-a`]);
});

// Stop against a stalled projection, through the real follower, projector,
// capture chain, stop accounting and settlement: the follower returns within
// the stop bound, so the provider is cancelled while the step write still
// stalls; the stop accounting lands the usage the runtime billed; and the
// projection that resumes once the write releases records nothing further.
test("a stalled step write does not hold the stop: cancellation proceeds within the bound, and the resumed projection records nothing further", async () => {
  const session = await createOrgSession("seal-follow");
  const [who] = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, session.orgId));
  const userId = who!.userId;
  const runId = `seal_follow_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id: runId, orgId: session.orgId, userId, prompt: "stop me", model: "claude-opus-5",
    engine: "claude", status: "running", threadId: runId, origin: "internal:e2e",
  });
  const stalled = Promise.withResolvers<void>();
  const turn = new AbortController();
  const emitted: string[] = [];
  const ctx = {
    runId,
    threadId: runId,
    signal: turn.signal,
    emit: async (step: { label: string }) => {
      emitted.push(step.label);
      if (emitted.length === 1) await stalled.promise; // the first step write stalls past the stop
      return `step-${emitted.length}`;
    },
    setSummary() {},
  } as unknown as EngineRunContext;
  const projector = createTurnProjector({ ctx, redact: createSecretRedactor([]), engine: "codex", seen: new Map() });
  const usage = (id: string, costUsd: number) => ({
    id, tone: "tool" as const, kind: "tool.completed", summary: `Tool ${id}`,
    payload: { toolCallId: id, status: "completed", typedUsage: { inputTokens: 10, outputTokens: 5, costUsd } },
    turnId: "turn-1", sequence: 1,
  });
  const snapshot = {
    snapshotSequence: 2,
    thread: {
      id: `skynet-thread-${runId}`,
      latestTurn: { turnId: "turn-1", state: "completed" as const, assistantMessageId: null },
      messages: [],
      activities: [usage("tool-a", 0.1), usage("tool-b", 0.2)],
      session: null,
    },
  };

  // The follower captures tool-a and stalls on its step write; Stop is pressed.
  const startedAt = Date.now();
  await followRuntimeThreadSnapshots({
    sandbox: {} as never,
    threadId: snapshot.thread.id,
    initialSequence: 0,
    signal: turn.signal,
    stopBoundMs: 100,
    readSnapshot: async () => {
      throw new Error("unexpected refresh");
    },
    // Applied as the adapter applies while the turn runs: no fence of its own.
    applySnapshot: async (snap) => !(await projector.apply(snap)).settled,
    subscribe: async (_sandbox, _threadId, _after, _signal, onItem) => {
      void onItem({ kind: "snapshot", snapshot });
      await waitFor(async () => (emitted.length === 1 ? true : null));
      turn.abort(new Error("turn aborted")); // the socket resolves its subscription on abort
    },
  });
  expect(Date.now() - startedAt).toBeLessThan(2_000);
  expect(emitted).toHaveLength(1);

  // Cancellation reaches the provider while the write still stalls, and the
  // stop accounting lands the usage the runtime billed (tool-b; tool-a was
  // captured before the stall).
  let cancelled = false;
  const landed = await settleStoppedTurnUsage({
    cancel: async () => {
      cancelled = true;
    },
    read: async () => snapshot,
    apply: (snap, signal) => projector.apply(snap, undefined, { signal }),
  });
  expect(cancelled).toBe(true);
  expect(landed).toBe(true);
  await drainProviderEvents(runId);
  const captured = () => db.select({ id: providerEvents.id }).from(providerEvents).where(eq(providerEvents.runId, runId));
  expect((await captured()).map((row) => row.id).toSorted()).toEqual([`pe_${runId}_t3_tool-a`, `pe_${runId}_t3_tool-b`]);
  expect(emitted).toHaveLength(2);

  // The run settles and is charged what was captured; the stalled write then
  // releases and the abandoned projection resumes: nothing further lands.
  const finalized = await finalizeRun(runId, "failed", "stopped", 10);
  expect(finalized.applied).toBe(true);
  const [entry] = await db.select().from(spendEntries).where(eq(spendEntries.chargeKey, runId));
  expect(entry).toMatchObject({ costUsd: 0.3, source: "usage" });
  stalled.resolve();
  await Bun.sleep(30);
  await drainProviderEvents(runId);
  expect(await captured()).toHaveLength(2);
  expect(emitted).toHaveLength(2);
  const [account] = await db.select({ spent: spendAccounts.spentUsd }).from(spendAccounts)
    .where(and(eq(spendAccounts.orgId, session.orgId), eq(spendAccounts.userId, userId)));
  expect(account!.spent).toBeCloseTo(0.3, 6);
});
