import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { renderArtifactExport } from "@useagent/artifact-formats";
import { csvToWorkbook, migrateSlidesToDeck } from "@useagent/artifact-workspace";
import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import { setOfficePreviewConverterForTest } from "../src/artifacts/office-preview";
import { setArtifactStorageForTest, type ArtifactStorage } from "../src/artifacts/storage";
import { acceptRunCancel } from "../src/commands/cancel";
import { db } from "../src/db/client";
import {
  commands,
  finishedWorkObligations,
  finishedWorkReceipts,
  providerEvents,
} from "../src/db/schema";
import { finalizeRun } from "../src/runs/finalize";
import { createRun, getRun, setRunSandbox, setRunStatus } from "../src/runs/repo";
import { startSlackOutbox, type SlackClient } from "../src/slack";
import { processDue, stopSlackOutboxRelay } from "../src/slack/outbox";
import { createSlackRunResponse, linkSlackThread } from "../src/slack/repo";
import {
  setSandboxDownloaderForTest,
  setSandboxPathResolverForTest,
} from "../src/slack/sandbox-file";
import { createOrgSession, fetchApi, json, type OrgSession } from "./helpers";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";
import { and, eq } from "drizzle-orm";

const storage = new InMemoryArtifactStorage();
const sandboxFiles = new Map<string, Buffer>();
const resolvedPaths = new Map<string, string>();
let downloadCount = 0;
let pdfBytes: Buffer;
let owner: OrgSession;
let outsider: OrgSession;

function installDownloader(): void {
  setSandboxDownloaderForTest(async (_sandboxId, path) => {
    downloadCount += 1;
    const bytes = sandboxFiles.get(path);
    if (!bytes) throw new Error("missing sandbox file");
    return { bytes, size: bytes.byteLength };
  });
}

beforeAll(async () => {
  owner = await createOrgSession("artifact-completion-owner");
  outsider = await createOrgSession("artifact-completion-outsider");
  pdfBytes = Buffer.from((await renderArtifactExport({ pdfText: "Artifact completion" }, "pdf")).bytes);
  setArtifactStorageForTest(storage);
  setOfficePreviewConverterForTest(async () => null);
  setSandboxPathResolverForTest(async (_sandboxId, path) => resolvedPaths.get(path) ?? path);
  stopSlackOutboxRelay();
});

beforeEach(() => {
  sandboxFiles.clear();
  resolvedPaths.clear();
  downloadCount = 0;
  setArtifactStorageForTest(storage);
  installDownloader();
});

afterAll(() => {
  setSandboxDownloaderForTest(null);
  setSandboxPathResolverForTest(null);
  setOfficePreviewConverterForTest(null);
  setArtifactStorageForTest(null);
  startSlackOutbox();
});

async function createSandboxRun(
  session: OrgSession,
  provider: SandboxProviderKind = "cube",
): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "Create and share the requested file",
    model: "test",
    engine: "codex",
    orgId: session.orgId,
    userId: session.email,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  await setRunSandbox(runId, `sandbox-${runId}`, { kind: provider, credential: "env" });
  return runId;
}

async function listArtifacts(session: OrgSession, threadId: string) {
  return json<{ artifacts: Array<{
    id: string;
    run_id: string;
    thread_id: string;
    name: string;
    sha256: string;
    download_url: string;
  }> }>(`/api/artifacts?thread_id=${threadId}`, { cookies: session.cookies });
}

function recordingSlack(uploads: Array<{ filename: string; bytes: Uint8Array }>): SlackClient {
  return {
    postMessage: async () => ({ ok: true, ts: "message.1" }),
    updateMessage: async () => ({ ok: true }),
    addReaction: async () => ({ ok: true }),
    setSessionStatus: async () => ({ ok: true }),
    setThreadStatus: async () => ({ ok: true }),
    startStream: async () => ({ ok: true, ts: "stream.1" }),
    appendStream: async () => ({ ok: true }),
    stopStream: async () => ({ ok: true }),
    uploadFile: async ({ filename, bytes }) => {
      uploads.push({ filename, bytes });
      return { ok: true };
    },
  };
}

describe("artifact completion", () => {
  test("publishes an explicitly linked local PDF before completing the run", async () => {
    const path = "/home/user/work/Quarterly Report (final).pdf";
    const runId = await createSandboxRun(owner, "box");
    sandboxFiles.set(path, pdfBytes);

    const finalized = await finalizeRun(
      runId,
      "completed",
      `Completed the report: [Download PDF](<${path}>)`,
      100,
    );

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    if (!finalized.applied) throw new Error("run was not finalized");
    expect(finalized.summary).not.toContain(path);

    const listed = await listArtifacts(owner, runId);
    expect(listed.status).toBe(200);
    expect(listed.body.artifacts).toHaveLength(1);
    const artifact = listed.body.artifacts[0]!;
    expect(finalized.summary).toContain(artifact.download_url);
    expect(artifact).toMatchObject({
      run_id: runId,
      thread_id: runId,
      sha256: createHash("sha256").update(pdfBytes).digest("hex"),
    });
    const [obligation] = await db.select().from(finishedWorkObligations)
      .where(eq(finishedWorkObligations.runId, runId));
    const [receipt] = await db.select().from(finishedWorkReceipts)
      .where(eq(finishedWorkReceipts.runId, runId));
    expect(obligation).toMatchObject({
      state: "satisfied",
      materializedArtifactId: artifact.id,
      materializedArtifactRevision: 0,
    });
    expect(receipt).toMatchObject({
      obligationId: obligation?.id,
      artifactId: artifact.id,
      artifactRevision: 0,
      metadata: {
        digest: artifact.sha256,
        mime: "application/pdf",
        byteCount: pdfBytes.byteLength,
      },
    });

    const content = await fetchApi(`/api/artifacts/${artifact.id}/content`, {
      cookies: owner.cookies,
    });
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(pdfBytes);

    const denied = await fetchApi(`/api/artifacts/${artifact.id}/content`, {
      cookies: outsider.cookies,
    });
    expect(denied.status).toBe(404);
  });

  const formats = [
    { name: "PDF", provider: "box", path: "/home/user/work/output.pdf", target: "</home/user/work/output.pdf>", image: false },
    { name: "DOCX", provider: "cube", path: "/root/work/output.docx", target: "/root/work/output.docx", image: false },
    { name: "XLSX", provider: "daytona", path: "/root/work/output.xlsx", target: "file:///root/work/output.xlsx", image: false },
    { name: "PPTX", provider: "box", path: "/home/user/work/output.pptx", target: "sandbox:/home/user/work/output.pptx", image: false },
    { name: "CSV", provider: "cube", path: "/root/work/output.csv", target: "</root/work/output.csv>", image: false },
    { name: "PNG", provider: "daytona", path: "/root/work/output.png", target: "file:///root/work/output.png", image: true },
    { name: "WebM", provider: "box", path: "/home/user/work/output.webm", target: "/home/user/work/output.webm", image: false },
    { name: "ZIP", provider: "cube", path: "/root/work/output.zip", target: "sandbox:/root/work/output.zip", image: false },
    { name: "extensionless", provider: "daytona", path: "/root/work/output", target: "/root/work/output", image: false },
  ] as const;

  test.each(formats)("publishes an explicitly linked $name file without changing its bytes", async ({ provider, path, target, image }) => {
    const rendered = path.endsWith(".pdf")
      ? pdfBytes
      : path.endsWith(".docx")
        ? Buffer.from((await renderArtifactExport({ text: "Document" }, "docx")).bytes)
        : path.endsWith(".xlsx")
          ? Buffer.from((await renderArtifactExport({ workbook: csvToWorkbook("name,value\nrun,42") }, "xlsx")).bytes)
          : path.endsWith(".pptx")
            ? Buffer.from((await renderArtifactExport({ deck: migrateSlidesToDeck([{ title: "Deck", body: "Ready" }]) }, "pptx")).bytes)
            : path.endsWith(".csv")
              ? Buffer.from("name,value\nrun,42\n")
              : path.endsWith(".png")
                ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
                : path.endsWith(".webm")
                  ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80])
                  : path.endsWith(".zip")
                    ? Buffer.from(await new JSZip().file("proof.txt", "ready\n").generateAsync({ type: "uint8array" }))
                    : Buffer.from("extensionless deliverable\n");
    const runId = await createSandboxRun(owner, provider);
    sandboxFiles.set(path, rendered);

    const finalized = await finalizeRun(runId, "completed", `Ready: ${image ? "!" : ""}[Output](${target})`, 100);

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    const listed = await listArtifacts(owner, runId);
    expect(listed.body.artifacts).toHaveLength(1);
    const artifact = listed.body.artifacts[0]!;
    const content = await fetchApi(`/api/artifacts/${artifact.id}/content`, { cookies: owner.cookies });
    expect(Buffer.from(await content.arrayBuffer())).toEqual(rendered);
  });

  test("does not complete when an explicitly linked local file is missing", async () => {
    const runId = await createSandboxRun(owner);

    await finalizeRun(runId, "completed", "Ready: [Download](/root/work/missing.pdf)", 100)
      .catch(() => null);

    expect((await getRun(runId))?.status).not.toBe("completed");
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test("deduplicates publication when completion races for the same run", async () => {
    const runId = await createSandboxRun(owner);
    const path = "/root/work/race.pdf";
    sandboxFiles.set(path, pdfBytes);
    const summary = `Ready: [Download](${path})`;

    const results = await Promise.all([
      finalizeRun(runId, "completed", summary, 100),
      finalizeRun(runId, "completed", summary, 100),
    ]);

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(1);
  });

  test("does not read or publish linked files after a finalization claim is lost", async () => {
    const runId = await createSandboxRun(owner);
    sandboxFiles.set("/root/work/unclaimed.pdf", pdfBytes);

    const finalized = await finalizeRun(
      runId,
      "completed",
      "Ready: [Download](/root/work/unclaimed.pdf)",
      100,
      { claim: async () => false },
    );

    expect(finalized).toEqual({ applied: false });
    expect(downloadCount).toBe(0);
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test("a cancel accepted before publication prevents completed artifact delivery", async () => {
    const runId = await createSandboxRun(owner);
    sandboxFiles.set("/root/work/cancelled.pdf", pdfBytes);
    await acceptRunCancel({ orgId: owner.orgId, actorId: owner.email, runId });

    const finalized = await finalizeRun(
      runId,
      "completed",
      "Ready: [Download](/root/work/cancelled.pdf)",
      100,
    );

    expect(finalized).toEqual({ applied: false });
    expect(downloadCount).toBe(0);
    expect((await getRun(runId))?.status).toBe("failed");
  });

  test("a cancel accepted while publication is downloading prevents completion", async () => {
    const runId = await createSandboxRun(owner);
    await setRunStatus(runId, "running");
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    setSandboxDownloaderForTest(async () => {
      markStarted();
      await released;
      return { bytes: pdfBytes, size: pdfBytes.byteLength };
    });
    const finalizing = finalizeRun(
      runId,
      "completed",
      "Ready: [Download](/root/work/cancel-race.pdf)",
      100,
    );
    await started;

    await db.insert(commands).values({
      id: crypto.randomUUID(),
      idempotencyKey: `cancel:${runId}`,
      orgId: owner.orgId,
      actorId: owner.email,
      kind: "run.cancel",
      runId,
      threadId: runId,
      state: "completed",
      attemptCount: 0,
    });
    release();
    const finalized = await finalizing;

    expect(finalized).toMatchObject({ applied: true, status: "failed" });
    expect((await getRun(runId))?.status).toBe("failed");
  });

  test("does not complete when durable artifact storage rejects the bytes", async () => {
    const runId = await createSandboxRun(owner);
    sandboxFiles.set("/root/work/storage-failure.pdf", pdfBytes);
    const failingStorage: ArtifactStorage = {
      put: async () => { throw new Error("injected storage failure"); },
      read: (key, range) => storage.read(key, range),
      size: (key) => storage.size(key),
      sha256: (key) => storage.sha256(key),
    };
    setArtifactStorageForTest(failingStorage);

    const finalized = await finalizeRun(
      runId,
      "completed",
      "Ready: [Download](/root/work/storage-failure.pdf)",
      100,
    );

    expect(finalized).toMatchObject({ applied: true, status: "failed" });
    expect((await getRun(runId))?.status).toBe("failed");
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test("uploads every final linked file to Slack and records delivery only after accepted bytes", async () => {
    const runId = await createSandboxRun(owner);
    const channel = `C${runId.slice(0, 8)}`;
    const threadTs = `${runId.slice(0, 8)}.1`;
    await linkSlackThread({ teamId: "T0TESTTEAM", channel, threadTs, rootRunId: runId, orgId: owner.orgId });
    await createSlackRunResponse({ runId, teamId: "T0TESTTEAM", channel, threadTs });
    const expected = new Map<string, Buffer>();
    const links = Array.from({ length: 6 }, (_, index) => {
      const filename = `final-${runId.slice(0, 6)}-${index}.txt`;
      const path = `/root/work/${filename}`;
      const bytes = Buffer.from(`linked file ${index}\n`);
      sandboxFiles.set(path, bytes);
      expected.set(filename, bytes);
      return `[File ${index}](${path})`;
    });

    const finalized = await finalizeRun(runId, "completed", links.join("\n"), 100);

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    const before = await db.select().from(providerEvents).where(and(
      eq(providerEvents.runId, runId),
      eq(providerEvents.eventType, "artifact.delivered"),
    ));
    expect(before).toHaveLength(0);

    const uploads: Array<{ filename: string; bytes: Uint8Array }> = [];
    await processDue(recordingSlack(uploads));

    expect(uploads).toHaveLength(6);
    for (const upload of uploads) expect(Buffer.from(upload.bytes)).toEqual(expected.get(upload.filename));
    const after = await db.select().from(providerEvents).where(and(
      eq(providerEvents.runId, runId),
      eq(providerEvents.eventType, "artifact.delivered"),
    ));
    expect(after).toHaveLength(6);
  });

  test("does not harvest remote links or local links shown in code samples", async () => {
    const runId = await createSandboxRun(owner);
    const summary = [
      "Reference: [remote PDF](https://example.com/report.pdf)",
      "```markdown",
      "[example](/root/work/example.pdf)",
      "```",
    ].join("\n");

    const finalized = await finalizeRun(runId, "completed", summary, 100);

    expect(finalized).toEqual({ applied: true, status: "completed", summary });
    expect(downloadCount).toBe(0);
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test.each([
    { name: "secret path", path: "/root/work/.env" },
    { name: "path traversal", path: "/root/work/../private.txt" },
    { name: "private inspection screenshot", path: "/root/work/screenshots/screenshot-1786558088313.png" },
    { name: "workspace symlink", path: "/root/work/symlink.pdf", resolved: "/etc/passwd" },
  ])("does not complete a download claim for a $name", async ({ path, resolved }) => {
    const runId = await createSandboxRun(owner);
    sandboxFiles.set(path, pdfBytes);
    if (resolved) resolvedPaths.set(path, resolved);

    await finalizeRun(runId, "completed", `Ready: [Download](${path})`, 100)
      .catch(() => null);

    expect((await getRun(runId))?.status).not.toBe("completed");
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });
});
