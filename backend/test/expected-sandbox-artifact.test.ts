import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { publishSandboxArtifact } from "../src/artifacts/publish";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { db } from "../src/db/client";
import { artifacts, canonicalizationOutbox, providerEvents, runs } from "../src/db/schema";
import { createRun, setRunSandbox } from "../src/runs/repo";
import { setSandboxDownloaderForTest, setSandboxPathResolverForTest } from "../src/slack/sandbox-file";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";
// Boots src/index -> migrate, so the schema exists whichever file runs first.
import "./helpers";

test("artifact publication carries the durable fence through path resolution and download", async () => {
  const orgId = `expected-artifact-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  const sandboxId = `sandbox-${runId}`;
  const expectedSandbox = {
    version: 1 as const, sandboxId, provider: "cube" as const,
    credential: "env" as const, ownerOrgId: orgId, ownerUserId: null,
    credentialGeneration: "a".repeat(64),
  };
  const authorities: unknown[] = [];
  const bytes = Buffer.from("owned artifact proof");
  await createRun({ id: runId, orgId, userId: null, threadId: runId, parentRunId: null,
    prompt: "publish", model: "mock", engine: "mock", expectedSandbox });
  await setRunSandbox(runId, sandboxId, { kind: "cube", credential: "env" });
  setArtifactStorageForTest(new InMemoryArtifactStorage());
  setSandboxPathResolverForTest(async (_sandboxId, path, run) => {
    authorities.push(run);
    return path;
  });
  setSandboxDownloaderForTest(async (_sandboxId, _path, _maxBytes, run) => {
    authorities.push(run);
    return { bytes, size: bytes.length };
  });
  try {
    const result = await publishSandboxArtifact({ orgId, userId: null, runId,
      threadId: runId, path: "/root/work/proof.txt" });
    expect(result.created).toBe(true);
    expect(authorities).toHaveLength(2);
    for (const authority of authorities) {
      expect(authority).toMatchObject({ orgId, threadId: runId, sandboxId, expectedSandbox });
    }
  } finally {
    setSandboxPathResolverForTest(null);
    setSandboxDownloaderForTest(null);
    setArtifactStorageForTest(null);
    await db.delete(canonicalizationOutbox).where(eq(canonicalizationOutbox.runId, runId));
    await db.delete(providerEvents).where(eq(providerEvents.runId, runId));
    await db.delete(artifacts).where(eq(artifacts.orgId, orgId));
    await db.delete(runs).where(eq(runs.id, runId));
  }
});
