import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { providerSessionBinding } from "@useagent/agent-harness/canonical";
import { providerProtocolIdentity } from "@useagent/agent-harness/control";
import { db } from "../src/db/client";
import {
  canonicalizationOutbox,
  commands,
  providerEvents,
  reconcileQueue,
  runs,
} from "../src/db/schema";
import { piProviderDriver } from "../src/engines/pi-provider-driver";
import { enqueueReconcile } from "../src/runs/reconcile-queue";
import { recoverStaleRuns, runDueReconciles } from "../src/runs/recovery";
import type { ExpectedSandboxBinding } from "../src/sandboxes/expected-binding";
import "./helpers";

const ORG = "org-expected-sandbox-recovery-test";

afterAll(async () => {
  await db.delete(reconcileQueue).where(eq(reconcileQueue.threadId, ORG));
  await db.delete(providerEvents).where(eq(providerEvents.threadId, ORG));
  await db.delete(canonicalizationOutbox).where(eq(canonicalizationOutbox.threadId, ORG));
  await db.delete(commands).where(eq(commands.orgId, ORG));
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

async function seedRecoveryRun(input: {
  runId: string;
  sandboxId: string;
  queueSandboxId?: string;
  sessionFile: string;
  expectedSandbox: ExpectedSandboxBinding;
  parked?: boolean;
}): Promise<void> {
  const providerSession = providerSessionBinding({
    provider: "pi",
    nativeSessionId: input.sessionFile,
    runtime: { kind: "sandbox", id: input.sandboxId },
    protocolVersion: providerProtocolIdentity(piProviderDriver.descriptor.protocol),
    capabilities: piProviderDriver.descriptor.capabilities,
    generation: piProviderDriver.descriptor.sessionGeneration as number,
  });
  await db.insert(runs).values({
    id: input.runId,
    orgId: ORG,
    userId: null,
    prompt: "recover",
    model: "openai/gpt-5.6-luna",
    engine: "pi",
    status: "running",
    threadId: ORG,
    engineSessionId: input.sessionFile,
    providerSession,
    sandboxId: input.sandboxId,
    expectedSandbox: input.expectedSandbox,
  });
  await db.insert(commands).values({
    id: crypto.randomUUID(),
    orgId: ORG,
    kind: "run.create",
    runId: input.runId,
    threadId: ORG,
    state: "dispatched",
  });
  if (input.parked !== false) {
    await enqueueReconcile({
      runId: input.runId,
      threadId: ORG,
      sandboxId: input.queueSandboxId ?? input.sandboxId,
      sessionId: input.sessionFile,
      sinceAt: new Date(0),
      nextAttemptAt: new Date(Date.now() - 1_000),
      deadline: new Date(Date.now() + 60_000),
    });
  }
}

test("boot recovery propagates the durable expected sandbox before remote work", async () => {
  const runId = crypto.randomUUID();
  const sandboxId = `sandbox-${crypto.randomUUID()}`;
  const sessionFile = `/sessions/${crypto.randomUUID()}.jsonl`;
  const expectedSandbox = {
    version: 1 as const,
    sandboxId,
    provider: "box" as const,
    credential: "env" as const,
    ownerOrgId: ORG,
    ownerUserId: null,
    credentialGeneration: "0".repeat(64),
  };
  await seedRecoveryRun({
    runId,
    sandboxId,
    sessionFile,
    expectedSandbox,
    parked: false,
  });
  const seen: unknown[] = [];

  await recoverStaleRuns(
    async (_handle, checkpoint) => {
      if (checkpoint.metadata?.threadId === ORG) seen.push(checkpoint.metadata);
      return { status: "failed", summary: "backend restarted" };
    },
    async (input) => { if (input.threadId === ORG) seen.push(input); },
  );

  expect((await db.select({ status: runs.status }).from(runs)
    .where(eq(runs.id, runId)).limit(1))[0]?.status).toBe("failed");
  expect(seen).toEqual([
    { engine: "pi", sandboxId, threadId: ORG, expectedSandbox },
    { expectedSandbox, threadId: ORG },
  ]);
});

test("parked Pi recovery propagates the durable expected sandbox before remote work", async () => {
  const runId = crypto.randomUUID();
  const sandboxId = `sandbox-${crypto.randomUUID()}`;
  const sessionFile = `/sessions/${crypto.randomUUID()}.jsonl`;
  const expectedSandbox = {
    version: 1 as const,
    sandboxId,
    provider: "box" as const,
    credential: "env" as const,
    ownerOrgId: ORG,
    ownerUserId: null,
    credentialGeneration: "a".repeat(64),
  };
  await seedRecoveryRun({ runId, sandboxId, sessionFile, expectedSandbox });
  const seen: unknown[] = [];

  const result = await runDueReconciles(
    async (_handle, checkpoint) => {
      seen.push(checkpoint.metadata);
      return { status: "failed", summary: "backend restarted" };
    },
    async (input) => { seen.push(input); },
  );

  expect(result.failed).toBe(1);
  expect(seen).toEqual([
    { engine: "pi", sandboxId, threadId: ORG, expectedSandbox },
    { expectedSandbox, threadId: ORG },
  ]);
});

test("a parked expected sandbox mismatch settles without cleanup, probe, or retry", async () => {
  const runId = crypto.randomUUID();
  const sandboxId = `sandbox-${crypto.randomUUID()}`;
  const sessionFile = `/sessions/${crypto.randomUUID()}.jsonl`;
  const expectedSandbox = {
    version: 1 as const,
    sandboxId,
    provider: "box" as const,
    credential: "env" as const,
    ownerOrgId: ORG,
    ownerUserId: null,
    credentialGeneration: "b".repeat(64),
  };
  await seedRecoveryRun({
    runId,
    sandboxId,
    queueSandboxId: `wrong-${sandboxId}`,
    sessionFile,
    expectedSandbox,
  });
  let remoteOperations = 0;

  const result = await runDueReconciles(
    async () => { remoteOperations += 1; return { status: "unreachable" }; },
    async () => { remoteOperations += 1; },
  );

  expect(result).toMatchObject({ failed: 1, retried: 0 });
  expect(remoteOperations).toBe(0);
  expect((await db.select({ status: runs.status }).from(runs)
    .where(eq(runs.id, runId)).limit(1))[0]?.status).toBe("failed");
  expect(await db.select({ runId: reconcileQueue.runId }).from(reconcileQueue)
    .where(eq(reconcileQueue.runId, runId))).toHaveLength(0);
});
