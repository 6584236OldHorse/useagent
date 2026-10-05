import type { HarnessRuntime, HarnessSession } from "@useagent/agent-harness/canonical";
import type {
  HarnessAdapter,
  HarnessOperationResult,
  HarnessSessionHandle,
  ProviderDriver,
  ProviderStartRequest,
} from "@useagent/agent-harness/control";
import {
  providerDriverHarnessCapabilities,
  providerDriverUnsupported,
  providerProtocolIdentity,
  providerSessionMatchesDriver,
} from "@useagent/agent-harness/control";
import { type SandboxHandle } from "../sandboxes/provider";
import { sessionCapabilities } from "./capabilities";
import {
  piBridgeManager,
  piBridgeMatchesExpectedSandbox,
  type PiBridgeManager,
  type PiBridgeSession,
} from "./pi-rpc-bridge";
import {
  PI_BRIDGE_GENERATION,
  PI_CODING_AGENT_VERSION,
  type PreparedPiRuntime,
} from "./pi-runtime-config";
import {
  ExpectedSandboxMismatchError,
  resolveExpectedSandbox,
  resolveSandboxBindingForSandbox,
} from "../sandboxes/binding";
import {
  parseExpectedSandboxBinding,
  type ExpectedSandboxBinding,
} from "../sandboxes/expected-binding";

interface PiStartMetadata {
  readonly workdir: string;
  readonly runtime: PreparedPiRuntime;
}

function metadata(value: Record<string, unknown> | undefined): PiStartMetadata | null {
  const workdir = value?.workdir;
  const runtime = value?.runtime as PreparedPiRuntime | undefined;
  return typeof workdir === "string" && workdir.startsWith("/") &&
    typeof runtime?.fingerprint === "string" &&
    typeof runtime?.knowledgeTools === "boolean" &&
    typeof runtime?.model?.selector === "string" &&
    typeof runtime?.executable === "string" && runtime.executable.startsWith("/") &&
    typeof runtime?.bunExecutable === "string" && runtime.bunExecutable.startsWith("/") &&
    (runtime?.runAsUser === null || (typeof runtime?.runAsUser === "string" && runtime.runAsUser.length > 0)) &&
    typeof runtime?.home === "string" && runtime.home.startsWith("/")
    ? { workdir, runtime }
    : null;
}

function error(code: string, message: string) {
  return { status: "error" as const, code, message };
}

async function resolveRuntime(
  runtime: HarnessRuntime,
  expected?: ExpectedSandboxBinding,
  threadId?: string,
): Promise<SandboxHandle | null> {
  if (runtime.kind !== "sandbox") return null;
  if (expected) return await resolveExpectedSandbox(expected, threadId!);
  try {
    return await (await resolveSandboxBindingForSandbox(runtime.id)).provider.get(runtime.id);
  } catch {
    return null;
  }
}

function canonicalSession(
  runtime: HarnessRuntime,
  bridge: PiBridgeSession,
  knowledgeTools: boolean,
): HarnessSession {
  return {
    provider: "pi",
    // Pi's persistent JSONL file is the native resume handle. The ephemeral
    // in-process session id is intentionally not durable authority.
    nativeSessionId: bridge.sessionFile,
    runtime,
    protocolVersion: providerProtocolIdentity(piProviderDriver.descriptor.protocol),
    capabilities: sessionCapabilities("pi", {
      desktop: false,
      knowledgeTools,
    }),
    generation: PI_BRIDGE_GENERATION,
  };
}

export interface PiProviderDriverDependencies {
  readonly resolveRuntime: typeof resolveRuntime;
  readonly bridges: PiBridgeManager;
}

const defaults: PiProviderDriverDependencies = {
  resolveRuntime,
  bridges: piBridgeManager,
};

async function resolveDriverRuntime(
  dependencies: PiProviderDriverDependencies,
  runtime: HarnessRuntime,
  control?: Record<string, unknown>,
  threadId = typeof control?.threadId === "string" ? control.threadId : undefined,
): Promise<SandboxHandle | null> {
  const expected = parseExpectedSandboxBinding(control?.expectedSandbox);
  if (expected && (
    runtime.kind !== "sandbox" ||
    runtime.id !== expected.sandboxId ||
    !threadId
  )) {
    throw new ExpectedSandboxMismatchError();
  }
  const sandbox = expected
    ? await dependencies.resolveRuntime(runtime, expected, threadId)
    : await dependencies.resolveRuntime(runtime);
  if (expected && sandbox?.id !== expected.sandboxId) {
    throw new ExpectedSandboxMismatchError();
  }
  return sandbox;
}

export function makePiProviderDriver(
  dependencies: PiProviderDriverDependencies = defaults,
): ProviderDriver {
  const capabilities = sessionCapabilities("pi", {
    desktop: false,
    knowledgeTools: true,
  });
  const driver: ProviderDriver = {
    provider: "pi",
    descriptor: {
      provider: "pi",
      protocol: { name: "oh-my-pi-rpc", version: PI_CODING_AGENT_VERSION },
      sessionGeneration: PI_BRIDGE_GENERATION,
      capabilities,
      lifecycle: {
        operations: ["start", "resume", "steer", "cancel"],
        steerInputs: ["prompt", "command"],
      },
      model: { selection: "per_turn", supportsArbitraryModel: false },
      // Pi executes only the explicitly allowlisted read/write/bash/task tools
      // as the dedicated unprivileged sandbox user. There is no product approval
      // mediation in this bridge, so auto-approval is advertised honestly.
      tools: { mode: "provider_native", approval: "none" },
    },

    async start(request: ProviderStartRequest) {
      const start = metadata(request.metadata);
      if (!start) return error("invalid_start_metadata", "Pi start metadata is incomplete");
      let expected: ExpectedSandboxBinding | null = null;
      let sandbox: SandboxHandle | null;
      if (request.metadata?.expectedSandbox != null) {
        try {
          expected = parseExpectedSandboxBinding(request.metadata.expectedSandbox);
          sandbox = await resolveDriverRuntime(
            dependencies,
            request.runtime,
            request.metadata,
            request.threadId,
          );
        } catch (cause) {
          return error(
            cause instanceof ExpectedSandboxMismatchError ? cause.code : "session_create_failed",
            cause instanceof Error ? cause.message : "Pi start failed",
          );
        }
      } else {
        sandbox = await dependencies.resolveRuntime(request.runtime);
      }
      if (!sandbox) return error("runtime_unreachable", "Pi sandbox is unreachable");
      try {
        const bridge = await dependencies.bridges.ensure({
          sandbox,
          workdir: start.workdir,
          runtime: start.runtime,
          ...(expected ? { expectedSandbox: expected } : {}),
        });
        return { status: "ok", value: canonicalSession(request.runtime, bridge, start.runtime.knowledgeTools) };
      } catch (cause) {
        return error(
          cause instanceof ExpectedSandboxMismatchError ? cause.code : "session_create_failed",
          cause instanceof Error ? cause.message : "Pi start failed",
        );
      }
    },

    async resume(request) {
      if (!providerSessionMatchesDriver(driver, request.session)) {
        return error("stale_session", "Pi session protocol or generation is stale");
      }
      const start = metadata(request.metadata);
      if (!start) return error("invalid_start_metadata", "Pi resume metadata is incomplete");
      let expected: ExpectedSandboxBinding | null = null;
      let sandbox: SandboxHandle | null;
      if (request.metadata?.expectedSandbox != null) {
        try {
          expected = parseExpectedSandboxBinding(request.metadata.expectedSandbox);
          sandbox = await resolveDriverRuntime(
            dependencies,
            request.session.runtime,
            request.metadata,
          );
        } catch (cause) {
          return error(
            cause instanceof ExpectedSandboxMismatchError ? cause.code : "session_resume_failed",
            cause instanceof Error ? cause.message : "Pi resume failed",
          );
        }
      } else {
        sandbox = await dependencies.resolveRuntime(request.session.runtime);
      }
      if (!sandbox) return error("runtime_unreachable", "Pi sandbox is unreachable");
      try {
        const bridge = await dependencies.bridges.ensure({
          sandbox,
          workdir: start.workdir,
          runtime: start.runtime,
          resumeSessionFile: request.session.nativeSessionId,
          ...(expected ? { expectedSandbox: expected } : {}),
        });
        return {
          status: "ok",
          value: canonicalSession(request.session.runtime, bridge, start.runtime.knowledgeTools),
        };
      } catch (cause) {
        return error(
          cause instanceof ExpectedSandboxMismatchError ? cause.code : "session_resume_failed",
          cause instanceof Error ? cause.message : "Pi resume failed",
        );
      }
    },

    async steer(request): Promise<HarnessOperationResult> {
      if (!providerSessionMatchesDriver(driver, request.session)) {
        return error("stale_session", "Pi session protocol or generation is stale");
      }
      try {
        const expected = parseExpectedSandboxBinding(request.metadata?.expectedSandbox);
        const sandbox = expected
          ? await resolveDriverRuntime(
              dependencies,
              request.session.runtime,
              request.metadata,
              request.threadId,
            )
          : null;
        const bridge = dependencies.bridges.get(request.session.nativeSessionId);
        if (!bridge) return error("session_unreachable", "Pi RPC session is not live");
        if (sandbox && expected && !piBridgeMatchesExpectedSandbox(bridge, expected)) {
          const mismatch = new ExpectedSandboxMismatchError();
          return error(mismatch.code, mismatch.message);
        }
        if (request.input.kind === "prompt") {
          const delivery = request.metadata?.delivery;
          if (delivery === "steer") {
            await bridge.command({ kind: "steer", text: request.input.text });
          } else if (delivery === "follow_up") {
            await bridge.command({ kind: "follow_up", text: request.input.text });
          } else {
            await bridge.command({ kind: "prompt", text: request.input.text, model: request.input.model });
          }
        } else if (request.input.kind === "command") {
          const suffix = request.input.arguments?.trim();
          await bridge.command({
            kind: "prompt",
            text: `/${request.input.name}${suffix ? ` ${suffix}` : ""}`,
          });
        } else {
          return {
            status: "unsupported_capability",
            provider: "pi",
            capability: request.input.kind,
          };
        }
        return { status: "ok" };
      } catch (cause) {
        return error(
          cause instanceof ExpectedSandboxMismatchError ? cause.code : "steer_failed",
          cause instanceof Error ? cause.message : "Pi steer failed",
        );
      }
    },

    async cancel(session, reason, control): Promise<HarnessOperationResult> {
      if (!providerSessionMatchesDriver(driver, session)) {
        return error("stale_session", "Pi session protocol or generation is stale");
      }
      let sandbox: SandboxHandle | null = null;
      let expected: ExpectedSandboxBinding | null = null;
      try {
        expected = parseExpectedSandboxBinding(control?.expectedSandbox);
        if (expected) {
          sandbox = await resolveDriverRuntime(dependencies, session.runtime, control);
        }
      } catch (cause) {
        return error(
          cause instanceof ExpectedSandboxMismatchError ? cause.code : "cancel_failed",
          cause instanceof Error ? cause.message : "Pi cancel failed",
        );
      }
      const bridge = dependencies.bridges.get(session.nativeSessionId);
      if (!bridge) return error("session_unreachable", "Pi RPC session is not live");
      if (sandbox && expected && !piBridgeMatchesExpectedSandbox(bridge, expected)) {
        const mismatch = new ExpectedSandboxMismatchError();
        return error(mismatch.code, mismatch.message);
      }
      try {
        await bridge.command({ kind: "cancel", reason });
        return { status: "ok" };
      } catch (cause) {
        try {
          await dependencies.bridges.remove(session.nativeSessionId);
        } catch (cleanupCause) {
          return error(
            "cancel_cleanup_failed",
            cleanupCause instanceof Error
              ? cleanupCause.message
              : "Pi cancel cleanup failed",
          );
        }
        return error("cancel_failed", cause instanceof Error ? cause.message : "Pi cancel failed");
      }
    },
  };
  return driver;
}

export const piProviderDriver = makePiProviderDriver();

function sessionFromHandle(handle: HarnessSessionHandle): HarnessSession {
  return {
    provider: "pi",
    nativeSessionId: handle.sessionId,
    runtime: { kind: "sandbox", id: handle.sandboxId },
    protocolVersion:
      handle.protocol ?? providerProtocolIdentity(piProviderDriver.descriptor.protocol),
    capabilities: piProviderDriver.descriptor.capabilities,
    generation: handle.generation ?? PI_BRIDGE_GENERATION,
  };
}

/** Compatibility control route used by restart recovery and stop callers that
 * still consume HarnessAdapter. Resume remains a ProviderDriver operation;
 * in-flight reconcile after a backend restart is explicitly unsupported. */
export const piHarness: HarnessAdapter = {
  provider: "pi",
  capabilities: () => providerDriverHarnessCapabilities(piProviderDriver),
  cancel(handle, reason, metadata) {
    return piProviderDriver.cancel(sessionFromHandle(handle), reason, metadata);
  },
  reconcile() {
    return Promise.resolve(providerDriverUnsupported(
      "pi",
      "reconcile",
      "Pi resumes persisted JSONL sessions on the next turn but cannot reconstruct an in-flight stream after restart",
    ));
  },
};
