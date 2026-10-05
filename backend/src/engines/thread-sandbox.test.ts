import { describe, expect, test } from "bun:test";
import {
  DaytonaAuthenticationError,
  DaytonaForbiddenError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
} from "@daytona/sdk";
import { BoxApiError } from "@useagent/sandbox-box";
import { SandboxNotFoundError } from "@useagent/sandbox-contract";
import { readFileSync } from "node:fs";
import { acquireThreadSandbox, resolveRetainedSandbox, reviveRetainedSandbox, RetainedSandboxRuntimeMismatchError, sandboxHasRequiredLabels } from "./thread-sandbox";
import type { EngineRunContext } from "./types";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  MachineNotConnectedError,
  PersonalSandboxConnectionUnavailableError,
  sandboxBindingExpectation,
  type SandboxBinding,
} from "../sandboxes/binding";
import { forgetLiveThreadSandbox, rememberLiveThreadSandbox } from "./sandbox-runtime";

describe("shared thread sandbox lease", () => {
  test("a collaborator's reply on a thread placed on a machine reuses the retained sandbox without being asked for a machine of their own", async () => {
    const retainedSandbox = { id: "local:rn_a:c1", state: "started", cpu: 64, memory: 256, labels: {} } as unknown as SandboxHandle;
    const machine: SandboxBinding = { kind: "local", provider: {} as SandboxBinding["provider"], snapshot: null, credential: "user", userId: "owner", logins: [] };
    const ctx = { runId: "run-b", threadId: "thread-a", orgId: "org", userId: "collaborator", runLocation: "local", emit: async () => undefined } as unknown as EngineRunContext;
    let fresh = 0;
    const persisted: unknown[] = [];
    const dependencies = {
      retained: async () => ({ sandbox: retainedSandbox, binding: machine }),
      bindingForThread: async (): Promise<SandboxBinding> => { throw new Error("no fence on this run"); },
      bindingForRun: async (): Promise<SandboxBinding> => { fresh++; throw new MachineNotConnectedError(); },
      persist: async (runId: string, sandboxId: string, record: unknown) => { persisted.push([runId, sandboxId, record]); },
    };
    try {
      const lease = await acquireThreadSandbox(ctx, { snapshot: "snap", chip: "runtime:codex" }, dependencies);
      expect(lease.sandbox).toBe(retainedSandbox);
      expect(lease.binding).toBe(machine);
      expect(lease.reused).toBe(true);
      expect(fresh).toBe(0);
      expect(persisted).toEqual([["run-b", "local:rn_a:c1", { kind: "local", credential: "user" }]]);
      // With nothing retained the thread's choice is asked of the collaborator and fails plainly, never the cloud.
      await expect(acquireThreadSandbox(ctx, { snapshot: "snap", chip: "runtime:codex" }, { ...dependencies, retained: async () => null }))
        .rejects.toBeInstanceOf(MachineNotConnectedError);
      expect(fresh).toBe(1);
    } finally {
      forgetLiveThreadSandbox("thread-a", retainedSandbox.id);
    }
  });

  test("constrained revival verifies owner and connection before lookup and bypasses ID-only cache", async () => {
    let lookedUp = 0;
    const fresh = { id: "pinned", state: "started" } as SandboxHandle;
    const provider = {
      connectionFingerprint: "1".repeat(64),
      get: async () => { lookedUp++; return fresh; },
    } as unknown as SandboxBinding["provider"];
    const original: SandboxBinding = {
      kind: "cube", provider, snapshot: null, credential: "env", userId: null, logins: [],
    };
    const expected = sandboxBindingExpectation(original, "org", fresh.id);
    for (const changed of [
      { binding: { ...original, kind: "daytona" as const }, expected },
      { binding: { ...original, credential: "user" as const, userId: "owner", connectionUpdatedAt: "2026-09-07T00:00:00Z" }, expected },
      { binding: original, expected: { ...expected, ownerOrgId: "another-org" } },
      { binding: { ...original, provider: { ...provider, connectionFingerprint: "2".repeat(64) } }, expected },
    ]) {
      await expect(reviveRetainedSandbox(
        { threadId: "pinned-thread", orgId: "org", expectedSandbox: changed.expected } as EngineRunContext,
        fresh.id, { chip: "runtime:codex" },
        { threadBinding: async () => changed.binding, sandboxBinding: async () => changed.binding, credentialsCurrent: async () => true },
      )).rejects.toThrow("accepted sandbox binding");
    }
    expect(lookedUp).toBe(0);
    rememberLiveThreadSandbox("pinned-thread", { ...fresh } as SandboxHandle);
    try {
      const result = await reviveRetainedSandbox(
        { threadId: "pinned-thread", orgId: "org", expectedSandbox: expected } as EngineRunContext,
        fresh.id, { chip: "runtime:codex" },
        { threadBinding: async () => original, sandboxBinding: async () => original, credentialsCurrent: async () => true },
      );
      expect(result.sandbox).toBe(fresh);
      expect(lookedUp).toBe(1);
    } finally {
      forgetLiveThreadSandbox("pinned-thread", fresh.id);
    }
    const personal = { ...original, credential: "user" as const, userId: "owner", connectionUpdatedAt: "2026-09-07T00:00:00Z" };
    expect(sandboxBindingExpectation(personal, "org", fresh.id).credentialGeneration)
      .not.toBe(sandboxBindingExpectation({ ...personal, connectionUpdatedAt: "2026-09-07T01:00:00Z" }, "org", fresh.id).credentialGeneration);
  });

  test("a constrained run rejects missing, replaced, or deleted retained sandboxes without fallback", async () => {
    for (const mapped of [null, "replacement", "expected"]) {
      let revivals = 0;
      let forgotten = 0;
      await expect(resolveRetainedSandbox(
        {
          threadId: "expected-thread", orgId: "org",
          expectedSandbox: {
            version: 1, sandboxId: "expected", provider: "cube", credential: "env",
            ownerOrgId: "org", ownerUserId: null, credentialGeneration: "a".repeat(64),
          },
        } as EngineRunContext,
        { snapshot: "native", chip: "runtime:codex" },
        {
          getSandboxId: async () => mapped,
          revive: async () => { revivals++; throw new SandboxNotFoundError(); },
          forget: () => { forgotten++; },
        },
      )).rejects.toThrow("accepted sandbox binding");
      expect(revivals).toBe(mapped === "expected" ? 1 : 0);
      expect(forgotten).toBe(0);
    }
  });

  test("persists the run mapping before returning a sandbox to an engine", () => {
    const source = readFileSync(new URL("./thread-sandbox.ts", import.meta.url), "utf8");
    const persist = source.indexOf("await persistSandboxBeforeExecution({");
    const returned = source.indexOf("return {\n    sandbox,");
    expect(persist).toBeGreaterThan(0);
    expect(returned).toBeGreaterThan(persist);
  });

  test("preserves files and mapping when retained credentials require migration", async () => {
    const files = new Map([["draft.txt", "unpublished work"]]);
    let forgotten = 0;
    let deleted = 0;
    const sandbox = {
      id: "credential-old", state: "started",
      delete: async () => { deleted++; files.clear(); },
    } as unknown as SandboxHandle;
    const binding = { kind: "cube", provider: { get: async () => sandbox } } as unknown as SandboxBinding;
    await expect(resolveRetainedSandbox(
      { threadId: "credential-thread", orgId: "org" } as EngineRunContext,
      { snapshot: "native", chip: "runtime:codex" },
      {
        getSandboxId: async () => sandbox.id,
        revive: (ctx, id, options) => reviveRetainedSandbox(ctx, id, options, {
          threadBinding: async () => binding,
          sandboxBinding: async () => binding,
          credentialsCurrent: async () => false,
        }),
        forget: () => { forgotten++; },
      },
    )).rejects.toThrow("credential-isolation");
    expect(deleted).toBe(0);
    expect(forgotten).toBe(0);
    expect(files.get("draft.txt")).toBe("unpublished work");
  });

  test("a started retained sandbox's warm checks start alongside its credential check, a paused one's never", async () => {
    const events: string[] = [];
    const credentials = Promise.withResolvers<boolean>();
    const started = { id: "warm-started", state: "started" } as unknown as SandboxHandle;
    const paused = { id: "warm-paused", state: "paused", start: async () => { events.push("resumed"); } } as unknown as SandboxHandle;
    const reviveOne = (sandbox: SandboxHandle, credentialsCurrent: () => Promise<boolean>) => {
      const binding = { kind: "cube", provider: { get: async () => sandbox } } as unknown as SandboxBinding;
      return reviveRetainedSandbox(
        { threadId: `thread-${sandbox.id}`, orgId: "org", emit: async () => undefined } as unknown as EngineRunContext,
        sandbox.id,
        { chip: "runtime:codex", onStarted: (warm, warmBinding) => events.push(`warm:${warm.id}:${warmBinding.kind}`) },
        { threadBinding: async () => binding, sandboxBinding: async () => binding, credentialsCurrent },
      );
    };

    const revived = reviveOne(started, () => {
      events.push("credentials");
      return credentials.promise;
    });
    await Bun.sleep(0);
    // The warm checks are issued before the credential check has decided.
    expect(events).toEqual(["warm:warm-started:cube", "credentials"]);
    credentials.resolve(true);
    expect((await revived).sandbox).toBe(started);

    events.length = 0;
    await reviveOne(paused, async () => true);
    expect(events).toEqual(["resumed"]);
  });

  test("preserves retained mappings for revoked credentials, auth failures, and unknown errors", async () => {
    for (const error of [
      new PersonalSandboxConnectionUnavailableError("the personal connection was revoked"),
      new DaytonaAuthenticationError("authentication failed", 401),
      new DaytonaForbiddenError("access forbidden", 403),
      new BoxApiError(401, "unauthorized", "invalid credential"),
      new DaytonaRateLimitError("provider busy", 429),
      new DaytonaServiceUnavailableError("provider unavailable", 503),
      new Error("unknown transport failure"),
      // A typed 404 from credential validation is not proof that the physical sandbox is absent.
      new DaytonaNotFoundError("credential validation endpoint missing", 404),
    ]) {
      let forgotten = 0;
      await expect(resolveRetainedSandbox(
        { threadId: "thread-preserved" } as EngineRunContext,
        { snapshot: "native", chip: "runtime:codex" },
        {
          getSandboxId: async () => "retained-sandbox",
          revive: async () => { throw error; },
          forget: () => { forgotten += 1; },
        },
      )).rejects.toBe(error);
      expect(forgotten).toBe(0);
    }
  });

  test("forgets a retained mapping only after the provider proves physical absence", async () => {
    let forgotten = 0;
    await expect(resolveRetainedSandbox(
      { threadId: "thread-physical-missing", orgId: "org-1" } as EngineRunContext,
      { snapshot: "native", chip: "runtime:codex" },
      {
        getSandboxId: async () => "retained-sandbox",
        revive: async () => { throw new SandboxNotFoundError(); },
        forget: () => { forgotten += 1; },
      },
    )).resolves.toBeNull();
    expect(forgotten).toBe(1);
  });

  test("does not treat typed 404s from resume or credential probes as physical absence", async () => {
    for (const failurePoint of ["start", "credentials"] as const) {
      let forgotten = 0;
      const error = new DaytonaNotFoundError(`${failurePoint} probe file missing`, 404);
      const sandbox = {
        id: "retained-sandbox",
        state: failurePoint === "start" ? "stopped" : "started",
        start: async () => {
          if (failurePoint === "start") throw error;
        },
      } as unknown as SandboxHandle;
      const binding = {
        kind: "daytona",
        provider: { get: async () => sandbox },
      } as unknown as SandboxBinding;
      await expect(resolveRetainedSandbox(
        {
          threadId: "thread-probe-404",
          orgId: "org-1",
          emit: async () => undefined,
        } as unknown as EngineRunContext,
        { snapshot: "native", chip: "runtime:codex" },
        {
          getSandboxId: async () => sandbox.id,
          revive: (ctx, id, options) => reviveRetainedSandbox(ctx, id, options, {
            threadBinding: async () => binding,
            sandboxBinding: async () => binding,
            credentialsCurrent: async () => {
              if (failurePoint === "credentials") throw error;
              return true;
            },
          }),
          forget: () => { forgotten += 1; },
        },
      )).rejects.toBe(error);
      expect(forgotten).toBe(0);
    }
  });

  test("does not discard a retained workspace to satisfy a larger resource target", async () => {
    let deleted = 0;
    let forgotten = 0;
    const sandbox = { id: "small-retained", cpu: 2, memory: 4, delete: async () => { deleted++; } } as unknown as SandboxHandle;
    await expect(resolveRetainedSandbox(
      { threadId: "resource-thread" } as EngineRunContext,
      { snapshot: "native", chip: "runtime:codex", minimumResources: { cpu: 4, memory: 8 } },
      {
        getSandboxId: async () => sandbox.id,
        revive: async () => ({ sandbox, binding: { kind: "cube" } as SandboxBinding }),
        forget: () => { forgotten++; },
      },
    )).rejects.toThrow("resource upgrade");
    expect(deleted).toBe(0);
    expect(forgotten).toBe(0);
  });

  test("preserves unpublished workspace data on incompatible upgrade and rollback", async () => {
    const required = { "useagent.runtime": "useagent-runtime-v8" };
    expect(sandboxHasRequiredLabels({ labels: required }, required)).toBe(true);
    for (const generation of ["useagent-runtime-v7", "useagent-runtime-v9"]) {
      const files = new Map([["draft.txt", "unpublished work"]]);
      let deleted = 0;
      let forgotten = 0;
      const sandbox = {
        id: "retained-sandbox",
        labels: { "useagent.runtime": generation },
        delete: async () => { deleted++; files.clear(); },
      } as unknown as SandboxHandle;
      await expect(resolveRetainedSandbox(
        { threadId: "thread-preserved" } as EngineRunContext,
        { snapshot: "native", chip: "runtime:codex", requiredLabels: required },
        {
          getSandboxId: async () => sandbox.id,
          revive: async () => ({ sandbox, binding: { kind: "cube" } as SandboxBinding }),
          forget: () => { forgotten++; },
        },
      )).rejects.toBeInstanceOf(RetainedSandboxRuntimeMismatchError);
      expect(deleted).toBe(0);
      expect(forgotten).toBe(0);
      expect(files.get("draft.txt")).toBe("unpublished work");
    }
  });

  test("reuses a compatible retained workspace without replacing its identity", async () => {
    const sandbox = { id: "existing", labels: { "useagent.runtime": "useagent-runtime-v8" } } as unknown as SandboxHandle;
    const binding = { kind: "box" } as SandboxBinding;
    const result = await resolveRetainedSandbox(
      { threadId: "thread-preserved" } as EngineRunContext,
      { snapshot: "native", chip: "runtime:codex", requiredLabels: sandbox.labels },
      { getSandboxId: async () => sandbox.id, revive: async () => ({ sandbox, binding }), forget: () => {} },
    );
    expect(result?.sandbox).toBe(sandbox);
    expect(result?.binding).toBe(binding);
  });

  test("records a named warm-pool claim as reuse", () => {
    const source = readFileSync(new URL("./thread-sandbox.ts", import.meta.url), "utf8");
    expect(source).toContain("claimCubeWarmSandbox(options.warmPool || undefined)");
    expect(source).toContain("reused = sandbox !== null");
  });

  test("records standardized sandbox acquisition timing outcomes", () => {
    const source = readFileSync(new URL("./thread-sandbox.ts", import.meta.url), "utf8");
    expect(source).toContain("RUN_TIMING_STAGES.sandboxRetained");
    expect(source).toContain("RUN_TIMING_STAGES.sandboxWarmPool");
    expect(source).toContain("RUN_TIMING_STAGES.sandboxCreate");
    expect(source).toContain("RUN_TIMING_OUTCOMES.hit");
    expect(source).toContain("RUN_TIMING_OUTCOMES.miss");
    expect(source).toContain("RUN_TIMING_OUTCOMES.success");
    expect(source).toContain("RUN_TIMING_OUTCOMES.failure");
  });
});
