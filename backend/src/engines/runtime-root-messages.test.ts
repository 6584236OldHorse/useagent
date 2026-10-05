import { expect, test } from "bun:test";
import { appendOnlyMessageCapture, runtimeRootMessageBatches } from "./runtime-root-messages";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

const snapshot = (text = "Waiting for approval."): RuntimeThreadSnapshot => ({
  snapshotSequence: 1,
  thread: {
    id: "session",
    latestTurn: { turnId: "owned", state: "running", assistantMessageId: "reply" },
    messages: [
      { id: "old-user", role: "user", text: "old", turnId: "old", streaming: false },
      { id: "old-reply", role: "assistant", text: "OLD", turnId: "old", streaming: false },
      { id: "accepted", role: "user", text: "new", turnId: "owned", streaming: false },
      { id: "progress", role: "assistant", text, turnId: "owned", streaming: false },
      { id: "reply", role: "assistant", text: "Final answer", turnId: "owned", streaming: true },
    ], activities: [], session: null,
  },
});
const input = { runId: "run", threadId: "thread", sessionId: "session", userMessageIds: ["accepted"], redact: (text: string) => text.replaceAll("SECRET", "[redacted]") };

test("captures every owned root assistant message, not old/user messages", () => {
  const batches = runtimeRootMessageBatches(input, snapshot());
  expect(batches.map((batch) => batch[0]!.nativeMessageId)).toEqual(["progress", "reply"]);
  expect(batches[0]![1]!.payload).toMatchObject({ text: "Waiting for approval.", final: false, role: "assistant", turnId: "owned" });
});

test("redacts before hashing and splits large escaped Unicode below durable caps", () => {
  const text = "SECRET\n\u0000😀".repeat(8000);
  const frames = runtimeRootMessageBatches(input, snapshot(text))[0]!.slice(1);
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.map((frame) => (frame.payload as { text: string }).text).join("")).toBe(input.redact(text));
  for (const frame of frames) {
    expect(new TextEncoder().encode(JSON.stringify(frame.payload)).length).toBeLessThan(32768);
    expect(JSON.stringify(frame.payload)).not.toContain("SECRET");
  }
});

test("shortened and empty authoritative snapshots retain stable IDs with a new revision", () => {
  const before = runtimeRootMessageBatches(input, snapshot("long".repeat(3000)))[0]!;
  const after = runtimeRootMessageBatches(input, snapshot(""))[0]!;
  expect(after).toHaveLength(2);
  expect(after[0]!.id).toBe(before[0]!.id);
  expect(after[1]!.id).toBe(before[1]!.id);
  expect(after[1]!.payload).toMatchObject({ text: "", segment: 0, segmentCount: 1 });
  expect((after[1]!.payload as {revision:string}).revision).not.toBe((before[1]!.payload as {revision:string}).revision);
});

test("marks only the settled owned final reply, preserves continuation commentary", () => {
  const value = snapshot();
  const settled = { ...value, thread: { ...value.thread,
    latestTurn: { ...value.thread.latestTurn!, state: "completed" as const },
    messages: value.thread.messages.map((message) => ({ ...message, streaming: false })),
  } };
  const batches = runtimeRootMessageBatches(input, settled);
  expect(batches.map((batch) => (batch[1]!.payload as {final:boolean}).final)).toEqual([false, true]);
  expect(runtimeRootMessageBatches({ ...input, userMessageIds: [] }, settled)).toEqual([]);
});

test("ordered historical null-turn users retain original and continuation narration only", () => {
  const value = snapshot();
  const messages = [
    { id: "accepted", role: "user" as const, turnId: null, text: "original", streaming: false },
    { id: "a", role: "assistant" as const, turnId: "a", text: "original commentary", streaming: false },
    { id: "continuation", role: "user" as const, turnId: null, text: "continue", streaming: false },
    { id: "b", role: "assistant" as const, turnId: "b", text: "final", streaming: false },
    { id: "misordered-foreign", role: "assistant" as const, turnId: "foreign-turn", text: "not ours", streaming: false },
    { id: "foreign-explicit", role: "user" as const, turnId: "foreign-turn", text: "other run", streaming: false },
    { id: "foreign", role: "user" as const, turnId: null, text: "other run", streaming: false },
    { id: "c", role: "assistant" as const, turnId: "c", text: "must not leak", streaming: false },
  ];
  const batches = runtimeRootMessageBatches({ ...input, userMessageIds: ["accepted", "continuation"] }, {
    ...value, thread: { ...value.thread, messages, latestTurn: { turnId: "b", state: "completed", assistantMessageId: "b" } },
  });
  expect(batches.map((batch) => batch[0]!.nativeMessageId)).toEqual(["a", "b"]);
  expect(batches.map((batch) => (batch[1]!.payload as {final:boolean}).final)).toEqual([false, true]);
});

test("streaming append writes only changed tail chunks, while rewrite resets the epoch", () => {
  const first = runtimeRootMessageBatches(input, snapshot("x".repeat(30_000)))[0]!;
  const extended = runtimeRootMessageBatches(input, snapshot("x".repeat(30_000) + "more"))[0]!;
  const appended = appendOnlyMessageCapture(extended, first);
  expect(appended.events).toHaveLength(1);
  expect((appended.events[0]!.payload as {revision:string}).revision).toBe((first[1]!.payload as {revision:string}).revision);
  expect(appendOnlyMessageCapture(extended, appended.snapshot).events).toEqual([]);
  const rewritten = appendOnlyMessageCapture(runtimeRootMessageBatches(input, snapshot("short"))[0]!, appended.snapshot);
  expect(rewritten.events).toHaveLength(1);
  expect((rewritten.events[0]!.payload as {revision:string}).revision).not.toBe((appended.events[0]!.payload as {revision:string}).revision);
  // A caller that did not commit must retry the same tail, not advance its cache.
  expect(appendOnlyMessageCapture(extended, first).events).toEqual(appended.events);
});

test("metadata-only finalization updates the tail and a multi-chunk rewrite replaces every segment", () => {
  const first = runtimeRootMessageBatches(input, snapshot("a".repeat(12_000)))[0]!;
  const changed = runtimeRootMessageBatches(input, snapshot("b".repeat(12_000)))[0]!;
  const rewrite = appendOnlyMessageCapture(changed, first);
  expect(rewrite.events).toHaveLength(changed.length - 1);
  const finalized = changed.map((event, index) => index === 0 ? event : {
    ...event, payload: { ...event.payload as object, final: true, streaming: false },
  });
  const final = appendOnlyMessageCapture(finalized, changed);
  expect(final.events).toHaveLength(1);
  expect(final.events[0]!.id).toBe(changed.at(-1)!.id);
  expect(final.events[0]!.payload).toMatchObject({ final: true, streaming: false });
});
