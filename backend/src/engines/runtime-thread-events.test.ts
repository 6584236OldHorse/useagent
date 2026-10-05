import { describe, expect, test } from "bun:test";
import type { RuntimeActivity, RuntimeThreadSnapshot } from "./runtime-orchestration";
import { applyRuntimeThreadEvent, type RuntimeThreadEvent } from "./runtime-thread-events";

const AT = "2026-10-02T10:00:00.000Z";

function thread(overrides: Partial<RuntimeThreadSnapshot["thread"]> = {}, sequence = 10): RuntimeThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: "skynet-thread-1",
      latestTurn: { turnId: "turn-1", state: "running", requestedAt: AT, startedAt: AT, completedAt: null, assistantMessageId: null },
      messages: [],
      activities: [],
      session: { status: "running", lastError: null, activeTurnId: "turn-1" } as RuntimeThreadSnapshot["thread"]["session"],
      ...overrides,
    },
  };
}

const message = (sequence: number, fields: Record<string, unknown>): RuntimeThreadEvent => ({
  sequence,
  type: "thread.message-sent",
  payload: {
    threadId: "skynet-thread-1", messageId: "msg-1", role: "assistant", text: "", turnId: "turn-1",
    streaming: true, createdAt: AT, updatedAt: AT, ...fields,
  },
});

const activity = (sequence: number, value: Partial<RuntimeActivity> & { id: string }): RuntimeThreadEvent => ({
  sequence,
  type: "thread.activity-appended",
  payload: {
    threadId: "skynet-thread-1",
    activity: { tone: "tool", kind: "tool.started", summary: "Run started", payload: {}, turnId: "turn-1", ...value },
  },
});

describe("runtime thread events", () => {
  test("streamed text appends, a final text replaces it, and an empty final keeps it", () => {
    let state = thread();
    state = applyRuntimeThreadEvent(state, message(11, { text: "Hel" }))!;
    state = applyRuntimeThreadEvent(state, message(12, { text: "lo" }))!;
    expect(state.snapshotSequence).toBe(12);
    expect(state.thread.messages).toMatchObject([{ id: "msg-1", text: "Hello", streaming: true }]);
    expect(state.thread.latestTurn?.assistantMessageId).toBe("msg-1");
    // The session is still running the turn, so a final message does not settle it.
    const final = applyRuntimeThreadEvent(state, message(13, { text: "", streaming: false }))!;
    expect(final.thread.messages).toMatchObject([{ text: "Hello", streaming: false }]);
    expect(final.thread.latestTurn?.state).toBe("running");
    expect(applyRuntimeThreadEvent(state, message(13, { text: "Hi", streaming: false }))!.thread.messages[0]!.text).toBe("Hi");
  });

  test("a final message that would settle the turn is left to a full snapshot", () => {
    const idle = thread({ session: { status: "ready", lastError: null } });
    expect(applyRuntimeThreadEvent(idle, message(11, { text: "done", streaming: false }))).toBeNull();
    // Another turn's message does not move the latest turn, so it applies.
    const other = applyRuntimeThreadEvent(idle, message(11, { text: "old", streaming: false, turnId: "turn-0" }))!;
    expect(other.thread.latestTurn).toBe(idle.thread.latestTurn);
    expect(other.thread.messages).toMatchObject([{ text: "old", turnId: "turn-0" }]);
  });

  test("messages keep the runtime's created-time order", () => {
    let state = thread();
    state = applyRuntimeThreadEvent(state, message(11, { messageId: "msg-b", text: "b", createdAt: "2026-10-02T10:00:02.000Z" }))!;
    state = applyRuntimeThreadEvent(state, message(12, { messageId: "msg-a", role: "user", text: "a", turnId: null, streaming: false, createdAt: "2026-10-02T10:00:01.000Z" }))!;
    expect(state.thread.messages.map(({ id }) => id)).toEqual(["msg-a", "msg-b"]);
  });

  test("activities upsert by id in sequence order", () => {
    let state = thread({ activities: [{ id: "a-2", tone: "info", kind: "task.progress", summary: "x", payload: {}, turnId: "turn-1", sequence: 2 }] });
    state = applyRuntimeThreadEvent(state, activity(11, { id: "a-1", sequence: 1 }))!;
    state = applyRuntimeThreadEvent(state, activity(12, { id: "a-3", sequence: 3 }))!;
    state = applyRuntimeThreadEvent(state, activity(13, { id: "a-2", kind: "task.progress", summary: "y", sequence: 4 }))!;
    expect(state.thread.activities.map(({ id, summary }) => `${id}:${summary}`)).toEqual(["a-1:Run started", "a-3:Run started", "a-2:y"]);
  });

  test("a gap, a session change and an unknown event need a full snapshot; a coalesced tool update does not", () => {
    const state = thread();
    expect(applyRuntimeThreadEvent(state, activity(12, { id: "a-1" }))).toBeNull();
    expect(applyRuntimeThreadEvent(state, activity(13, { id: "a-1", kind: "tool.updated" }))?.snapshotSequence).toBe(13);
    expect(applyRuntimeThreadEvent(state, { sequence: 11, type: "thread.session-set", payload: { session: {} } })).toBeNull();
    expect(applyRuntimeThreadEvent(state, { sequence: 11, type: "thread.turn-diff-completed", payload: {} })).toBeNull();
    expect(applyRuntimeThreadEvent(state, { sequence: 11 })).toBeNull();
    expect(applyRuntimeThreadEvent(state, message(11, { text: 42 }))).toBeNull();
  });
});
