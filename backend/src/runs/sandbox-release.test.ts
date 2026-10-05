import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { providerSessionBinding } from "@useagent/agent-harness/canonical";
import { providerProtocolIdentity } from "@useagent/agent-harness/control";
import { SandboxNotFoundError } from "@useagent/sandbox-contract";
import * as sandboxProviders from "../sandboxes/provider";
import { t3ProviderDrivers } from "../engines/t3-provider-driver";
import { eq, sql } from "drizzle-orm";
import { acceptRunCommand } from "../commands";
import { db } from "../db/client";
import { commands, runs } from "../db/schema";
import type { SandboxHandle, SandboxProvider } from "../sandboxes/provider";
import {
  sandboxBindingExpectation,
  type SandboxBinding,
} from "../sandboxes/binding";
import type { ExpectedSandboxBinding } from "../sandboxes/expected-binding";
import {
  createRun,
  getRun,
  getThreadSandbox,
  setRunEngineSession,
  setRunProviderSession,
  setRunSandbox,
  setRunStatus,
} from "./repo";
import { releaseRunSandbox } from "./sandbox-release";

const createdRuns = new Set<string>();

afterEach(async () => {
  for (const id of createdRuns) await db.delete(commands).where(eq(commands.runId, id));
  for (const id of [...createdRuns].reverse()) await db.delete(runs).where(eq(runs.id, id));
  createdRuns.clear();
});

async function runFixture(status: "running" | "completed" = "completed"): Promise<{
  orgId: string;
  runId: string;
  sandboxId: string;
}> {
  const orgId = `org-release-${crypto.randomUUID()}`;
  const runId = crypto.randomUUID();
  const sandboxId = `sandbox-${crypto.randomUUID()}`;
  createdRuns.add(runId);
  await createRun({
    id: runId,
    prompt: "parity case",
    model: "mock-model",
    engine: "mock",
    orgId,
    userId: "user-1",
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  await setRunSandbox(runId, sandboxId);
  await setRunStatus(runId, status);
  return { orgId, runId, sandboxId };
}

function fakeProvider(liveIds: Set<string>, getFails = false): {
  provider: SandboxProvider;
  deleted: string[];
  calls: { get: string[]; list: number; delete: string[] };
} {
  const deleted: string[] = [];
  const calls = { get: [] as string[], list: 0, delete: deleted };
  const handle = (id: string): SandboxHandle => ({
    id,
    cpu: 1,
    memory: 1,
    process: {} as SandboxHandle["process"],
    fs: {} as SandboxHandle["fs"],
    start: async () => {},
    delete: async () => {
      deleted.push(id);
      liveIds.delete(id);
    },
    getPreviewLink: async () => ({ url: "https://example.invalid" }),
  });
  return {
    deleted,
    calls,
    provider: {
      create: async () => handle("created"),
      get: async (id) => {
        calls.get.push(id);
        if (getFails || !liveIds.has(id)) throw new Error("not found");
        return handle(id);
      },
      async *list() {
        calls.list += 1;
        for (const id of liveIds) yield handle(id);
      },
    },
  };
}

async function addFencedChild(
  fixture: Awaited<ReturnType<typeof runFixture>>,
  provider: SandboxProvider,
  sessionFile?: string,
): Promise<ExpectedSandboxBinding> {
  const childId = crypto.randomUUID();
  const expectedSandbox = sandboxBindingExpectation({
    kind: "cube",
    provider,
    credential: "env",
    userId: null,
    snapshot: null,
  } satisfies SandboxBinding, fixture.orgId, fixture.sandboxId);
  createdRuns.add(childId);
  await createRun({
    id: childId,
    prompt: "fenced child",
    model: "mock-model",
    engine: sessionFile ? "pi" : "mock",
    orgId: fixture.orgId,
    userId: "user-1",
    parentRunId: fixture.runId,
    threadId: fixture.runId,
    repos: [],
    memoryScope: "org",
    expectedSandbox,
  });
  await setRunSandbox(childId, fixture.sandboxId, { kind: "cube", credential: "env" });
  if (sessionFile) await setRunEngineSession(childId, sessionFile);
  await setRunStatus(childId, "completed");
  await db.update(runs).set({ createdAt: new Date(Date.now() + 1_000) }).where(eq(runs.id, childId));
  return expectedSandbox;
}

describe("explicit sandbox release", () => {
  test("deletes only a settled org-scoped thread sandbox and clears its mapping", async () => {
    const fixture = await runFixture();
    await db.update(runs).set({ engine: "opencode" }).where(eq(runs.id, fixture.runId));
    await setRunProviderSession(fixture.runId, providerSessionBinding({
      provider: "opencode",
      nativeSessionId: "session-1",
      protocolVersion: providerProtocolIdentity(t3ProviderDrivers.opencode.descriptor.protocol),
      runtime: { kind: "sandbox", id: fixture.sandboxId },
      capabilities: {} as never,
      generation: t3ProviderDrivers.opencode.descriptor.sessionGeneration as number,
    }));
    const live = new Set([fixture.sandboxId, "unrelated-sandbox"]);
    const { provider, deleted } = fakeProvider(live);

    const result = await releaseRunSandbox(fixture.orgId, fixture.runId, { provider });

    expect(result).toEqual({ ok: true, released: true, sandboxId: fixture.sandboxId });
    expect(deleted).toEqual([fixture.sandboxId]);
    expect(live).toContain("unrelated-sandbox");
    expect(await getThreadSandbox(fixture.runId)).toBeNull();
    expect(await getRun(fixture.runId)).toMatchObject({
      sandboxId: null,
      engineSessionId: null,
      providerSession: null,
    });
  });

  test("rejects a differing expected sandbox id without cleanup side effects", async () => {
    const fixture = await runFixture();
    const sessionFile = `/sessions/${crypto.randomUUID()}.jsonl`;
    await db.update(runs).set({ engine: "pi" }).where(eq(runs.id, fixture.runId));
    await setRunEngineSession(fixture.runId, sessionFile);
    const unrelatedSandboxId = `sandbox-${crypto.randomUUID()}`;
    const live = new Set([fixture.sandboxId, unrelatedSandboxId]);
    const { provider, calls } = fakeProvider(live);
    const removed: string[] = [];

    expect(await releaseRunSandbox(fixture.orgId, fixture.runId, {
      provider,
      expectedSandboxId: `sandbox-${crypto.randomUUID()}`,
      removePiBridge: async (value) => { removed.push(value); },
    })).toEqual({ ok: false, reason: "expected_sandbox_mismatch" });
    expect(calls).toEqual({ get: [], list: 0, delete: [] });
    expect(removed).toEqual([]);
    expect(await getThreadSandbox(fixture.runId)).toBe(fixture.sandboxId);
    expect(live).toEqual(new Set([fixture.sandboxId, unrelatedSandboxId]));
  });

  test("rejects a missing mapping when an expected sandbox id is supplied", async () => {
    const fixture = await runFixture();
    const sessionFile = `/sessions/${crypto.randomUUID()}.jsonl`;
    await db
      .update(runs)
      .set({ engine: "pi", engineSessionId: sessionFile, sandboxId: null })
      .where(eq(runs.id, fixture.runId));
    const live = new Set([fixture.sandboxId]);
    const { provider, calls } = fakeProvider(live);
    const removed: string[] = [];

    expect(await releaseRunSandbox(fixture.orgId, fixture.runId, {
      provider,
      expectedSandboxId: fixture.sandboxId,
      removePiBridge: async (value) => { removed.push(value); },
    })).toEqual({ ok: false, reason: "expected_sandbox_mismatch" });
    expect(calls).toEqual({ get: [], list: 0, delete: [] });
    expect(removed).toEqual([]);
    expect(await getThreadSandbox(fixture.runId)).toBeNull();
    expect(live).toEqual(new Set([fixture.sandboxId]));
  });

  test("releases normally when the expected sandbox id matches", async () => {
    const fixture = await runFixture();
    const live = new Set([fixture.sandboxId]);
    const { provider, calls } = fakeProvider(live);

    expect(await releaseRunSandbox(fixture.orgId, fixture.runId, {
      provider,
      expectedSandboxId: fixture.sandboxId,
    })).toEqual({ ok: true, released: true, sandboxId: fixture.sandboxId });
    expect(calls).toEqual({ get: [fixture.sandboxId], list: 0, delete: [fixture.sandboxId] });
    expect(await getThreadSandbox(fixture.runId)).toBeNull();
  });

  test("uses a settled fenced child when releasing an older unfenced root", async () => {
    const fixture = await runFixture();
    const sessionFile = `/sessions/${crypto.randomUUID()}.jsonl`;
    const strict = fakeProvider(new Set([fixture.sandboxId]));
    Object.assign(strict.provider, { connectionFingerprint: "a".repeat(64) });
    const expectedSandbox = await addFencedChild(fixture, strict.provider, sessionFile);
    const removed: Array<[string, ExpectedSandboxBinding | undefined]> = [];
    const factory = spyOn(sandboxProviders, "sandboxProviderFor").mockReturnValue(strict.provider);
    const previousCubeKey = process.env.CUBE_API_KEY;
    process.env.CUBE_API_KEY = "fixture-key";
    try {
      expect(await releaseRunSandbox(fixture.orgId, fixture.runId, {
        provider: fakeProvider(new Set([fixture.sandboxId])).provider,
        removePiBridge: async (session, expected) => { removed.push([session, expected]); },
      })).toEqual({ ok: true, released: true, sandboxId: fixture.sandboxId });
      expect(strict.calls).toEqual({
        get: [fixture.sandboxId],
        list: 0,
        delete: [fixture.sandboxId],
      });
      expect(removed).toEqual([[sessionFile, expectedSandbox]]);
      expect(await getThreadSandbox(fixture.runId)).toBeNull();
    } finally {
      factory.mockRestore();
      if (previousCubeKey === undefined) delete process.env.CUBE_API_KEY;
      else process.env.CUBE_API_KEY = previousCubeKey;
    }
  });

  test("preserves a fenced mapping when its credential generation changed", async () => {
    const fixture = await runFixture();
    const accepted = fakeProvider(new Set([fixture.sandboxId]));
    Object.assign(accepted.provider, { connectionFingerprint: "a".repeat(64) });
    await addFencedChild(fixture, accepted.provider);
    const rotated = fakeProvider(new Set([fixture.sandboxId]));
    Object.assign(rotated.provider, { connectionFingerprint: "b".repeat(64) });
    const bypass = fakeProvider(new Set([fixture.sandboxId]));
    const factory = spyOn(sandboxProviders, "sandboxProviderFor").mockReturnValue(rotated.provider);
    const previousCubeKey = process.env.CUBE_API_KEY;
    process.env.CUBE_API_KEY = "rotated-key";
    try {
      expect(await releaseRunSandbox(fixture.orgId, fixture.runId, {
        provider: bypass.provider,
      })).toEqual({ ok: false, reason: "expected_sandbox_mismatch" });
      expect(rotated.calls).toEqual({ get: [], list: 0, delete: [] });
      expect(bypass.calls).toEqual({ get: [], list: 0, delete: [] });
      expect(await getThreadSandbox(fixture.runId)).toBe(fixture.sandboxId);
    } finally {
      factory.mockRestore();
      if (previousCubeKey === undefined) delete process.env.CUBE_API_KEY;
      else process.env.CUBE_API_KEY = previousCubeKey;
    }
  });

  test("rejects a strict provider handle for another sandbox without listing", async () => {
    const fixture = await runFixture();
    const strict = fakeProvider(new Set([fixture.sandboxId]));
    Object.assign(strict.provider, { connectionFingerprint: "a".repeat(64) });
    await addFencedChild(fixture, strict.provider);
    strict.provider.get = async (id) => {
      strict.calls.get.push(id);
      return (await fakeProvider(new Set(["foreign-sandbox"])).provider.get("foreign-sandbox"));
    };
    const factory = spyOn(sandboxProviders, "sandboxProviderFor").mockReturnValue(strict.provider);
    const previousCubeKey = process.env.CUBE_API_KEY;
    process.env.CUBE_API_KEY = "fixture-key";
    try {
      expect(await releaseRunSandbox(fixture.orgId, fixture.runId)).toEqual({
        ok: false,
        reason: "expected_sandbox_mismatch",
      });
      expect(strict.calls).toEqual({ get: [fixture.sandboxId], list: 0, delete: [] });
      expect(await getThreadSandbox(fixture.runId)).toBe(fixture.sandboxId);
    } finally {
      factory.mockRestore();
      if (previousCubeKey === undefined) delete process.env.CUBE_API_KEY;
      else process.env.CUBE_API_KEY = previousCubeKey;
    }
  });

  test("only a typed strict-provider absence clears the mapping without listing", async () => {
    const fixture = await runFixture();
    const strict = fakeProvider(new Set([fixture.sandboxId]));
    Object.assign(strict.provider, { connectionFingerprint: "a".repeat(64) });
    await addFencedChild(fixture, strict.provider);
    strict.provider.get = async (id) => {
      strict.calls.get.push(id);
      throw new Error("transport failed");
    };
    const factory = spyOn(sandboxProviders, "sandboxProviderFor").mockReturnValue(strict.provider);
    const previousCubeKey = process.env.CUBE_API_KEY;
    process.env.CUBE_API_KEY = "fixture-key";
    try {
      expect(await releaseRunSandbox(fixture.orgId, fixture.runId)).toEqual({
        ok: false,
        reason: "provider_error",
      });
      expect(strict.calls.list).toBe(0);
      expect(await getThreadSandbox(fixture.runId)).toBe(fixture.sandboxId);

      strict.provider.get = async (id) => {
        strict.calls.get.push(id);
        throw new SandboxNotFoundError();
      };
      expect(await releaseRunSandbox(fixture.orgId, fixture.runId)).toEqual({
        ok: true,
        released: true,
        sandboxId: fixture.sandboxId,
      });
      expect(strict.calls.list).toBe(0);
      expect(await getThreadSandbox(fixture.runId)).toBeNull();
    } finally {
      factory.mockRestore();
      if (previousCubeKey === undefined) delete process.env.CUBE_API_KEY;
      else process.env.CUBE_API_KEY = previousCubeKey;
    }
  });

  test("removes a retained Pi bridge after deleting its sandbox", async () => {
    const fixture = await runFixture();
    const sessionFile = `/sessions/${crypto.randomUUID()}.jsonl`;
    await db.update(runs).set({ engine: "pi" }).where(eq(runs.id, fixture.runId));
    await setRunEngineSession(fixture.runId, sessionFile);
    const { provider } = fakeProvider(new Set([fixture.sandboxId]));
    const removed: string[] = [];

    expect(await releaseRunSandbox(fixture.orgId, fixture.runId, {
      provider,
      removePiBridge: async (value) => { removed.push(value); },
    })).toEqual({ ok: true, released: true, sandboxId: fixture.sandboxId });
    expect(removed).toEqual([sessionFile]);
  });

  test("refuses to tear down a thread with a running turn", async () => {
    const fixture = await runFixture("running");
    const { provider, deleted } = fakeProvider(new Set([fixture.sandboxId]));
    expect(await releaseRunSandbox(fixture.orgId, fixture.runId, { provider })).toEqual({
      ok: false,
      reason: "thread_active",
    });
    expect(deleted).toEqual([]);
    expect(await getThreadSandbox(fixture.runId)).toBe(fixture.sandboxId);
  });

  test("clears a stale mapping only after the provider list proves absence", async () => {
    const fixture = await runFixture();
    const { provider } = fakeProvider(new Set(["unrelated-sandbox"]), true);
    expect(await releaseRunSandbox(fixture.orgId, fixture.runId, { provider })).toEqual({
      ok: true,
      released: true,
      sandboxId: fixture.sandboxId,
    });
    expect(await getThreadSandbox(fixture.runId)).toBeNull();
  });

  test("serializes a same-thread reply that starts while provider delete is in flight", async () => {
    const fixture = await runFixture();
    const deleteStarted = Promise.withResolvers<void>();
    const allowDelete = Promise.withResolvers<void>();
    const live = new Set([fixture.sandboxId]);
    const { provider, deleted } = fakeProvider(live);
    provider.get = async (id) => ({
      id,
      cpu: 1,
      memory: 1,
      process: {} as SandboxHandle["process"],
      fs: {} as SandboxHandle["fs"],
      start: async () => {},
      delete: async () => {
        deleteStarted.resolve();
        await allowDelete.promise;
        deleted.push(id);
        live.delete(id);
      },
      getPreviewLink: async () => ({ url: "https://example.invalid" }),
    });

    const release = releaseRunSandbox(fixture.orgId, fixture.runId, { provider });
    await deleteStarted.promise;

    const replyRunId = crypto.randomUUID();
    createdRuns.add(replyRunId);
    let accepted = false;
    const acceptedReply = acceptRunCommand({
      idempotencyKey: null,
      orgId: fixture.orgId,
      actorId: "user-1",
      run: {
        id: replyRunId,
        prompt: "reply during release",
        model: "mock-model",
        engine: "mock",
        parentRunId: fixture.runId,
        threadId: fixture.runId,
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
    }).then((out) => {
      accepted = true;
      return out;
    });

    await Bun.sleep(25);
    expect(accepted).toBe(false);

    allowDelete.resolve();
    expect(await release).toEqual({
      ok: true,
      released: true,
      sandboxId: fixture.sandboxId,
    });
    expect(await acceptedReply).toMatchObject({ status: "created", runId: replyRunId });
    expect(deleted).toEqual([fixture.sandboxId]);
    expect(await getThreadSandbox(fixture.runId)).toBeNull();
  });

  test("a sandbox whose personal connection is gone is unpinned instead of throwing", async () => {
    const { orgId, runId, sandboxId } = await runFixture("completed");
    // Created on a user's own computer, but that user has no connection any more.
    await setRunSandbox(runId, sandboxId, { kind: "box", credential: "user" });
    const result = await releaseRunSandbox(orgId, runId);
    expect(result).toEqual({ ok: true, released: false, reason: "connection_revoked", sandboxId });
    expect(await getThreadSandbox(runId)).toBeNull();
  });

  test("keeps a recorded env-provider mapping when that provider's credentials are unavailable", async () => {
    const { orgId, runId, sandboxId } = await runFixture("completed");
    await setRunSandbox(runId, sandboxId, { kind: "daytona", credential: "env" });
    const previousProvider = process.env.SANDBOX_PROVIDER;
    const previousDaytonaKey = process.env.DAYTONA_API_KEY;
    process.env.SANDBOX_PROVIDER = "cube";
    delete process.env.DAYTONA_API_KEY;
    try {
      expect(await releaseRunSandbox(orgId, runId)).toEqual({
        ok: false,
        reason: "provider_error",
      });
      expect(await getThreadSandbox(runId)).toBe(sandboxId);
    } finally {
      if (previousProvider === undefined) delete process.env.SANDBOX_PROVIDER;
      else process.env.SANDBOX_PROVIDER = previousProvider;
      if (previousDaytonaKey === undefined) delete process.env.DAYTONA_API_KEY;
      else process.env.DAYTONA_API_KEY = previousDaytonaKey;
    }
  });

  test("keeps a recorded mapping when its provider kind is unsupported", async () => {
    const { orgId, runId, sandboxId } = await runFixture("completed");
    await setRunSandbox(runId, sandboxId, { kind: "cube", credential: "env" });
    await db
      .update(runs)
      .set({ sandboxProvider: sql`'retired-provider'` })
      .where(eq(runs.id, runId));

    expect(await releaseRunSandbox(orgId, runId)).toEqual({
      ok: false,
      reason: "provider_error",
    });
    expect(await getThreadSandbox(runId)).toBe(sandboxId);

    await db.update(runs).set({ sandboxCredential: "user" }).where(eq(runs.id, runId));
    expect(await releaseRunSandbox(orgId, runId)).toEqual({
      ok: false,
      reason: "provider_error",
    });
    expect(await getThreadSandbox(runId)).toBe(sandboxId);
  });
});
