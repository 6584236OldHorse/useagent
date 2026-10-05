// Pure-logic tests for the thread-stream hook's testable seams (Codex findings 2 & 4).
// The React wiring (adjust-state-on-prop-change, the effect's connection lifecycle)
// is covered by thread-connection.test.ts + the browser proof; these lock the two
// pure decisions the hook is built on.

import { beforeEach, describe, expect, test } from "bun:test";
import { createThreadStore } from "./thread-store";
import type { ApiRun, RunStatus } from "./types";
import {
  freshThreadStore,
  resetRetainedThreadStoresForTest,
  resumeCursors,
  seedThreadStore,
  shouldRetireOptimistic,
  threadEventsUrl,
} from "./use-thread-stream";

function makeRun(id: string, status: RunStatus = "running", parent: string | null = null): ApiRun {
  return {
    id, org_id: "org-1", user_id: null, parent_run_id: parent,
    prompt: `p ${id}`, model: "m", engine: "opencode", status, summary: null,
    duration_ms: null, engine_session_id: null, memory_scope: "org",
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(), steps: [],
  };
}

beforeEach(() => resetRetainedThreadStoresForTest());

describe("seedThreadStore (store lifetime keyed by rootRunId)", () => {
  test("seeds from initialThread only when it belongs to this root", () => {
    const s = seedThreadStore("A", [makeRun("A"), makeRun("B", "queued", "A")]);
    expect(s.getSnapshot().runs.map((r) => r.id)).toEqual(["A", "B"]);
  });

  test("does NOT seed a stale SSR payload from a different thread (finding 2)", () => {
    // Navigating A -> B without a remount: the OLD initialThread (thread A) must not
    // bleed into B's fresh store; it stays empty until B's SSE snapshot hydrates it.
    const s = seedThreadStore("B", [makeRun("A"), makeRun("A2", "queued", "A")]);
    expect(s.getSnapshot().runs.length).toBe(0);
  });

  test("empty initial thread yields an empty store", () => {
    expect(seedThreadStore("A", []).getSnapshot().runs.length).toBe(0);
  });
});

describe("shouldRetireOptimistic (keep an accepted reply until its durable run is observed)", () => {
  const snapWith = (...ids: string[]) => {
    const store = createThreadStore();
    for (const id of ids) store.upsertRun(makeRun(id));
    return store.getSnapshot();
  };

  test("null/absent run id never retires the optimistic bubble", () => {
    expect(shouldRetireOptimistic(null, snapWith("A"))).toBe(false);
    expect(shouldRetireOptimistic(undefined, snapWith("A"))).toBe(false);
  });

  test("a run id NOT yet in the store keeps the optimistic bubble (POST ok, SSE/fetch down)", () => {
    expect(shouldRetireOptimistic("B", snapWith("A"))).toBe(false);
  });

  test("retires only once the matching durable run is present (matched by id, not prompt)", () => {
    expect(shouldRetireOptimistic("B", snapWith("A", "B"))).toBe(true);
  });
});

describe("retained stores (return to a thread without replaying it)", () => {
  test("the same root gets the retained store back, merged with the new SSR payload", () => {
    const first = seedThreadStore("A", [makeRun("A")]);
    const again = seedThreadStore("A", [makeRun("A"), makeRun("B", "queued", "A")]);
    expect(again).toBe(first);
    expect(again.getSnapshot().runs.map((r) => r.id)).toEqual(["A", "B"]);
  });

  test("retention is bounded to the last four threads, least recently used first", () => {
    const [a, b] = ["A", "B", "C", "D"].map((id) => seedThreadStore(id, [makeRun(id)]));
    seedThreadStore("A", []); // touch A: B is now the oldest
    seedThreadStore("E", [makeRun("E")]);
    expect(seedThreadStore("A", [])).toBe(a);
    expect(seedThreadStore("B", [])).not.toBe(b);
  });

  test("a fresh store replaces the retained one for its root", () => {
    const kept = seedThreadStore("A", [makeRun("A")]);
    const fresh = freshThreadStore("A");
    expect(fresh).not.toBe(kept);
    expect(fresh.getSnapshot().runs.length).toBe(0);
    expect(seedThreadStore("A", [])).toBe(fresh);
  });
});

describe("resume cursors (what the store already holds)", () => {
  const nativeFrame = (runId: string, seq: number) => ({
    schemaVersion: 1, eventId: `${runId}:e${seq}`, seq, provider: "opencode", eventType: "part.text",
    native: { sessionId: null, parentSessionId: null, messageId: null, partId: `p${seq}`, callId: null }, payload: {},
  });

  test("an empty store carries no cursors and the plain stream URL", () => {
    const store = createThreadStore();
    const cursors = resumeCursors(store.getSnapshot());
    expect(cursors).toEqual({ canonicalAfter: 0, nativeAfter: new Map() });
    expect(threadEventsUrl("A", cursors)).toBe("/api/runs/A/thread-events");
  });

  test("the newest canonical delivery seq and the newest native seq per run", () => {
    const store = createThreadStore();
    store.applySnapshot([makeRun("A"), makeRun("B", "completed", "A")]);
    store.applyNative("A", nativeFrame("A", 0));
    store.applyNative("A", nativeFrame("A", 4));
    store.applyNative("B", nativeFrame("B", 2));
    for (const [runId, deliverySeq] of [["A", 10], ["B", 12], ["A", 11]] as const) {
      store.applyCanonical({
        schemaVersion: 1, kind: "message.delta", eventId: `${runId}-${deliverySeq}`, runId, threadId: "A", seq: deliverySeq,
        ts: 0, deliverySeq, revision: 0, identity: {}, text: "x",
      } as never);
    }
    const cursors = resumeCursors(store.getSnapshot());
    expect(cursors.canonicalAfter).toBe(12);
    expect([...cursors.nativeAfter]).toEqual([["A", 4], ["B", 2]]);
    expect(threadEventsUrl("A", cursors)).toBe("/api/runs/A/thread-events?canonicalAfter=12&nativeAfter=A%3A4%2CB%3A2");
  });
});
