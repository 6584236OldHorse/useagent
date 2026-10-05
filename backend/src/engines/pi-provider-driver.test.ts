import { describe, expect, test } from "bun:test";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import { makePiProviderDriver } from "./pi-provider-driver";
import { PI_BRIDGE_GENERATION } from "./pi-runtime-config";

function harnessSession(nativeSessionId = "/sessions/pi.jsonl"): HarnessSession {
  return {
    provider: "pi",
    nativeSessionId,
    runtime: { kind: "sandbox", id: "box" },
    protocolVersion: "oh-my-pi-rpc/18.0.3",
    capabilities: {} as never,
    generation: PI_BRIDGE_GENERATION,
  };
}

const expectedSandbox = {
  version: 1 as const,
  sandboxId: "box",
  provider: "box" as const,
  credential: "env" as const,
  ownerOrgId: "org-1",
  ownerUserId: null,
  credentialGeneration: "c".repeat(64),
};
const startMetadata = {
  workdir: "/home/user/work",
  runtime: {
    fingerprint: "fingerprint",
    knowledgeTools: true,
    model: { provider: "openai", modelId: "gpt", selector: "openai/gpt" },
    executable: "/home/user/.useagent/pi-runtime/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
    bunExecutable: "/home/user/.useagent/pi-runtime/bin/bun",
    runAsUser: null,
    home: "/home/user/.useagent/pi",
  },
};

describe("Pi provider driver", () => {
  test("re-resolves the accepted sandbox before cached bridge use", async () => {
    const resolutions: unknown[][] = [];
    const ensured: unknown[] = [];
    const commands: unknown[] = [];
    const bridge = {
      sessionId: "pi-id",
      sessionFile: "/sessions/pi.jsonl",
      sandboxId: "box",
      fingerprint: "fingerprint",
      expectedSandbox,
      subscribe: () => () => {},
      command: async (command: unknown) => { commands.push(command); },
      dispose: async () => {},
    };
    const driver = makePiProviderDriver({
      resolveRuntime: async (...args) => {
        resolutions.push(args);
        return { id: "box" } as never;
      },
      bridges: {
        ensure: async (input) => {
          ensured.push(input.expectedSandbox);
          return bridge;
        },
        get: () => bridge,
        awaitTeardown: async () => {},
        remove: async () => {},
      },
    });
    const control = { expectedSandbox, threadId: "thread" };

    await driver.start({
      runId: "run",
      threadId: "thread",
      runtime: harnessSession().runtime,
      metadata: { ...startMetadata, ...control },
    });
    await driver.resume({
      session: harnessSession(),
      metadata: { ...startMetadata, ...control },
    });
    await driver.steer({
      runId: "run",
      threadId: "thread",
      session: harnessSession(),
      input: { kind: "prompt", text: "continue" },
      metadata: control,
    });
    await driver.cancel(harnessSession(), "stop", control);

    expect(resolutions).toHaveLength(4);
    expect(ensured).toEqual([expectedSandbox, expectedSandbox]);
    for (const [runtime, expected, threadId] of resolutions) {
      expect(runtime).toEqual(harnessSession().runtime);
      expect(expected).toEqual(expectedSandbox);
      expect(threadId).toBe("thread");
    }
    expect(commands).toEqual([
      { kind: "prompt", text: "continue", model: undefined },
      { kind: "cancel", reason: "stop" },
    ]);
  });

  test("does not touch a cached bridge from another credential generation", async () => {
    let resolutions = 0;
    let commands = 0;
    const bridge = {
      sessionId: "pi-id",
      sessionFile: "/sessions/pi.jsonl",
      sandboxId: "box",
      fingerprint: "fingerprint",
      expectedSandbox: { ...expectedSandbox, credentialGeneration: "d".repeat(64) },
      subscribe: () => () => {},
      command: async () => { commands += 1; },
      dispose: async () => {},
    };
    const driver = makePiProviderDriver({
      resolveRuntime: async () => {
        resolutions += 1;
        return { id: "box" } as never;
      },
      bridges: {
        ensure: async () => bridge,
        get: () => bridge,
        awaitTeardown: async () => {},
        remove: async () => {},
      },
    });
    const mismatched = harnessSession();

    await expect(driver.steer({
      runId: "run",
      threadId: "thread",
      session: mismatched,
      input: { kind: "prompt", text: "must not dispatch" },
      metadata: { expectedSandbox, threadId: "thread" },
    })).resolves.toMatchObject({ status: "error", code: "expected_sandbox_mismatch" });
    await expect(driver.cancel(
      mismatched,
      "must not cancel",
      { expectedSandbox, threadId: "thread" },
    )).resolves.toMatchObject({ status: "error", code: "expected_sandbox_mismatch" });
    expect(resolutions).toBe(2);
    expect(commands).toBe(0);
  });

  test("advertises constrained native tools with no product approval mediation", () => {
    const driver = makePiProviderDriver();
    expect(driver.descriptor.tools).toEqual({ mode: "provider_native", approval: "none" });
    expect(driver.descriptor.capabilities.approvals).toBe(false);
  });

  test("resumes a persistent native session and forwards follow-up prompts", async () => {
    const commands: unknown[] = [];
    const bridge = {
      sessionId: "pi-id",
      sessionFile: "/sessions/pi.jsonl",
      sandboxId: "box",
      fingerprint: "fingerprint",
      subscribe: () => () => {},
      command: async (command: unknown) => { commands.push(command); },
      dispose: async () => {},
    };
    const driver = makePiProviderDriver({
      resolveRuntime: async () => ({ id: "box" } as never),
      bridges: {
        ensure: async (input) => {
          expect(input.resumeSessionFile).toBe("/sessions/pi.jsonl");
          return bridge;
        },
        get: () => bridge,
        awaitTeardown: async () => {},
        remove: async () => {},
      },
    });
    const resumed = await driver.resume({
      session: harnessSession(),
      metadata: {
        workdir: "/home/user/work",
        runtime: {
          fingerprint: "fingerprint",
          knowledgeTools: true,
          model: { provider: "openai", modelId: "gpt", selector: "openai/gpt" },
          executable: "/home/user/.useagent/pi-runtime/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
          bunExecutable: "/home/user/.useagent/pi-runtime/bin/bun",
          runAsUser: null,
          home: "/home/user/.useagent/pi",
        },
      },
    });
    expect(resumed.status).toBe("ok");
    await driver.steer({
      runId: "run",
      threadId: "thread",
      session: harnessSession(),
      input: { kind: "prompt", text: "continue" },
    });
    expect(commands).toEqual([{ kind: "prompt", text: "continue", model: undefined }]);
  });

  test("cancels the exact live Pi session", async () => {
    const commands: unknown[] = [];
    const bridge = {
      sessionId: "pi-id",
      sessionFile: "/sessions/pi.jsonl",
      sandboxId: "box",
      fingerprint: "fingerprint",
      subscribe: () => () => {},
      command: async (command: unknown) => { commands.push(command); },
      dispose: async () => {},
    };
    const driver = makePiProviderDriver({
      resolveRuntime: async () => null,
      bridges: {
        ensure: async () => bridge,
        get: () => bridge,
        awaitTeardown: async () => {},
        remove: async () => {},
      },
    });
    expect(await driver.cancel(harnessSession(), "user stopped")).toEqual({ status: "ok" });
    expect(commands).toEqual([{ kind: "cancel", reason: "user stopped" }]);
  });

  test("removes the native bridge when Pi rejects cancellation", async () => {
    const removed: string[] = [];
    const bridge = {
      sessionId: "pi-id",
      sessionFile: "/sessions/pi.jsonl",
      sandboxId: "box",
      fingerprint: "fingerprint",
      subscribe: () => () => {},
      command: async () => { throw new Error("abort rejected"); },
      dispose: async () => {},
    };
    const driver = makePiProviderDriver({
      resolveRuntime: async () => null,
      bridges: {
        ensure: async () => bridge,
        get: () => bridge,
        awaitTeardown: async () => {},
        remove: async (sessionFile) => { removed.push(sessionFile); },
      },
    });

    expect(await driver.cancel(harnessSession(), "user stopped")).toEqual({
      status: "error",
      code: "cancel_failed",
      message: "abort rejected",
    });
    expect(removed).toEqual(["/sessions/pi.jsonl"]);
  });
});
