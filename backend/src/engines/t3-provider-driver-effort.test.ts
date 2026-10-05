import { describe, expect, test } from "bun:test";
import type { HarnessSession } from "@useagent/agent-harness/canonical";
import { providerProtocolIdentity } from "@useagent/agent-harness/control";
import type { SandboxHandle } from "../sandboxes/provider";
import type { RuntimeEnvironmentRequest } from "./runtime-environment-client";
import { makeT3ProviderDriver } from "./t3-provider-driver";

// The effort accepted on the run reaches the runtime's dispatch payloads: the
// thread the driver creates on start and every turn it steers.

interface Dispatched {
  readonly type: string;
  readonly modelSelection?: {
    readonly instanceId: string;
    readonly model: string;
    readonly options: readonly { id: string; value: string }[];
  };
}

function recordingDriver(engine: "codex" | "claude") {
  const dispatched: Dispatched[] = [];
  const driver = makeT3ProviderDriver(engine, {
    resolveRuntime: async () => ({ id: "cube-t3-effort" }) as SandboxHandle,
    requestEnvironment: async <T>(_sandbox: SandboxHandle, request: RuntimeEnvironmentRequest) => {
      if (request.path === "/api/orchestration/shell") {
        // No project or thread yet: start creates both.
        return { projects: [], threads: [] } as T;
      }
      if (request.method === "POST") {
        dispatched.push(request.payload as unknown as Dispatched);
        // The shell poll after each create sees the created row.
        return {} as T;
      }
      return {} as T;
    },
  });
  const session: HarnessSession = {
    provider: driver.provider,
    nativeSessionId: "skynet-thread-thread-1",
    runtime: { kind: "sandbox", id: "cube-t3-effort" },
    protocolVersion: providerProtocolIdentity(driver.descriptor.protocol),
    capabilities: driver.descriptor.capabilities,
    generation: driver.descriptor.sessionGeneration as number,
  };
  return { driver, session, dispatched };
}

describe("T3 driver reasoning effort dispatch", () => {
  test("a steered Codex turn carries the run's effort as the reasoningEffort option", async () => {
    const { driver, session, dispatched } = recordingDriver("codex");
    const result = await driver.steer({
      runId: "run-1",
      threadId: "thread-1",
      session,
      input: { kind: "prompt", text: "continue", model: "gpt-5.6-luna", reasoningEffort: "high" },
      metadata: { threadId: "thread-1" },
    });
    expect(result).toEqual({ status: "ok" });
    expect(dispatched.map((command) => command.type)).toEqual(["thread.turn.start"]);
    expect(dispatched[0]?.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
  });

  test("a steered Claude Code turn carries it as the effort option; none sends no option", async () => {
    const { driver, session, dispatched } = recordingDriver("claude");
    await driver.steer({
      runId: "run-1",
      threadId: "thread-1",
      session,
      input: { kind: "prompt", text: "continue", model: "claude-opus-5", reasoningEffort: "low" },
      metadata: { threadId: "thread-1" },
    });
    await driver.steer({
      runId: "run-2",
      threadId: "thread-1",
      session,
      input: { kind: "prompt", text: "again", model: "claude-opus-5" },
      metadata: { threadId: "thread-1" },
    });
    expect(dispatched.map((command) => command.modelSelection?.options)).toEqual([
      [{ id: "effort", value: "low" }],
      [],
    ]);
  });
});
