import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
// Booting the app applies the migrations the projector writes through.
import "./helpers";
import { db } from "../src/db/client";
import { providerEvents, runs } from "../src/db/schema";
import { translateOpenCode, type OpenCodeFrame, type OpenCodeStep } from "../src/engines/opencode-canonical";
import { waitForRuntimeTurn } from "../src/engines/runtime-adapter";
import { activityRevisions } from "../src/engines/turn-projector";
import type { RuntimeThreadStreamItem } from "../src/engines/runtime-event-stream";
import {
  runtimeThreadId,
  runtimeUserMessageId,
  type RuntimeActivity,
  type RuntimeThreadSnapshot,
} from "../src/engines/runtime-orchestration";
import type { EmitStep, EngineRunContext } from "../src/engines/types";
import { getNativeFramesSince } from "../src/runs/native-events";
import { drainProviderEvents } from "../src/runs/provider-events";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { createSecretRedactor } from "../src/secrets/redact";

// One Codex turn in the event shapes of the runtime's pinned contract
// (packages/contracts/src/orchestration.ts at 90dc3ebbb74b): the user message,
// the session coming alive, a command with streamed output, a usage frame, a
// plan revised under its own id, the buffered answer, the checkpoint and the
// session going idle. Sequence 12 (thread.turn-start-requested) is not a thread
// detail event, so the stream never delivers it.
type Fields = Record<string, unknown>;
interface StreamEvent {
  readonly sequence: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Fields;
  readonly delivered: boolean;
}

const at = (second: number) => `2026-10-02T10:00:${String(second).padStart(2, "0")}.000Z`;

function codexTurn(threadId: string, userMessageId: string) {
  const session = (status: string, activeTurnId: string | null, second: number) => ({
    threadId, status, providerName: "codex", runtimeMode: "full-access", activeTurnId, lastError: null, updatedAt: at(second),
  });
  const tool = (id: string, kind: string, sequence: number, second: number, extra: Fields = {}): RuntimeActivity => ({
    id, tone: "tool", kind, summary: kind === "tool.started" ? "Run command started" : "Run command",
    payload: { itemType: "command_execution", toolCallId: "call-1", title: "Run command", detail: "ls", ...extra },
    turnId: "turn-1", sequence, ...{ createdAt: at(second) },
  });
  const plan = (status: string, sequence: number, second: number): RuntimeActivity => ({
    id: "evt-plan", tone: "info", kind: "turn.plan.updated", summary: "Plan updated",
    payload: { plan: [{ step: "List the files", status }] }, turnId: "turn-1", sequence, ...{ createdAt: at(second) },
  });
  const base: RuntimeThreadSnapshot = {
    snapshotSequence: 10,
    thread: {
      id: threadId,
      latestTurn: {
        turnId: "turn-prior", state: "completed", requestedAt: at(1), startedAt: at(1), completedAt: at(3),
        assistantMessageId: "msg-prior",
      },
      messages: [
        { id: "skynet-message-run-prior", role: "user", text: "hello", turnId: null, streaming: false, createdAt: at(1) },
        { id: "msg-prior", role: "assistant", text: "Hi there.", turnId: "turn-prior", streaming: false, createdAt: at(2) },
      ],
      activities: [{ ...tool("evt-prior", "tool.completed", 1, 2), turnId: "turn-prior" }],
      session: session("ready", null, 3),
    },
  };
  const event = (sequence: number, type: string, payload: Fields, delivered = true): StreamEvent => ({
    sequence, type, occurredAt: at(sequence), payload: { threadId, ...payload }, delivered,
  });
  const appended = (sequence: number, activity: RuntimeActivity) => event(sequence, "thread.activity-appended", { activity });
  const message = (sequence: number, fields: Fields) => event(sequence, "thread.message-sent", {
    messageId: "msg-1", role: "assistant", turnId: "turn-1", createdAt: at(sequence), updatedAt: at(sequence), ...fields,
  });
  const events: StreamEvent[] = [
    message(11, { messageId: userMessageId, role: "user", text: "List the files", turnId: null, streaming: false }),
    event(12, "thread.turn-start-requested", { messageId: userMessageId, createdAt: at(11) }, false),
    event(13, "thread.session-set", { session: session("running", "turn-1", 13) }),
    appended(14, tool("evt-14", "tool.started", 2, 14, { status: "inProgress" })),
    appended(15, tool("evt-15", "tool.updated", 3, 15, { status: "inProgress", data: { item: { aggregatedOutput: "a.ts\n" } } })),
    appended(16, tool("evt-16", "tool.updated", 4, 16, { status: "inProgress", data: { item: { aggregatedOutput: "a.ts\nb.ts\nc.ts\n" } } })),
    appended(17, tool("evt-17", "tool.completed", 5, 17, { status: "completed", data: { item: { aggregatedOutput: "a.ts\nb.ts\nc.ts\n", exitCode: 0 } } })),
    appended(18, {
      id: "evt-18", tone: "info", kind: "context-window.updated", summary: "Context window updated",
      payload: { usedTokens: 18315, maxTokens: 258400, inputTokens: 18282, cachedInputTokens: 17152, outputTokens: 33 },
      turnId: "turn-1", sequence: 6,
    }),
    appended(19, plan("inProgress", 7, 19)),
    message(20, { text: "There are three files: ", streaming: true }),
    appended(21, plan("completed", 8, 21)),
    message(22, { text: "a.ts, b.ts and c.ts.", streaming: true }),
    message(23, { text: "", streaming: false }),
    event(24, "thread.turn-diff-completed", {
      turnId: "turn-1", checkpointTurnCount: 2, checkpointRef: "refs/t3/2", status: "ready", files: [],
      assistantMessageId: "msg-1", completedAt: at(24),
    }),
    event(25, "thread.session-set", { session: session("ready", null, 25) }),
  ];
  return { base, events };
}

/** The runtime's own thread snapshot after `through`: its projection rules, then its snapshot's row drops. */
function runtimeSnapshot(base: RuntimeThreadSnapshot, events: readonly StreamEvent[], through: number): RuntimeThreadSnapshot {
  type Turn = NonNullable<RuntimeThreadSnapshot["thread"]["latestTurn"]>;
  const turns = new Map<string, Turn>([[base.thread.latestTurn!.turnId, base.thread.latestTurn!]]);
  let latestTurnId = base.thread.latestTurn!.turnId;
  let pendingRequestedAt: string | null = null;
  let session = base.thread.session as Fields | null;
  let messages = [...base.thread.messages] as Fields[];
  let activities = [...base.thread.activities];
  for (const { sequence, type, occurredAt, payload: p } of events) {
    if (sequence > through) break;
    if (type === "thread.turn-start-requested") pendingRequestedAt = p.createdAt as string;
    if (type === "thread.activity-appended") {
      const activity = p.activity as RuntimeActivity;
      activities = [...activities.filter(({ id }) => id !== activity.id), activity];
    }
    if (type === "thread.message-sent") {
      const existing = messages.find(({ id }) => id === p.messageId);
      const next = {
        id: p.messageId, role: p.role, turnId: p.turnId, streaming: p.streaming,
        text: p.streaming ? `${existing?.text ?? ""}${p.text}` : (p.text as string) || (existing?.text ?? ""),
        createdAt: existing?.createdAt ?? p.createdAt, updatedAt: p.updatedAt,
      };
      messages = existing ? messages.map((message) => message === existing ? next : message) : [...messages, next];
      const turn = typeof p.turnId === "string" && p.role === "assistant" ? turns.get(p.turnId) : undefined;
      if (turn) {
        const settles = !p.streaming && !(session?.status === "running" && session.activeTurnId === p.turnId);
        turns.set(turn.turnId, {
          ...turn, assistantMessageId: p.messageId as string,
          state: settles && turn.state === "running" ? "completed" : turn.state,
          completedAt: settles ? turn.completedAt ?? (p.updatedAt as string) : turn.completedAt,
        });
      }
    }
    if (type === "thread.session-set") {
      session = p.session as Fields;
      const turnId = session.activeTurnId as string | null;
      if (session.status === "running" && turnId) {
        const requestedAt = pendingRequestedAt ?? occurredAt;
        turns.set(turnId, turns.get(turnId) ?? {
          turnId, state: "running", requestedAt, startedAt: requestedAt, completedAt: null, assistantMessageId: null,
        });
        pendingRequestedAt = null;
        latestTurnId = turnId;
      } else {
        const settled = session.status === "ready" || session.status === "idle" ? "completed" : "interrupted";
        for (const turn of turns.values()) {
          if (turn.state === "running") turns.set(turn.turnId, { ...turn, state: settled, completedAt: session.updatedAt as string });
        }
      }
    }
    if (type === "thread.turn-diff-completed") {
      const turn = turns.get(p.turnId as string)!;
      const running = session?.status === "running" && session.activeTurnId === p.turnId;
      turns.set(turn.turnId, {
        ...turn, assistantMessageId: p.assistantMessageId as string, completedAt: p.completedAt as string,
        state: running ? turn.state : "completed",
      });
      latestTurnId = turn.turnId;
    }
  }
  const createdAt = (value: object) => String((value as Fields).createdAt ?? "");
  const order = (left: { id: string }, right: { id: string }) =>
    createdAt(left).localeCompare(createdAt(right)) || left.id.localeCompare(right.id);
  const call = (activity: RuntimeActivity) => `${activity.turnId}:${(activity.payload as Fields).toolCallId}`;
  const completed = new Set(activities.filter(({ kind }) => kind === "tool.completed").map(call));
  return {
    snapshotSequence: through,
    thread: {
      ...base.thread,
      latestTurn: turns.get(latestTurnId) ?? null,
      messages: (messages as unknown as RuntimeThreadSnapshot["thread"]["messages"][number][]).toSorted(order),
      activities: activities
        .filter((activity) => activity.kind !== "tool.updated" || !completed.has(call(activity)))
        .toSorted((left, right) => (left.sequence ?? -1) - (right.sequence ?? -1) || order(left, right)),
      session: session as RuntimeThreadSnapshot["thread"]["session"],
    },
  };
}

async function replay(mode: "full-snapshots" | "incremental", threadId: string) {
  const runId = `run-replay-${mode}-${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id: runId, orgId: `org-${runId}`, userId: "user-1", prompt: "List the files", model: "gpt-5.6-luna",
    engine: "codex", status: "running", threadId,
  });
  const runtimeThread = runtimeThreadId({ runId, threadId });
  const { base, events } = codexTurn(runtimeThread, runtimeUserMessageId(runId));
  const delivered = events.filter((event) => event.delivered);
  const steps: OpenCodeStep[] = [];
  const deltas: string[] = [];
  let reads = 0;
  let readTally = 0;
  let deliveredThrough = base.snapshotSequence;
  const ctx = {
    runId,
    threadId,
    signal: new AbortController().signal,
    emit: async (step: EmitStep) => {
      const id = `step-${steps.length + 1}`;
      steps.push({ id, idx: steps.length, kind: step.kind, label: step.label, chip: step.chip ?? null, code_json: JSON.stringify(step.code_json ?? null) });
      return id;
    },
    updateStep: async (id: string, codeJson: unknown) => {
      steps.find((step) => step.id === id)!.code_json = JSON.stringify(codeJson);
    },
    publishDelta: (delta: string) => deltas.push(delta),
    setSummary() {},
    timing: { begin: () => () => {}, mark() {}, add: () => { readTally += 1; } },
  } as unknown as EngineRunContext;

  const summary = await waitForRuntimeTurn(ctx, {} as SandboxHandle, activityRevisions(base), base, createSecretRedactor([]), {
    watchLiveness: () => ({ signal: new AbortController().signal, heard() {}, dispose() {} }),
    readThreadSnapshot: async () => {
      reads += 1;
      return runtimeSnapshot(base, events, deliveredThrough);
    },
    subscribeRuntimeThread: async (_sandbox, _threadId, _after, signal, onItem: (item: RuntimeThreadStreamItem) => Promise<boolean>) => {
      await onItem({ kind: "snapshot", snapshot: base });
      for (const event of delivered) {
        if (signal.aborted) return;
        deliveredThrough = event.sequence;
        if (mode === "full-snapshots") {
          // What a full thread read after every event would show.
          if (!(await onItem({ kind: "snapshot", snapshot: runtimeSnapshot(base, events, event.sequence) }))) return;
          continue;
        }
        await onItem({ kind: "event", event: { ...event, aggregateKind: "thread", aggregateId: runtimeThread } });
        await Bun.sleep(1);
      }
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
  }, "codex");

  await drainProviderEvents(runId);
  const rows = await db.select().from(providerEvents).where(eq(providerEvents.runId, runId)).orderBy(asc(providerEvents.seq));
  const frames = await getNativeFramesSince(runId, -1);
  const canonical = translateOpenCode(frames as unknown as OpenCodeFrame[], { runId, threadId, engine: "codex" }, steps);
  const normalized = (value: unknown) => JSON.stringify(value).replaceAll(runId, "RUN");
  return {
    reads,
    readTally,
    summary,
    deltas,
    steps: normalized(steps),
    rows: normalized(rows.map(({ createdAt: _createdAt, runId: _runId, ...row }) => row)),
    canonical: normalized(canonical.events),
    canonicalCount: canonical.events.length,
  };
}

describe("runtime turn replay", () => {
  test("applying stream events in place records exactly what a full snapshot after every event records", async () => {
    const threadId = `thread-replay-${crypto.randomUUID()}`;
    const full = await replay("full-snapshots", threadId);
    const incremental = await replay("incremental", threadId);

    expect(full.summary).toBe("There are three files: a.ts, b.ts and c.ts.");
    expect(incremental.summary).toBe(full.summary);
    expect(incremental.deltas).toEqual(full.deltas);
    expect(incremental.steps).toBe(full.steps);
    expect(incremental.rows).toBe(full.rows);
    expect(incremental.canonical).toBe(full.canonical);
    expect(full.canonicalCount).toBeGreaterThan(5);

    // Fourteen delivered events were fourteen full thread reads before. In
    // place, the thread is read only across the undelivered sequence 12 (with
    // the session coming alive), at the checkpoint and when the session settles.
    expect(full.reads).toBe(0);
    expect(incremental.reads).toBe(3);
    expect(incremental.readTally).toBe(3);
  });
});
