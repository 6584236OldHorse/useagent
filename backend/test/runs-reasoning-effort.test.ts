import { describe, expect, test } from "bun:test";
import { createOrgSession, json, uid } from "./helpers";

// Reasoning effort at the run-creation boundary (POST /api/runs): stored on the
// run, inherited by a reply the way the model is, validated against the engine's
// seam, and part of the keyed intent. Codex runs are accepted in this suite
// (the preload marks the lane proven) and stay queued: only the persisted row
// and the capability manifest are asserted here; the dispatch payload has its
// own unit tests next to the runtime orchestration and the T3 driver.

async function createRun(body: Record<string, unknown>, cookies: string, headers?: Record<string, string>) {
  return json<{ id: string; error?: string; efforts?: string[] }>("/api/runs", {
    method: "POST",
    body,
    cookies,
    ...(headers ? { headers } : {}),
  });
}
async function readEffort(id: string, cookies: string): Promise<string | null> {
  const { body } = await json<{ reasoning_effort: string | null }>(`/api/runs/${id}`, { cookies });
  return body.reasoning_effort;
}

describe("reasoning effort at the run-creation boundary", () => {
  test("a root Codex run stores its effort; a reply inherits it unless it chooses another", async () => {
    const s = await createOrgSession("effort-thread");
    const root = await createRun(
      { prompt: "plan the migration", engine: "codex", model: "gpt-5.6-sol", reasoning_effort: "high" },
      s.cookies,
    );
    expect(root.status, JSON.stringify(root.body)).toBe(201);
    expect(await readEffort(root.body.id, s.cookies)).toBe("high");

    const inherited = await createRun(
      { prompt: "now do it", engine: "codex", parent_run_id: root.body.id },
      s.cookies,
    );
    expect(inherited.status, JSON.stringify(inherited.body)).toBe(201);
    expect(await readEffort(inherited.body.id, s.cookies)).toBe("high");

    const changed = await createRun(
      { prompt: "quick check", engine: "codex", parent_run_id: inherited.body.id, reasoning_effort: "low" },
      s.cookies,
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(201);
    expect(await readEffort(changed.body.id, s.cookies)).toBe("low");
  });

  test("no effort means the runtime's default: the row stays null", async () => {
    const s = await createOrgSession("effort-default");
    const root = await createRun({ prompt: "hello", engine: "codex", model: "gpt-5.6-sol" }, s.cookies);
    expect(root.status).toBe(201);
    expect(await readEffort(root.body.id, s.cookies)).toBeNull();
  });

  test("a level the engine does not offer is a 400 naming the offered levels", async () => {
    const s = await createOrgSession("effort-invalid");
    const bad = await createRun(
      { prompt: "hello", engine: "codex", model: "gpt-5.6-sol", reasoning_effort: "ultra" },
      s.cookies,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("reasoning_effort_invalid");
    expect(bad.body.efforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("an engine without the seam rejects an effort instead of dropping it", async () => {
    const s = await createOrgSession("effort-unsupported");
    const bad = await createRun(
      { prompt: "hello", engine: "opencode", model: "openai/gpt-5.6-luna", reasoning_effort: "high" },
      s.cookies,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("reasoning_effort_not_supported");
  });

  test("the effort is part of the keyed intent: a replay matches, a changed level conflicts", async () => {
    const s = await createOrgSession("effort-idem");
    const key = uid("effort-key");
    const body = { prompt: "keyed", engine: "codex", model: "gpt-5.6-sol", reasoning_effort: "medium" };
    const first = await createRun(body, s.cookies, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    const replay = await createRun(body, s.cookies, { "Idempotency-Key": key });
    expect(replay).toEqual({ status: 200, body: { id: first.body.id } });
    const conflict = await createRun({ ...body, reasoning_effort: "xhigh" }, s.cookies, { "Idempotency-Key": key });
    expect(conflict.status).toBe(409);
  });

  test("a keyed retry that adds a malformed effort is a payload mismatch, never the original run", async () => {
    const s = await createOrgSession("effort-idem-malformed");
    const key = uid("effort-key-malformed");
    const body = { prompt: "keyed without effort", engine: "codex", model: "gpt-5.6-sol" };
    const first = await createRun(body, s.cookies, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    // A number is not omission: it must not fingerprint like the accepted run,
    // so the reused key answers the same 409 any changed payload gets.
    const malformed = await createRun({ ...body, reasoning_effort: 42 }, s.cookies, { "Idempotency-Key": key });
    expect(malformed.status).toBe(409);
    expect(malformed.body.error).toBe("idempotency_key_reused");
    // Unkeyed, the same value is the plain client error.
    const unkeyed = await createRun({ ...body, reasoning_effort: 42 }, s.cookies);
    expect(unkeyed.status).toBe(400);
    expect(unkeyed.body.error).toBe("reasoning_effort_invalid");
  });

  test("the capability manifest advertises the seam per model", async () => {
    const s = await createOrgSession("effort-manifest");
    const { status, body } = await json<{
      engines: { id: string; models: { id: string; supportedReasoningEfforts?: string[]; defaultReasoningEffort?: string }[] }[];
    }>("/api/capabilities", { cookies: s.cookies });
    expect(status).toBe(200);
    const byEngine = Object.fromEntries(body.engines.map((engine) => [engine.id, engine.models]));
    expect(byEngine.codex?.[0]).toMatchObject({
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    });
    expect(byEngine.claude?.[0]).toMatchObject({
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    });
    expect(byEngine.opencode?.every((model) => model.supportedReasoningEfforts === undefined)).toBe(true);
  });
});
