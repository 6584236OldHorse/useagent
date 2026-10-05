import { describe, expect, test } from "bun:test";
import type { ThreadRelationship } from "@useagent/agent-client";
import type { GatewayChildSession } from "@/components/chat/gateway-children";
import type { NativeFrame } from "@/components/chat/native-events";
import type { ApiStep, StepKind } from "@/components/chat/types";
import { deriveRunningStatus, NEXT_STEP } from "./running-phase";

type Ids = Partial<NativeFrame["native"]>;
function frame(seq: number, eventType: string, ids: Ids = {}, payload: unknown = { text: "x" }): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: `ev-${seq}`,
    seq,
    provider: "opencode",
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

function turn(over: { steps?: ApiStep[]; frames?: NativeFrame[]; liveText?: string; liveReasoning?: string } = {}) {
  return {
    steps: over.steps ?? [],
    liveText: over.liveText ?? "",
    liveReasoning: over.liveReasoning ?? "",
    executionSummary: null,
    native: over.frames ? { nativeFrames: over.frames } : undefined,
  };
}

describe("running phase from native part frames (every bridge emits the same grammar)", () => {
  test("only reasoning streamed: Thinking", () => {
    const status = deriveRunningStatus(turn({ frames: [frame(1, "part.step-start"), frame(2, "part.reasoning")] }));
    expect(status.phase).toBe("thinking");
    expect(status.label).toBe("Thinking");
    expect(status.sentence).toBe(NEXT_STEP);
    expect(status.toolCalls).toBe(0);
  });

  test("a tool is the newest activity: Working with the tool's plain label", () => {
    const steps = [bash(0, "bun run typecheck", "call-1"), bash(1, "git status", "call-2")];
    const status = deriveRunningStatus(
      turn({ steps, frames: [frame(1, "part.reasoning"), frame(2, "part.tool", { callId: "call-2" })] }),
    );
    expect(status.phase).toBe("working");
    expect(status.label).toBe("Working");
    expect(status.sentence).toBe("git status");
    expect(status.toolCalls).toBe(2);
  });

  test("reasoning after the tools flips back to Thinking; answer text reads as writing", () => {
    const steps = [bash(0, "ls", "call-1")];
    const thinking = deriveRunningStatus(
      turn({ steps, frames: [frame(1, "part.tool.completed", { callId: "call-1" }), frame(2, "part.reasoning")] }),
    );
    expect(thinking.phase).toBe("thinking");
    const writing = deriveRunningStatus(turn({ steps, frames: [frame(1, "part.tool.completed", { callId: "call-1" }), frame(2, "part.text")] }));
    expect(writing.phase).toBe("working");
    expect(writing.sentence).toBe("Writing the reply");
  });

  test("a subagent's own frames never speak for the parent", () => {
    const status = deriveRunningStatus(
      turn({
        frames: [
          frame(1, "part.reasoning"),
          frame(2, "part.text", { sessionId: "ses_child", parentSessionId: "ses_root" }),
        ],
      }),
    );
    expect(status.phase).toBe("thinking");
  });
});

describe("running phase without frames (durable steps, then the delta channel)", () => {
  test("the newest durable tool step names the work", () => {
    const status = deriveRunningStatus(turn({ steps: [bash(0, "bun test", "call-1")] }));
    expect(status).toMatchObject({ phase: "working", sentence: "bun test", toolCalls: 1 });
  });

  test("a reasoning step is Thinking and does not count as a tool call", () => {
    const status = deriveRunningStatus(
      turn({ steps: [bash(0, "ls", "call-1"), step(1, "task", "Considering the layout", { tool: "reasoning" }, "reasoning")] }),
    );
    expect(status).toMatchObject({ phase: "thinking", toolCalls: 1 });
  });

  test("delta-only engines: live text is writing, live reasoning is thinking, nothing yet is starting up", () => {
    expect(deriveRunningStatus(turn({ liveText: "The fix" })).sentence).toBe("Writing the reply");
    expect(deriveRunningStatus(turn({ liveReasoning: "hmm" })).phase).toBe("thinking");
    expect(deriveRunningStatus(turn())).toMatchObject({ phase: "working", sentence: "Starting up" });
  });
});

describe("delegation", () => {
  const spawn = (idx: number, description: string, callID: string) =>
    step(idx, "task", `Subagent — ${description}`, { tool: "task", input: { description, prompt: "go" }, native: { sessionID: "ses_root", callID } }, "subagent");

  test("a live native child without a status frame is running, named by its objective", () => {
    const status = deriveRunningStatus(turn({ steps: [spawn(0, "Verify checkout", "call-spawn")] }));
    expect(status.phase).toBe("delegating");
    expect(status.label).toBe("Delegating Verify checkout");
    expect(status.agentsRunning).toBe(1);
    expect(status.agentsDone).toBe(0);
  });

  test("a queued gateway child session delegates; settled children count as done", () => {
    const sessions: GatewayChildSession[] = [
      { id: "c1", prompt: "Summarize the wiki", engine: "claude", model: "m", status: "queued", summary: null },
      { id: "c2", prompt: "Old one", engine: "claude", model: "m", status: "completed", summary: "Done." },
    ];
    const status = deriveRunningStatus(turn(), sessions);
    expect(status.label).toBe("Delegating Summarize the wiki");
    expect(status.sentence).toBe("Queued");
    expect(status.agentsRunning).toBe(1);
    expect(status.agentsDone).toBe(1);
  });

  test("a bot thread delegates under the bot's name; a finished product child is done, not delegating", () => {
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
    const running = deriveRunningStatus(turn(), [], [child({ bot })]);
    expect(running.label).toBe("Delegating Scout");
    const done = deriveRunningStatus(turn({ liveReasoning: "x" }), [], [child({ status: "completed", latestSummary: "ok" })]);
    expect(done.phase).toBe("thinking");
    expect(done.agentsDone).toBe(1);
  });
});
