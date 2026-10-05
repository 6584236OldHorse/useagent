import { describe, expect, test } from "bun:test";
import { json } from "./helpers";

// Permission mode at the run-creation boundary (POST /api/runs): the default,
// explicit selection, validation, reply inheritance and override. Runs use the
// default `mock` engine so they need no sandbox; only the persisted
// `permission_mode` is asserted (it is set on the queued row).

async function createRun(body: Record<string, unknown>) {
  return json<{ id: string; error?: string }>("/api/runs", { method: "POST", body });
}
async function getMode(id: string): Promise<string> {
  const { body } = await json<{ permission_mode: string }>(`/api/runs/${id}`);
  return body.permission_mode;
}

describe("permission mode at the run creation boundary", () => {
  test("a root run without a choice takes the operator posture, full access by default", async () => {
    const { status, body } = await createRun({ prompt: "hello" });
    expect(status).toBe(201);
    expect(await getMode(body.id)).toBe("full-access");
  });

  test("an explicit mode persists on a root run and is reported on every read", async () => {
    const { status, body } = await createRun({ prompt: "hello", permission_mode: "read-only" });
    expect(status).toBe(201);
    expect(await getMode(body.id)).toBe("read-only");
    const { body: threaded } = await json<{ thread: Array<{ id: string; permission_mode: string }> }>(
      `/api/runs/${body.id}?thread=1`,
    );
    expect(threaded.thread.map((run) => run.permission_mode)).toEqual(["read-only"]);
  });

  test("an unknown mode is rejected 400, never a silent fallback", async () => {
    const { status, body } = await createRun({ prompt: "hello", permission_mode: "yolo" });
    expect(status).toBe(400);
    expect(String(body.error)).toContain("permission_mode");
  });

  test("a reply inherits its parent's mode when none is given", async () => {
    const root = await createRun({ prompt: "root", permission_mode: "approval-required" });
    expect(root.status).toBe(201);
    const reply = await createRun({ prompt: "reply", parent_run_id: root.body.id });
    expect(reply.status).toBe(201);
    expect(await getMode(reply.body.id)).toBe("approval-required");
  });

  test("a reply can change the mode when the person explicitly picks one", async () => {
    const root = await createRun({ prompt: "root", permission_mode: "read-only" });
    expect(await getMode(root.body.id)).toBe("read-only");
    const reply = await createRun({
      prompt: "reply",
      parent_run_id: root.body.id,
      permission_mode: "auto-accept-edits",
    });
    expect(reply.status).toBe(201);
    expect(await getMode(reply.body.id)).toBe("auto-accept-edits");
  });

  test("the same key with a different mode is a payload mismatch, not a replay", async () => {
    const headers = { "Idempotency-Key": `perm-${crypto.randomUUID()}` };
    const first = await json<{ id: string }>("/api/runs", {
      method: "POST",
      headers,
      body: { prompt: "same words", permission_mode: "read-only" },
    });
    expect(first.status).toBe(201);
    const replay = await json<{ id: string }>("/api/runs", {
      method: "POST",
      headers,
      body: { prompt: "same words", permission_mode: "read-only" },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    const changed = await json<{ error: string }>("/api/runs", {
      method: "POST",
      headers,
      body: { prompt: "same words", permission_mode: "full-access" },
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe("idempotency_key_reused");
  });
});
