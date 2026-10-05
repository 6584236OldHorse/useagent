import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { commands, runs } from "../src/db/schema";
import {
  acceptInternalRunCommand,
  ExpectedSandboxMismatchError,
  preflightInternalRunCommandReplay,
} from "../src/commands/service";
import type { RunCommandInput, RunCommandIntent } from "../src/commands/types";
import { getRunWithSteps } from "../src/runs/repo";
import { acceptExistingThreadFollowup } from "../src/runs/thread-followups";

const ORG = "org-expected-sandbox-test";

afterAll(async () => {
  await db.delete(commands).where(eq(commands.orgId, ORG));
  await db.delete(runs).where(eq(runs.orgId, ORG));
});

function intent(prompt: string, parentRunId: string): RunCommandIntent {
  return {
    prompt,
    model: "claude-opus-5",
    engine: "mock",
    parentRunId,
    requestedRepos: [],
    requestedResources: [],
    attachmentIds: [],
    memoryScope: "org",
    skillId: null,
    skillVersion: null,
    commandName: null,
    commandProvider: null,
    commandSessionId: null,
    commandCatalogRevision: null,
  };
}

function command(
  runId: string,
  parentRunId: string,
  idempotencyKey: string,
  runIntent: RunCommandIntent,
): RunCommandInput {
  return {
    idempotencyKey,
    orgId: ORG,
    actorId: null,
    intent: runIntent,
    run: {
      id: runId,
      prompt: runIntent.prompt,
      model: "claude-opus-5",
      engine: "mock",
      parentRunId,
      threadId: parentRunId,
      repos: [],
      memoryScope: "org",
      skillId: null,
      skillVersion: null,
      skillContentHash: null,
      commandName: null,
      commandProvider: null,
      commandSessionId: null,
      commandCatalogRevision: null,
    },
  };
}

test("constrained follow-up replay and persistence survive bounded audit truncation", async () => {
  const parentRunId = crypto.randomUUID();
  const sandboxId = `sandbox-${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id: parentRunId,
    orgId: ORG,
    userId: null,
    prompt: "sandbox owner",
    model: "claude-opus-5",
    engine: "mock",
    status: "completed",
    threadId: parentRunId,
    origin: "internal:hosted-infra-soak",
    sandboxId,
    sandboxProvider: "cube",
    sandboxCredential: "env",
  });
  const expectedSandbox = {
    version: 1,
    sandboxId,
    provider: "cube",
    credential: "env",
    ownerOrgId: ORG,
    ownerUserId: null,
    credentialGeneration: "a".repeat(64),
  } as const;

  const unfencedRunId = crypto.randomUUID();
  await expect(acceptExistingThreadFollowup(
    ORG,
    parentRunId,
    command(
      unfencedRunId,
      parentRunId,
      `expected-sandbox-required:${crypto.randomUUID()}`,
      intent("unfenced soak", parentRunId),
    ),
  )).rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
  expect(await db.select({ id: runs.id }).from(runs)
    .where(eq(runs.id, unfencedRunId))).toHaveLength(0);

  const runId = crypto.randomUUID();
  const idempotencyKey = `expected-sandbox:${crypto.randomUUID()}`;
  const runIntent = {
    ...intent("x".repeat(9_000), parentRunId),
    expectedSandbox,
  };
  const accepted = {
    ...command(runId, parentRunId, idempotencyKey, runIntent),
    expectedSandbox,
  };
  expect(await acceptExistingThreadFollowup(ORG, parentRunId, accepted)).toMatchObject({
    status: "created",
    runId,
  });
  const [storedRun] = await db.select({ expectedSandbox: runs.expectedSandbox })
    .from(runs).where(eq(runs.id, runId)).limit(1);
  const [storedCommand] = await db.select({ payload: commands.payload })
    .from(commands).where(eq(commands.runId, runId)).limit(1);
  expect(storedRun?.expectedSandbox).toEqual(expectedSandbox);
  expect(storedCommand?.payload).not.toContain("expectedSandbox");
  expect(await getRunWithSteps(ORG, runId)).not.toHaveProperty("expected_sandbox");
  expect(await preflightInternalRunCommandReplay({
    orgId: ORG,
    idempotencyKey,
    intent: runIntent,
    origin: "internal:hosted-infra-soak",
  })).toEqual({ status: "replayed", runId });
  expect(await preflightInternalRunCommandReplay({
    orgId: ORG,
    idempotencyKey,
    intent: { ...runIntent, expectedSandbox: null },
    origin: "internal:hosted-infra-soak",
  })).toEqual({ status: "conflict", reason: "payload_mismatch" });
  expect(await preflightInternalRunCommandReplay({
    orgId: ORG,
    idempotencyKey,
    intent: { ...runIntent, expectedSandbox: null },
    origin: "internal:eval",
  })).toEqual({ status: "conflict", reason: "origin_mismatch" });
  expect(await preflightInternalRunCommandReplay({
    orgId: ORG,
    idempotencyKey,
    intent: {
      ...runIntent,
      expectedSandbox: { ...expectedSandbox, credentialGeneration: "b".repeat(64) },
    },
    origin: "internal:hosted-infra-soak",
  })).toEqual({ status: "conflict", reason: "payload_mismatch" });

  const mismatchedRunId = crypto.randomUUID();
  const mismatched = { ...expectedSandbox, sandboxId: `other-${sandboxId}` };
  const mismatchedIntent = {
    ...intent("mismatched sandbox", parentRunId),
    expectedSandbox: mismatched,
  };
  await expect(acceptExistingThreadFollowup(ORG, parentRunId, {
    ...command(
      mismatchedRunId,
      parentRunId,
      `expected-sandbox-mismatch:${crypto.randomUUID()}`,
      mismatchedIntent,
    ),
    expectedSandbox: mismatched,
  })).rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
  expect(await db.select({ id: runs.id }).from(runs)
    .where(eq(runs.id, mismatchedRunId))).toHaveLength(0);
  expect(await db.select({ id: commands.id }).from(commands)
    .where(eq(commands.runId, mismatchedRunId))).toHaveLength(0);

  const publicParentRunId = crypto.randomUUID();
  await db.insert(runs).values({
    id: publicParentRunId,
    orgId: ORG,
    userId: null,
    prompt: "public sandbox owner",
    model: "claude-opus-5",
    engine: "mock",
    status: "completed",
    threadId: publicParentRunId,
    sandboxId: `public-${sandboxId}`,
    sandboxProvider: "cube",
    sandboxCredential: "env",
  });
  const publicExpected = {
    ...expectedSandbox,
    sandboxId: `public-${sandboxId}`,
  };
  const publicRunId = crypto.randomUUID();
  const publicIntent = {
    ...intent("operator fence on public parent", publicParentRunId),
    expectedSandbox: publicExpected,
  };
  await expect(acceptInternalRunCommand({
    ...command(
      publicRunId,
      publicParentRunId,
      `expected-sandbox-public:${crypto.randomUUID()}`,
      publicIntent,
    ),
    expectedSandbox: publicExpected,
    origin: "internal:eval",
  })).rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
  expect(await db.select({ id: runs.id }).from(runs)
    .where(eq(runs.id, publicRunId))).toHaveLength(0);
});
