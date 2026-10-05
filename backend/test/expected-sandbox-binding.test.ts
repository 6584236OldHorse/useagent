import { afterAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { SandboxNotFoundError, type SandboxProvider } from "@useagent/sandbox-contract";
import * as sandboxProviders from "../src/sandboxes/provider";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import {
  ExpectedSandboxMismatchError,
  getThreadExpectedSandbox,
  resolveExpectedSandbox,
  resolveRunSandbox,
  resolveSandboxBindingForThread,
  sandboxBindingExpectation,
  type SandboxBinding,
} from "../src/sandboxes/binding";

const orgId = `expected-binding-${crypto.randomUUID()}`;

afterAll(async () => {
  await db.delete(runs).where(eq(runs.orgId, orgId));
});

test("thread authority follows the running turn before queued work without pinning later ordinary turns", async () => {
  const threadId = crypto.randomUUID();
  const liveId = crypto.randomUUID();
  const queuedId = crypto.randomUUID();
  const expectedSandbox = { version: 1 as const, sandboxId: "thread-sandbox", provider: "cube" as const,
    credential: "env" as const, ownerOrgId: orgId, ownerUserId: null, credentialGeneration: "a".repeat(64) };
  const base = { orgId, threadId, prompt: "fixture", model: "mock", engine: "mock" as const };
  const now = Date.now();
  await db.insert(runs).values([
    { ...base, id: threadId, status: "completed", createdAt: new Date(now) },
    { ...base, id: liveId, parentRunId: threadId, status: "running", expectedSandbox, createdAt: new Date(now + 1) },
    { ...base, id: queuedId, parentRunId: threadId, status: "queued", createdAt: new Date(now + 2) },
  ]);
  expect(await getThreadExpectedSandbox(orgId, threadId)).toEqual(expectedSandbox);
  await db.update(runs).set({ status: "completed" }).where(eq(runs.id, liveId));
  expect(await getThreadExpectedSandbox(orgId, threadId)).toBeNull();
  await db.update(runs).set({ expectedSandbox: { ...expectedSandbox, ownerOrgId: "foreign-org" } })
    .where(eq(runs.id, queuedId));
  await expect(getThreadExpectedSandbox(orgId, threadId)).rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
});

test("durable thread lookup rejects missing, changed, and rotated bindings without fallback", async () => {
  const threadId = crypto.randomUUID();
  const sandboxId = "expected-cube";
  const provider = { connectionFingerprint: "a".repeat(64) } as SandboxProvider;
  const binding: SandboxBinding = {
    kind: "cube", provider, credential: "env", userId: null, snapshot: null,
  };
  const expectedSandbox = sandboxBindingExpectation(binding, orgId, sandboxId);
  let fallbackCalls = 0;
  const deps = {
    expectedSandbox,
    env: { CUBE_API_KEY: "fixture-key" },
    providers: { cube: () => provider },
    envProvider: () => { fallbackCalls += 1; return binding; },
  };
  await expect(resolveSandboxBindingForThread(orgId, threadId, deps))
    .rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
  await db.insert(runs).values({
    id: threadId, orgId, threadId, prompt: "retained fixture", model: "mock",
    engine: "mock", status: "completed", sandboxId,
    sandboxProvider: "cube", sandboxCredential: "env",
  });
  expect((await resolveSandboxBindingForThread(orgId, threadId, deps)).provider).toBe(provider);
  await expect(resolveSandboxBindingForThread("foreign-org", threadId, deps))
    .rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
  for (const changed of [
    { sandboxId: null },
    { sandboxId: "replacement-cube" },
    { sandboxId, sandboxProvider: "daytona" as const },
    { sandboxId, sandboxProvider: "cube" as const, sandboxCredential: "user" as const },
  ]) {
    await db.update(runs).set(changed).where(eq(runs.id, threadId));
    await expect(resolveSandboxBindingForThread(orgId, threadId, deps))
      .rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
  }
  await db.update(runs).set({ sandboxId, sandboxProvider: "cube", sandboxCredential: "env" })
    .where(eq(runs.id, threadId));
  await expect(resolveSandboxBindingForThread(orgId, threadId, {
    ...deps,
    providers: { cube: () => ({ connectionFingerprint: "b".repeat(64) }) as SandboxProvider },
  })).rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
  expect(fallbackCalls).toBe(0);
  const factory = spyOn(sandboxProviders, "sandboxProviderFor").mockReturnValue({
    ...provider,
    get: async () => { throw new SandboxNotFoundError(new Error("fixture missing")); },
  } as SandboxProvider);
  try {
    await expect(resolveRunSandbox({ orgId: "foreign-org", threadId, sandboxId, expectedSandbox }))
      .rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
    expect(factory).not.toHaveBeenCalled();
    await expect(resolveExpectedSandbox(expectedSandbox, threadId))
      .rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
    await expect(resolveRunSandbox({ orgId, threadId, sandboxId, expectedSandbox }))
      .rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
    await expect(resolveRunSandbox({ orgId, threadId, sandboxId }))
      .rejects.toBeInstanceOf(SandboxNotFoundError);
  } finally {
    factory.mockRestore();
  }
});
