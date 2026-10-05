// Pure-logic tests for the thread-stream hook's testable seams (Codex findings 2 & 4).
// The React wiring (adjust-state-on-prop-change, the effect's connection lifecycle)
// is covered by thread-connection.test.ts + the browser proof; these lock the two
// pure decisions the hook is built on.

import { nativeHoldDigest } from "@useagent/agent-client";
import { beforeEach, describe, expect, test } from "bun:test";
import { NATIVE_SCHEMA_VERSION } from "./native-events";
import { createThreadStore } from "./thread-store";
import type { ApiRun, RunStatus } from "./types";
import {
  acquireThreadStore,
  claimThreadStore,
  releaseThreadStore,
  resetRetainedThreadStoresForTest,
  resumeCursor,
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
  test("a released store is acquired back for the same root, merged with the new SSR payload", () => {
    const first = acquireThreadStore("A", [makeRun("A")]);
    releaseThreadStore("A", first);
    const again = acquireThreadStore("A", [makeRun("A"), makeRun("B", "queued", "A")]);
    expect(again).toBe(first);
    expect(again.getSnapshot().runs.map((r) => r.id)).toEqual(["A", "B"]);
  });

  test("a store has one owner: acquiring takes it out of retention, a second view gets its own", () => {
    const first = acquireThreadStore("A", [makeRun("A")]);
    releaseThreadStore("A", first);
    const owner = acquireThreadStore("A", []);
    const sibling = acquireThreadStore("A", []);
    expect(owner).toBe(first);
    expect(sibling).not.toBe(first);
  });

  test("claiming takes back this exact store when a teardown released it under the same mount", () => {
    const store = acquireThreadStore("A", [makeRun("A")]);
    releaseThreadStore("A", store);
    claimThreadStore("A", store);
    expect(acquireThreadStore("A", [])).not.toBe(store);
  });

  test("retention is bounded to the last four released, oldest release first", () => {
    const stores = ["A", "B", "C", "D", "E"].map((id) => {
      const s = acquireThreadStore(id, [makeRun(id)]);
      releaseThreadStore(id, s);
      return s;
    });
    expect(acquireThreadStore("A", [])).not.toBe(stores[0]);
    expect(acquireThreadStore("B", [])).toBe(stores[1]);
  });

  test("seedThreadStore never retains: the server-render path keeps nothing between requests", () => {
    const first = seedThreadStore("A", [makeRun("A")]);
    expect(seedThreadStore("A", [makeRun("A")])).not.toBe(first);
    expect(acquireThreadStore("A", []).getSnapshot().runs.length).toBe(0);
  });
});

describe("resume cursor (what the store already holds)", () => {
  test("an empty store carries no cursor and the plain stream URL", () => {
    const store = createThreadStore();
    const cursor = resumeCursor(store.getSnapshot());
    expect(cursor).toEqual({ canonicalAfter: 0, canonicalId: null, nativeAfter: new Map() });
    expect(threadEventsUrl("A", cursor, "boot-1")).toBe("/api/runs/A/thread-events");
  });

  test("the newest canonical delivery seq with its event id, sent only with the epoch that delivered it", () => {
    const store = createThreadStore();
    store.applySnapshot([makeRun("A"), makeRun("B", "completed", "A")]);
    for (const [runId, deliverySeq] of [["A", 10], ["B", 12], ["A", 11]] as const) {
      store.applyCanonical({
        schemaVersion: 1, kind: "message.delta", eventId: `${runId}-${deliverySeq}`, runId, threadId: "A", seq: deliverySeq,
        ts: 0, deliverySeq, revision: 0, identity: {}, text: "x",
      } as never);
    }
    const cursor = resumeCursor(store.getSnapshot());
    expect(cursor).toEqual({ canonicalAfter: 12, canonicalId: "B-12", nativeAfter: new Map() });
    expect(threadEventsUrl("A", cursor, "boot-1")).toBe("/api/runs/A/thread-events?epoch=boot-1&canonicalAfter=12&canonicalId=B-12");
    expect(threadEventsUrl("A", cursor, null)).toBe("/api/runs/A/thread-events");
  });

  test("a sealed run's newest native seq travels as its cursor; a live run's never does", () => {
    const store = createThreadStore();
    store.applySnapshot([makeRun("A", "completed"), makeRun("B", "running", "A")]);
    const frame = (runId: string, seq: number) => ({
      schemaVersion: NATIVE_SCHEMA_VERSION, eventId: `${runId}-n${seq}`, seq, provider: "opencode", eventType: "part.text",
      native: { sessionId: "ses", parentSessionId: null, messageId: `${runId}-m`, partId: `${runId}-p${seq}`, callId: null },
      payload: { text: "x" },
    });
    for (const seq of [0, 1, 2]) store.applyNative("A", frame("A", seq));
    store.applyNative("B", frame("B", 0));
    // Nothing sealed yet: no native cursor for either run, so the URL carries no cursor.
    expect(resumeCursor(store.getSnapshot()).nativeAfter).toEqual(new Map());
    expect(threadEventsUrl("A", resumeCursor(store.getSnapshot()), "boot-1")).toBe("/api/runs/A/thread-events");
    store.markCanonicalComplete("A");
    const cursor = resumeCursor(store.getSnapshot());
    // The digest of the held (eventId, seq) pairs travels with the cursor.
    const digest = nativeHoldDigest([0, 1, 2].map((seq) => ({ eventId: `A-n${seq}`, seq })));
    expect(cursor.nativeAfter).toEqual(new Map([["A", { seq: 2, digest }]]));
    expect(threadEventsUrl("A", cursor, "boot-1")).toBe(`/api/runs/A/thread-events?epoch=boot-1&nativeAfter=A%3A2%3A${digest}`);
    // Without the epoch that minted the store's rows, no cursor of either lane is sent.
    expect(threadEventsUrl("A", cursor, null)).toBe("/api/runs/A/thread-events");
  });
});

describe("a thread store only takes runs of its own thread", () => {
  test("a late response for another thread is dropped, a run without a thread id is kept", () => {
    const store = createThreadStore({ rootThreadId: "B" });
    store.applySnapshot([{ ...makeRun("B"), thread_id: "B" } as ApiRun, { ...makeRun("A"), thread_id: "A" } as ApiRun, makeRun("B2", "queued", "B")]);
    expect(store.getSnapshot().runs.map((r) => r.id)).toEqual(["B", "B2"]);
    store.upsertRun({ ...makeRun("A2"), thread_id: "A" } as ApiRun);
    expect(store.getSnapshot().byId.has("A2")).toBe(false);
  });
});
