import { describe, expect, test } from "bun:test";
import type { ThreadRelationship } from "@useagent/agent-client";
import type { GatewayChildSession } from "@/components/chat/gateway-children";
import type { NativeFrame } from "@/components/chat/native-events";
import type { ApiStep, StepKind } from "@/components/chat/types";
import {
  advanceLiveGrowth,
  deriveRunningStatus,
  deriveRunningStartedAt,
  deriveRunningWork,
  type LiveChannel,
  NEXT_STEP,
  NO_GROWTH,
  type RunningTurn,
} from "./running-phase";

type Ids = Partial<NativeFrame["native"]>;
function frame(seq: number, eventType: string, ids: Ids = {}, payload: unknown = { text: "x" }): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: `ev-${seq}`,
    seq,
    provider: eventType.startsWith("t3.") ? "t3" : "pi",
    eventType,
    native: {
      sessionId: ids.sessionId ?? "ses_root",
      parentSessionId: ids.parentSessionId ?? null,
      messageId: ids.messageId ?? "msg-1",
      partId: ids.partId ?? null,
      callId: ids.callId ?? null,
    },
    payload,
  };
}

function step(idx: number, kind: StepKind, label: string, code: Record<string, unknown> | null, chip: string | null = null): ApiStep {
  return {
    id: `step-${idx}`,
    run_id: "run-1",
    idx,
    kind,
    label,
    chip,
    code_json: code ? JSON.stringify(code) : null,
    created_at: "2026-09-13T10:00:00Z",
  };
}

const bash = (idx: number, command: string, callID: string) =>
  step(idx, "command", command, { tool: "bash", input: { command }, native: { sessionID: "ses_root", callID } });

test("execution start is durable across delayed queue dispatch and replay", () => {
  // Synthetic execution start; settled duration_ms can use a later worker timing origin.
  const accepted = { created_at: "2026-09-13T22:31:24.701Z" };
  const start = {
    ...step(0, "task", "Preparing context and runtime", { phase: "preparing" }, "boot"),
    created_at: "2026-09-13T22:34:48.724Z",
  };
  const running = { run: accepted, steps: [start, bash(1, "pwd", "call-1")] };
  expect(deriveRunningStartedAt({ steps: [] })).toBeNull();
  expect(deriveRunningStartedAt(running)).toBe(start.created_at);
  expect(Date.parse("2026-09-13T22:36:09.115Z") - Date.parse(deriveRunningStartedAt(running) ?? "")).toBe(80_391);
  const replay = JSON.parse(JSON.stringify(running)) as typeof running;
  replay.steps.reverse();
  expect(deriveRunningStartedAt(replay)).toBe(start.created_at);
});

test("chat has a start marker; absent, invalid and non-start rows never invent elapsed", () => {
  const chat = step(0, "task", "Preparing chat context", { phase: "retrieval" }, "chat");
  expect(deriveRunningStartedAt({ steps: [chat] })).toBe(chat.created_at);
  expect(deriveRunningStartedAt(null)).toBeNull();
  for (const candidate of [
    { ...chat, created_at: "invalid" },
    { ...chat, code_json: "{invalid" },
    { ...chat, idx: 1 },
    { ...chat, kind: "done" as const },
    bash(0, "pwd", "call-1"),
  ]) expect(deriveRunningStartedAt({ steps: [candidate] })).toBeNull();
});

function turn(over: { steps?: ApiStep[]; frames?: NativeFrame[]; liveText?: string; liveReasoning?: string } = {}): RunningTurn {
  return {
    steps: over.steps ?? [],
    liveText: over.liveText ?? "",
    liveReasoning: over.liveReasoning ?? "",
    executionSummary: null,
    native: over.frames ? { nativeFrames: over.frames } : undefined,
  };
}

/** The composer's two halves in one call. */
function status(
  t: RunningTurn,
  latest: LiveChannel = null,
  sessions: GatewayChildSession[] = [],
  product: ThreadRelationship[] = [],
) {
  return deriveRunningStatus(t, deriveRunningWork(t, sessions, product), latest);
}

describe("runtime adapters (claude, codex, opencode): t3 activity frames + text deltas", () => {
  const steps = [bash(0, "bun run typecheck", "call-1"), bash(1, "git status", "call-2")];

  test("an open tool names the work, matched to its row by call id", () => {
    const s = status(turn({ steps, frames: [frame(1, "t3.activity.tool.completed", { callId: "call-2" }), frame(2, "t3.activity.tool.started", { callId: "call-1" })] }));
    expect(s).toMatchObject({ phase: "working", label: "Working", sentence: "bun run typecheck", toolCalls: 2 });
  });

  test("a closed tool with nothing newer is Thinking; text that grew after it is writing", () => {
    const t = turn({ steps, frames: [frame(1, "t3.activity.tool.completed", { callId: "call-2" })], liveText: "The fix" });
    expect(status(t)).toMatchObject({ phase: "thinking", sentence: NEXT_STEP });
    expect(status(t, "text")).toMatchObject({ phase: "working", sentence: "Writing the reply" });
  });

  test("a stale answer never hides a tool that opened after it", () => {
    const t = turn({ steps, frames: [frame(1, "t3.activity.tool.started", { callId: "call-2" })], liveText: "Let me check" });
    expect(status(t, "text").sentence).toBe("git status");
  });

  test("completing one call closes only that call: an earlier call still running keeps naming the work", () => {
    const t = turn({
      steps,
      frames: [
        frame(1, "t3.activity.tool.started", { callId: "call-1" }),
        frame(2, "t3.activity.tool.started", { callId: "call-2" }),
        frame(3, "t3.activity.tool.completed", { callId: "call-2" }),
      ],
    });
    expect(status(t, "text")).toMatchObject({ phase: "working", sentence: "bun run typecheck" });
    const both = turn({ steps, frames: [frame(1, "t3.activity.tool.started", { callId: "call-1" }), frame(2, "t3.activity.tool.completed", { callId: "call-1" })] });
    expect(status(both).phase).toBe("thinking");
  });

  test("a provisional start without a call id is no call: its completion can never match it", () => {
    const anonymous = turn({
      steps,
      frames: [frame(1, "t3.activity.tool.started"), frame(2, "t3.activity.tool.completed")],
      liveText: "The answer",
    });
    expect(status(anonymous, "text")).toMatchObject({ phase: "working", sentence: "Writing the reply" });
    expect(deriveRunningWork(anonymous).openTool).toBeNull();
  });

  test("an updated call stays open; an error tone closes it", () => {
    const updated = turn({ steps, frames: [frame(1, "t3.activity.tool.started", { callId: "call-1" }), frame(2, "t3.activity.tool.updated", { callId: "call-1" })] });
    expect(status(updated).sentence).toBe("bun run typecheck");
    const errored = turn({ steps, frames: [frame(1, "t3.activity.tool.started", { callId: "call-1" }), frame(2, "t3.activity.tool.updated", { callId: "call-1" }, { tone: "error" })] });
    expect(status(errored).phase).toBe("thinking");
  });

  test("a subagent task in flight delegates under its title and counts as running", () => {
    const spawn = step(2, "task", "Verify checkout", { source: "t3", tool: "subagent", input: { description: "Verify checkout", prompt: "go" }, native: { sessionID: "agent-a", callID: "agent-a", childSessionID: "agent-a" } }, "subagent");
    const task = (seq: number, kind: string, extra: Record<string, unknown> = {}) =>
      frame(seq, `t3.activity.${kind}`, { callId: "agent-a" }, { id: `ev-${seq}`, kind, payload: { taskId: "agent-a", agentKind: "agent", ...extra } });
    const live = status(turn({ steps: [...steps, spawn], frames: [task(1, "task.started"), task(2, "task.progress", { summary: "Running the suite" })] }));
    expect(live).toMatchObject({ phase: "delegating", label: "Delegating Verify checkout", sentence: "Running the suite", agentsRunning: 1, agentsDone: 0 });
    const done = status(turn({ steps: [...steps, spawn], frames: [task(1, "task.started"), task(2, "task.completed", { summary: "All green" })] }), "text");
    expect(done).toMatchObject({ phase: "working", sentence: "Writing the reply", agentsRunning: 0, agentsDone: 1 });
  });
});

describe("pi bridge: part frames for text, reasoning and tools", () => {
  test("reasoning, then an open tool, then a completed tool and answer text", () => {
    const steps = [bash(0, "ls", "call-1")];
    expect(status(turn({ frames: [frame(1, "part.step-start"), frame(2, "part.reasoning")] }))).toMatchObject({ phase: "thinking", toolCalls: 0 });
    expect(status(turn({ steps, frames: [frame(1, "part.reasoning"), frame(2, "part.tool", { callId: "call-1" })] })).sentence).toBe("ls");
    expect(status(turn({ steps, frames: [frame(1, "part.tool.completed", { callId: "call-1" }), frame(2, "part.text")] }))).toMatchObject({ phase: "working", sentence: "Writing the reply" });
    expect(status(turn({ steps, frames: [frame(1, "part.tool.completed", { callId: "call-1" }), frame(2, "part.reasoning")] })).phase).toBe("thinking");
  });

  test("a child's own frames never speak for the parent", () => {
    const s = status(turn({ frames: [frame(1, "part.reasoning"), frame(2, "part.text", { sessionId: "ses_child", parentSessionId: "ses_root" })] }));
    expect(s.phase).toBe("thinking");
  });

  test("a lifecycle row that names the root as its own parent does not make the root a child", () => {
    const steps = [bash(0, "ls", "call-1")];
    const s = status(
      turn({
        steps,
        frames: [
          frame(1, "part.tool.completed", { callId: "call-1" }),
          frame(2, "part.subtask.completed", { sessionId: "ses_root", parentSessionId: "ses_root", callId: "child-1" }),
          frame(3, "part.text"),
        ],
      }),
    );
    expect(s).toMatchObject({ phase: "working", sentence: "Writing the reply" });
  });

  test("a plan update is never an open call: the answer keeps streaming after a completed tool", () => {
    const steps = [bash(0, "ls", "call-1"), step(1, "command", "todos", { tool: "todowrite", input: { todos: [] } }, "plan")];
    const plan = frame(2, "part.tool", { callId: "pi-plan" }, { tool: "todowrite", input: { todos: [] } });
    const t = turn({ steps, frames: [frame(1, "part.tool.completed", { callId: "call-1" }), plan], liveText: "Here is the plan" });
    expect(status(t, "text")).toMatchObject({ phase: "working", sentence: "Writing the reply" });
    expect(status(t).phase).toBe("thinking");
  });

  test("two announced calls: the open call's frame picks its own row by call id", () => {
    const steps = [bash(0, "cat a.txt", "call-a"), bash(1, "cat b.txt", "call-b")];
    const s = status(turn({ steps, frames: [frame(1, "part.tool", { callId: "call-b" }), frame(2, "part.tool", { callId: "call-a" })] }));
    expect(s.sentence).toBe("cat a.txt");
  });
});

describe("without frames: chat (steps + text deltas), then the delta channel alone", () => {
  const context = step(0, "task", "Preparing chat context...", { phase: "retrieval" }, "chat");

  test("the chat engine's context step is the work until the answer starts streaming", () => {
    expect(status(turn({ steps: [context] }))).toMatchObject({ phase: "working", sentence: "Preparing chat context...", toolCalls: 0 });
    expect(status(turn({ steps: [context], liveText: "The retry" }), "text")).toMatchObject({ phase: "working", sentence: "Writing the reply" });
  });

  test("the newest durable tool step names the work; a reasoning step is Thinking and no tool call", () => {
    expect(status(turn({ steps: [bash(0, "bun test", "call-1")] }))).toMatchObject({ phase: "working", sentence: "bun test", toolCalls: 1 });
    const reasoning = step(1, "task", "Considering the layout", { tool: "reasoning" }, "reasoning");
    expect(status(turn({ steps: [bash(0, "ls", "call-1"), reasoning] }))).toMatchObject({ phase: "thinking", toolCalls: 1 });
  });

  test("delta-only: live text is writing, live reasoning is thinking, nothing yet is starting up", () => {
    expect(status(turn({ liveText: "The fix" })).sentence).toBe("Writing the reply");
    expect(status(turn({ liveReasoning: "hmm" })).phase).toBe("thinking");
    expect(status(turn())).toMatchObject({ phase: "working", sentence: "Starting up" });
  });
});

describe("live growth: which channel spoke last", () => {
  const growth = (prev: typeof NO_GROWTH, t: RunningTurn, runId = "run-1") =>
    advanceLiveGrowth(prev, runId, t, deriveRunningWork(t).watermark);

  test("text beats reasoning in one batch, root activity hands the word back, replays are idempotent", () => {
    const first = growth(NO_GROWTH, turn({ liveText: "a", liveReasoning: "r" }));
    expect(first.latest).toBe("text");
    const reasoning = growth(first, turn({ liveText: "a", liveReasoning: "rr" }));
    expect(reasoning.latest).toBe("reasoning");
    const closed = turn({ liveText: "a", liveReasoning: "rr", frames: [frame(1, "t3.activity.tool.completed", { callId: "c" })] });
    const framed = growth(reasoning, closed);
    expect(framed.latest).toBeNull();
    expect(growth(framed, closed)).toEqual(framed);
    // A new run starts its own record.
    expect(growth(framed, turn({ liveText: "z" }), "run-2").latest).toBe("text");
  });

  test("frames the reader ignores never move the watermark: a context-window update keeps Writing", () => {
    const writing = growth(NO_GROWTH, turn({ liveText: "The fix", frames: [frame(1, "part.text")] }));
    expect(writing.latest).toBe("text");
    const ignored = turn({
      liveText: "The fix",
      frames: [
        frame(1, "part.text"),
        frame(2, "part.step-finish", {}, { tokens: { total: 9 } }),
        frame(3, "part.text", { sessionId: "ses_child", parentSessionId: "ses_root" }),
        frame(4, "t3.activity.task.progress", { callId: "agent-a" }, { payload: { taskId: "agent-a", agentKind: "agent" } }),
      ],
    });
    expect(deriveRunningWork(ignored).watermark).toBe(1);
    const after = growth(writing, ignored);
    expect(after.latest).toBe("text");
    expect(deriveRunningStatus(ignored, deriveRunningWork(ignored), after.latest).sentence).toBe("Writing the reply");
  });

  test("a store replaced under the same run id restarts the baseline: fresh reasoning after old text is Thinking", () => {
    const stale = { runId: "run-1", text: 6, reasoning: 10, cursor: 12, latest: "text" as const };
    const fresh = growth(stale, turn({ liveReasoning: "fresh", frames: [frame(4, "part.reasoning")] }));
    expect(fresh.latest).toBe("reasoning");
    expect(fresh).toMatchObject({ text: 0, reasoning: 5, cursor: 4 });
  });
});

describe("the status is a selection over the memoized work", () => {
  test("a text delta never reads the frame or step history again", () => {
    const t = turn({ steps: [bash(0, "ls", "call-1")], frames: [frame(1, "part.tool.completed", { callId: "call-1" })] });
    const work = deriveRunningWork(t);
    const untouchable = <T extends object>(what: string): T =>
      new Proxy({} as T, {
        get() {
          throw new Error(`${what} must not be read while selecting the status`);
        },
      });
    const delta: RunningTurn = {
      steps: untouchable("steps"),
      liveText: "The answer so far",
      liveReasoning: "",
      executionSummary: null,
      native: { nativeFrames: untouchable("frames") },
    };
    expect(deriveRunningStatus(delta, work, "text").sentence).toBe("Writing the reply");
    expect(deriveRunningStatus(delta, { ...work, openTool: "ls" }, "text").sentence).toBe("ls");
  });
});

describe("delegation across the three child kinds", () => {
  test("a queued gateway child neither runs nor delegates; a running one does; settled ones are done", () => {
    const session = (over: Partial<GatewayChildSession>): GatewayChildSession => ({
      id: "c1", prompt: "Summarize the wiki", engine: "claude", model: "m", status: "queued", summary: null, ...over,
    });
    const queued = status(turn({ liveReasoning: "x" }), null, [session({}), session({ id: "c2", status: "completed", summary: "Done." })]);
    expect(queued).toMatchObject({ phase: "thinking", agentsRunning: 0, agentsDone: 1 });
    const running = status(turn(), null, [session({ status: "running" })]);
    expect(running).toMatchObject({ label: "Delegating Summarize the wiki", sentence: "Running", agentsRunning: 1 });
  });

  test("a bot thread delegates under the bot's name; a finished product child is done", () => {
    const child = (over: Partial<ThreadRelationship>): ThreadRelationship => ({
      threadId: "t1",
      parentThreadId: "root",
      familyThreadId: "root",
      kind: "delegated",
      title: "Research prices",
      sourceRunId: "run-1",
      sourceExecutionId: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      status: "running",
      engine: "codex",
      model: "m",
      latestRunId: "t1",
      latestSummary: null,
      latestDurationMs: null,
      latestActivityAt: "2026-09-01T00:01:00.000Z",
      bot: null,
      followUpRunIds: [],
      ...over,
    });
    const bot = { id: "b", name: "Scout", handle: "scout" } as unknown as ThreadRelationship["bot"];
    expect(status(turn(), null, [], [child({ bot })]).label).toBe("Delegating Scout");
    const done = status(turn({ liveReasoning: "x" }), null, [], [child({ status: "completed", latestSummary: "ok" })]);
    expect(done).toMatchObject({ phase: "thinking", agentsDone: 1 });
    expect(status(turn(), null, [], [child({ status: "queued" })])).toMatchObject({ phase: "working", agentsRunning: 0, agentsDone: 0 });
  });

  test("a live native child without a status frame is running, named by its objective", () => {
    const spawn = step(0, "task", "Subagent: Verify checkout", { tool: "task", input: { description: "Verify checkout", prompt: "go" }, native: { sessionID: "ses_root", callID: "call-spawn" } }, "subagent");
    expect(status(turn({ steps: [spawn] }))).toMatchObject({ phase: "delegating", label: "Delegating Verify checkout", agentsRunning: 1 });
  });
});
