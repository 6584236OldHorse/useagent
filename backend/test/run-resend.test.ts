import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { db } from "../src/db/client";
import { runs, userUploads } from "../src/db/schema";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";
import { createOrgSession, fetchApi, json, type OrgSession, waitFor } from "./helpers";

const storage = new InMemoryArtifactStorage();
let owner: OrgSession;
let outsider: OrgSession;

async function runRow(id: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row!;
}

async function uploadRows(runId: string) {
  return db.select().from(userUploads).where(eq(userUploads.runId, runId));
}

/** A settled run with one attachment, then marked failed the way the worker records it. */
async function failedRunWithAttachment(): Promise<string> {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3, 4])], "notes.txt", { type: "text/plain" }));
  const uploaded = await fetchApi("/api/uploads", { method: "POST", cookies: owner.cookies, body: form });
  expect(uploaded.status).toBe(201);
  const { upload } = (await uploaded.json()) as { upload: { id: string } };
  const created = await json<{ id: string }>("/api/runs", {
    method: "POST",
    cookies: owner.cookies,
    body: { prompt: "summarise the notes", attachments: [upload.id], permission_mode: "read-only" },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  await waitFor(async () => {
    const row = await runRow(id);
    return row.status !== "queued" && row.status !== "running";
  });
  await db.update(runs).set({ status: "failed", summary: "provider error" }).where(eq(runs.id, id));
  return id;
}

function resend(runId: string, key: string | null, session: OrgSession = owner) {
  return json<{ id?: string; error?: string; reason?: string }>(`/api/runs/${runId}/resend`, {
    method: "POST",
    cookies: session.cookies,
    headers: key ? { "Idempotency-Key": key } : {},
  });
}

beforeAll(async () => {
  owner = await createOrgSession("resend-owner");
  outsider = await createOrgSession("resend-outsider");
  setArtifactStorageForTest(storage);
});

afterAll(() => {
  setArtifactStorageForTest(null);
});

describe("POST /api/runs/:id/resend", () => {
  test("sends the failed prompt again as a follow-up with the same settings and files", async () => {
    const failedId = await failedRunWithAttachment();
    const failed = await runRow(failedId);
    const [source] = await uploadRows(failedId);

    const first = await resend(failedId, "click-1");
    expect(first.status).toBe(201);
    const resent = await runRow(first.body.id!);
    expect(resent.id).not.toBe(failedId);
    expect(resent.threadId).toBe(failed.threadId);
    expect(resent.parentRunId).toBe(failedId);
    expect(resent.prompt).toBe(failed.prompt);
    expect(resent.engine).toBe(failed.engine);
    expect(resent.model).toBe(failed.model);
    expect(resent.permissionMode).toBe("read-only");
    const [copy] = await uploadRows(resent.id);
    expect(copy?.id).not.toBe(source!.id);
    expect(copy?.name).toBe("notes.txt");
    expect(copy?.storageKey).toBe(source!.storageKey);
    // The failed run keeps its own file.
    expect((await uploadRows(failedId)).map((u) => u.id)).toEqual([source!.id]);
  });

  test("a repeated click with the same key replays the run it created", async () => {
    const failedId = await failedRunWithAttachment();
    const first = await resend(failedId, "click-replay");
    expect(first.status).toBe(201);
    const again = await resend(failedId, "click-replay");
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const copies = await db.select().from(userUploads).where(eq(userUploads.runId, first.body.id!));
    expect(copies).toHaveLength(1);
  });

  test("only the newest turn can be resent, while a repeated click still replays", async () => {
    const failedId = await failedRunWithAttachment();
    const first = await resend(failedId, "click-a");
    expect(first.status).toBe(201);

    // The resent run is now newest, so a new click on the old failure is refused.
    const second = await resend(failedId, "click-b");
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("run_not_latest");

    const again = await resend(failedId, "click-a");
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  test("refuses a run that did not fail, a command, a missing key and another org", async () => {
    const failedId = await failedRunWithAttachment();
    expect((await resend(failedId, null)).status).toBe(400);
    expect((await resend(failedId, "click-x", outsider)).status).toBe(404);

    await db.update(runs).set({ status: "completed" }).where(eq(runs.id, failedId));
    const notFailed = await resend(failedId, "click-y");
    expect(notFailed.status).toBe(409);
    expect(notFailed.body.error).toBe("run_not_failed");

    await db.update(runs).set({ status: "failed", commandName: "compact" }).where(eq(runs.id, failedId));
    const command = await resend(failedId, "click-z");
    expect(command.status).toBe(409);
    expect(command.body.error).toBe("not_resendable");
  });
});
