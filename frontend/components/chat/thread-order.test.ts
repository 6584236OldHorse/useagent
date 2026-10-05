import { describe, expect, test } from "bun:test";
import { replyRunBody } from "./reply-run-body";
import { compareThreadOrder } from "./thread-order";
import { createThreadStore } from "./thread-store";
import type { ApiRun, PermissionMode } from "./types";

function run(id: string, opts: { createdAt: string; threadSeq?: number; permissionMode?: PermissionMode }): ApiRun {
  return {
    id,
    org_id: "org-1",
    user_id: null,
    prompt: `prompt ${id}`,
    model: "claude-sonnet-5",
    engine: "opencode",
    status: "completed",
    summary: "Done.",
    duration_ms: null,
    parent_run_id: null,
    child_session: false,
    thread_id: "thread-1",
    ...(opts.threadSeq === undefined ? {} : { thread_seq: opts.threadSeq }),
    engine_session_id: null,
    sandbox_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    ...(opts.permissionMode ? { permission_mode: opts.permissionMode } : {}),
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: opts.createdAt,
    updated_at: opts.createdAt,
    steps: [],
  };
}

describe("thread order", () => {
  test("the run's place in its thread decides; time and id only break ties among unsequenced rows", () => {
    const early = run("b", { createdAt: "2026-09-14T09:00:00.123Z", threadSeq: 1 });
    const late = run("a", { createdAt: "2026-09-14T09:00:00.123Z", threadSeq: 2 });
    expect(compareThreadOrder(early, late)).toBeLessThan(0);
    expect(compareThreadOrder(late, early)).toBeGreaterThan(0);
    // Rows from before the sequence (0 or absent) sort by time, before every sequenced run.
    const legacyOld = run("z", { createdAt: "2026-09-14T08:00:00.000Z" });
    const legacyNew = run("y", { createdAt: "2026-09-14T08:30:00.000Z", threadSeq: 0 });
    expect(compareThreadOrder(legacyOld, legacyNew)).toBeLessThan(0);
    expect(compareThreadOrder(legacyNew, early)).toBeLessThan(0);
    expect(compareThreadOrder(early, early)).toBe(0);
  });

  test("two replies accepted in the same millisecond keep acceptance order in the store, so the composer inherits the narrower, later one", () => {
    // Accepted at .123100 (full access, higher id) then .123900 (read only, lower id):
    // on the wire both read .123, and the id alone would put the wider reply last.
    const wider = run("b-later-id", { createdAt: "2026-09-14T09:00:00.123Z", threadSeq: 2, permissionMode: "full-access" });
    const narrower = run("a-earlier-id", { createdAt: "2026-09-14T09:00:00.123Z", threadSeq: 3, permissionMode: "read-only" });
    const root = run("0-root", { createdAt: "2026-09-14T08:59:00.000Z", threadSeq: 1, permissionMode: "full-access" });
    const store = createThreadStore();
    store.upsertRun(root);
    store.upsertRun(narrower); // arrives first over the stream
    store.upsertRun(wider);
    const runs = store.getSnapshot().runs;
    expect(runs.map((r) => r.id)).toEqual(["0-root", "b-later-id", "a-earlier-id"]);
    const newest = runs.at(-1)!;
    expect(newest.permission_mode).toBe("read-only");
    // What the composer sends for the next reply, inheriting from that newest run.
    const body = replyRunBody({
      text: "and now?",
      engine: "opencode",
      model: null,
      parentRunId: newest.id,
      memoryScope: "org",
      attachmentIds: [],
      resources: [],
      botMentions: [],
      engineSessionId: null,
      commandCatalogRevision: null,
      permissionMode: newest.permission_mode,
    });
    expect(body.permission_mode).toBe("read-only");
    expect(body.parent_run_id).toBe("a-earlier-id");
  });
});
