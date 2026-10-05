import type { HarnessRuntime, HarnessSession } from "@useagent/agent-harness/canonical";
import { turnRunIds } from "./turn-recovery";
import { runtimeRootMessageBatches } from "./runtime-root-messages";
import {
  providerProtocolIdentity,
  providerDriverUnsupported,
  providerSessionMatchesDriver,
  type HarnessInterimEvent,
  type HarnessOperationResult,
  type HarnessReconciliation,
  type ProviderDriver,
  type ProviderReconcileRequest,
  type ProviderStartRequest,
} from "@useagent/agent-harness/control";
import { type SandboxHandle } from "../sandboxes/provider";
import { sessionCapabilities } from "./capabilities";
import {
  isRuntimeEnvironmentMissingSessionError,
  requestRuntimeEnvironment,
  RuntimeEnvironmentRequestError,
} from "./runtime-environment-client";
import { RUNTIME_GENERATION } from "./runtime-environment";
import {
  assistantText,
  buildRuntimeProjectCreateCommand,
  buildRuntimeThreadCreateCommand,
  buildRuntimeTurnInterruptCommand,
  buildRuntimeTurnStartCommand,
  runtimeProjectId,
  runtimeThreadId,
  runtimeActivityProviderEvent,
  runtimeUserMessageId,
  type RuntimeEngineId,
  type RuntimeMode,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";
import {
  ExpectedSandboxMismatchError,
  PersonalSandboxConnectionUnavailableError,
  resolveExpectedSandbox,
  resolveSandboxBindingForSandbox,
  sandboxForBinding,
} from "../sandboxes/binding";
import { forgetLiveSandbox } from "./sandbox-runtime";
import { compactCommandIdentityIsCurrent } from "./runtime-compact-contract";
import {
  parseExpectedSandboxBinding,
  type ExpectedSandboxBinding,
} from "../sandboxes/expected-binding";

// Bumped with the memory rules in the fresh-session prefix: a session bound before
// them is stale, so its next turn starts fresh and reads them once.
export const T3_SESSION_GENERATION = 3;

interface RuntimeShellSnapshot {
  readonly projects: readonly { readonly id: string }[];
  readonly threads: readonly { readonly id: string }[];
}

interface T3StartMetadata {
  readonly workspaceRoot: string;
  readonly runtimeMode: RuntimeMode;
  readonly createdAt: string;
  /** The shell the caller read just before starting, so the start does not read it again. */
  readonly shell?: RuntimeShellSnapshot;
}

function isRuntimeShellSnapshot(value: unknown): value is RuntimeShellSnapshot {
  const shell = value as Partial<RuntimeShellSnapshot> | null;
  return typeof shell === "object" && shell !== null && Array.isArray(shell.projects) && Array.isArray(shell.threads);
}

function isRuntimeMode(value: unknown): value is RuntimeMode {
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access";
}

function steerRuntimeMode(metadata: Record<string, unknown> | undefined): RuntimeMode {
  return isRuntimeMode(metadata?.runtimeMode) ? metadata.runtimeMode : "full-access";
}

function steerCreatedAt(metadata: Record<string, unknown> | undefined): string {
  return typeof metadata?.createdAt === "string" ? metadata.createdAt : new Date().toISOString();
}

function t3StartMetadata(metadata: Record<string, unknown> | undefined): T3StartMetadata | null {
  const workspaceRoot = metadata?.workspaceRoot;
  const runtimeMode = metadata?.runtimeMode;
  const createdAt = metadata?.createdAt;
  const shell = isRuntimeShellSnapshot(metadata?.shell) ? metadata.shell : undefined;
  return typeof workspaceRoot === "string" &&
    workspaceRoot.startsWith("/") &&
    isRuntimeMode(runtimeMode) &&
    typeof createdAt === "string"
    ? { workspaceRoot, runtimeMode, createdAt, ...(shell ? { shell } : {}) }
    : null;
}

function driverError(code: string, message: string): {
  readonly status: "error";
  readonly code: string;
  readonly message: string;
} {
  return { status: "error", code, message };
}

async function resolveRuntime(
  runtime: HarnessRuntime,
  expected?: ExpectedSandboxBinding,
  threadId?: string,
): Promise<SandboxHandle | null> {
  if (runtime.kind !== "sandbox") return null;
  if (expected) return await resolveExpectedSandbox(expected, threadId!);
  return await sandboxForBinding(await resolveSandboxBindingForSandbox(runtime.id), runtime.id);
}

interface T3ProviderDriverDependencies {
  readonly resolveRuntime: typeof resolveRuntime;
  readonly requestEnvironment: typeof requestRuntimeEnvironment;
}

const defaultT3ProviderDriverDependencies = {
  resolveRuntime,
  requestEnvironment: requestRuntimeEnvironment,
} satisfies T3ProviderDriverDependencies;

async function resolveDriverRuntime(
  dependencies: T3ProviderDriverDependencies,
  runtime: HarnessRuntime,
  metadata?: Record<string, unknown>,
  threadId?: string,
): Promise<SandboxHandle | null> {
  try {
    const expected = parseExpectedSandboxBinding(metadata?.expectedSandbox);
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
  } catch (error) {
    if (
      error instanceof PersonalSandboxConnectionUnavailableError ||
      error instanceof ExpectedSandboxMismatchError
    ) throw error;
    throw new Error("The provider runtime sandbox could not be resolved", { cause: error });
  }
}

/**
 * Run one driver operation on the runtime sandbox. The resolve may hand back a
 * handle this process already verified; one that fails before the runtime
 * answers is dropped and the operation runs once more on a full resolve. Every
 * operation here is safe to repeat: reads are reads, and T3 answers a repeated
 * command id with the receipt of the first.
 */
async function withDriverRuntime<T>(
  dependencies: T3ProviderDriverDependencies,
  runtime: HarnessRuntime,
  metadata: Record<string, unknown> | undefined,
  threadId: string | undefined,
  signal: AbortSignal,
  operation: (sandbox: SandboxHandle) => Promise<T>,
): Promise<T | null> {
  const sandbox = await resolveDriverRuntime(dependencies, runtime, metadata, threadId);
  if (!sandbox) return null;
  try {
    return await operation(sandbox);
  } catch (error) {
    if (signal.aborted || error instanceof RuntimeEnvironmentRequestError || !forgetLiveSandbox(sandbox)) throw error;
  }
  const fresh = await resolveDriverRuntime(dependencies, runtime, metadata, threadId);
  return fresh ? await operation(fresh) : null;
}

function session(
  driver: ProviderDriver,
  runtime: HarnessRuntime,
  nativeSessionId: string,
): HarnessSession {
  return {
    provider: driver.provider,
    nativeSessionId,
    runtime,
    protocolVersion: providerProtocolIdentity(driver.descriptor.protocol),
    capabilities: driver.descriptor.capabilities,
    generation: T3_SESSION_GENERATION,
  };
}

async function readThreadSnapshot(
  dependencies: T3ProviderDriverDependencies,
  currentSession: HarnessSession,
  signal: AbortSignal,
  metadata?: Record<string, unknown>,
  threadId?: string,
): Promise<{ readonly sandbox: SandboxHandle; readonly snapshot: RuntimeThreadSnapshot } | null> {
  return await withDriverRuntime(dependencies, currentSession.runtime, metadata, threadId, signal, async (sandbox) => ({
    sandbox,
    snapshot: await dependencies.requestEnvironment<RuntimeThreadSnapshot>(
      sandbox,
      {
        method: "GET",
        path: `/api/orchestration/threads/${encodeURIComponent(currentSession.nativeSessionId)}`,
      },
      signal,
    ),
  }));
}

function snapshotMatchesAcceptedRun(
  snapshot: RuntimeThreadSnapshot,
  runId: string,
): boolean {
  const latestTurn = snapshot.thread.latestTurn;
  if (!latestTurn) return false;
  // The run answers for its highest accepted attempt: the continuation the
  // plane sent, if the runtime accepted one, else the run's own message. A
  // continuation that has not started yet leaves the run pending; the
  // original's completed turn is not its answer. The runtime may leave a
  // message's turn id unset; each attempt is requested at its own time, and
  // the turn carries that time.
  const attempts = turnRunIds(runId).map((id) => runtimeUserMessageId(id));
  const latest = attempts
    .map((id) => snapshot.thread.messages.find((message) => message.role === "user" && message.id === id))
    .filter((message) => message !== undefined)
    .at(-1);
  if (!latest) return false;
  if (latest.turnId !== null) return latest.turnId === latestTurn.turnId;
  if (!latest.createdAt || !latestTurn.requestedAt) return false;
  const acceptedAt = Date.parse(latest.createdAt);
  const requestedAt = Date.parse(latestTurn.requestedAt);
  return Number.isFinite(acceptedAt) && acceptedAt === requestedAt;
}

function reconciledRuntimeEvents(
  snapshot: RuntimeThreadSnapshot,
  currentSession: HarnessSession,
  checkpoint: ProviderReconcileRequest["checkpoint"],
): HarnessInterimEvent[] | undefined {
  const latestTurnId = snapshot.thread.latestTurn?.turnId;
  const context = checkpoint?.eventContext;
  if (!latestTurnId || !context) return undefined;
  // Every turn the run owns: its own message's, each continuation's, and the
  // latest. A first turn whose events were lost before the continuation is
  // restored with it.
  const ownedMessageIds = new Set(turnRunIds(context.runId).map((id) => runtimeUserMessageId(id)));
  const ownedTurnIds = new Set<string>([latestTurnId]);
  for (const message of snapshot.thread.messages) {
    if (message.role === "user" && ownedMessageIds.has(message.id) && message.turnId !== null) ownedTurnIds.add(message.turnId);
  }
  const activities = snapshot.thread.activities
    .filter((activity) => activity.turnId !== null && ownedTurnIds.has(activity.turnId))
    .map((activity) => reconciledRuntimeActivity(activity, currentSession, context));
  const messages = runtimeRootMessageBatches({
    runId: context.runId, threadId: context.threadId, sessionId: currentSession.nativeSessionId,
    userMessageIds: [...ownedMessageIds], redact: context.redact.text,
  }, snapshot).flat().map((event): HarnessInterimEvent => ({
    id: event.id, runScopedId: true, provider: event.provider, eventType: event.eventType,
    sessionId: event.nativeSessionId, parentSessionId: event.nativeParentSessionId,
    messageId: event.nativeMessageId, partId: event.nativePartId, callId: event.nativeCallId,
    payload: event.payload,
  }));
  return [...messages, ...activities];
}

function reconciledRuntimeActivity(
  activity: RuntimeThreadSnapshot["thread"]["activities"][number],
  currentSession: HarnessSession,
  context: NonNullable<NonNullable<ProviderReconcileRequest["checkpoint"]>["eventContext"]>,
): HarnessInterimEvent {
  const event = runtimeActivityProviderEvent(
    { runId: context.runId, threadId: context.threadId },
    currentSession.nativeSessionId,
    activity,
    context.redact,
  );
  return {
    id: event.id,
    runScopedId: true,
    provider: event.provider,
    eventType: event.eventType,
    sessionId: event.nativeSessionId,
    parentSessionId: event.nativeParentSessionId,
    messageId: event.nativeMessageId,
    partId: event.nativePartId,
    callId: event.nativeCallId,
    payload: event.payload,
  };
}

function compactReconciliation(
  snapshot: RuntimeThreadSnapshot,
  currentSession: HarnessSession,
  checkpoint: ProviderReconcileRequest["checkpoint"],
  engine: RuntimeEngineId,
): HarnessReconciliation | null {
  const context = checkpoint?.eventContext;
  const command = context?.nativeCommand;
  if (!context || command?.name !== "compact") return null;
  if (!compactCommandIdentityIsCurrent(command, engine, currentSession)) {
    return { status: "failed", summary: "The accepted native command identity is stale" };
  }
  const requestId = runtimeUserMessageId(context.runId);
  const activity = snapshot.thread.activities.findLast((candidate) => {
    if (!candidate.payload || typeof candidate.payload !== "object") return false;
    const payload = candidate.payload as Readonly<Record<string, unknown>>;
    return payload.requestId === requestId && (
      (candidate.kind === "context-compaction" && payload.state === "compacted") ||
      candidate.kind === "provider.turn.start.failed"
    );
  });
  if (!activity) return { status: "in_progress" };
  const events = [reconciledRuntimeActivity(activity, currentSession, context)];
  if (activity.kind === "context-compaction") {
    return { status: "completed", summary: "Compacted", events };
  }
  const payload = activity.payload as Readonly<Record<string, unknown>>;
  const summary = [payload.detail, payload.error, payload.message, payload.reason].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  ) ?? "The provider runtime compact command failed";
  return { status: "failed", summary: context.redact.text(summary), events };
}

export function makeT3ProviderDriver(
  engine: RuntimeEngineId,
  dependencies: T3ProviderDriverDependencies = defaultT3ProviderDriverDependencies,
): ProviderDriver {
  const capabilities = sessionCapabilities(engine, {
    desktop: false,
    knowledgeTools: true,
    runtimeOrchestration: true,
  });
  const driver: ProviderDriver = {
    provider: engine,
    descriptor: {
      provider: engine,
      protocol: { name: "t3-orchestration", version: RUNTIME_GENERATION },
      sessionGeneration: T3_SESSION_GENERATION,
      capabilities,
      lifecycle: {
        operations: ["start", "resume", "reconcile", "steer", "cancel"],
        steerInputs: ["prompt"],
      },
      model: { selection: "per_turn", supportsArbitraryModel: true },
      tools: { mode: "useagent_brokered", approval: "useagent" },
    },

    async start(request: ProviderStartRequest) {
      const metadata = t3StartMetadata(request.metadata);
      if (!metadata) {
        return driverError(
          "invalid_start_metadata",
          "The provider runtime start requires workspaceRoot, runtimeMode, and createdAt metadata",
        );
      }
      const signal = request.signal ?? AbortSignal.timeout(30_000);
      const ctx = {
        runId: request.runId,
        threadId: request.threadId,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
      };
      try {
        const projectId = runtimeProjectId(ctx);
        const threadId = runtimeThreadId(ctx);
        // T3 projects a dispatched command inside the transaction that accepts
        // it, so an accepted create is already in the shell: no read-back poll.
        const started = await withDriverRuntime(dependencies, request.runtime, request.metadata, request.threadId, signal, async (sandbox) => {
          const shell = metadata.shell ?? await dependencies.requestEnvironment<RuntimeShellSnapshot>(
            sandbox,
            { method: "GET", path: "/api/orchestration/shell" },
            signal,
          );
          if (!shell.projects.some((project) => project.id === projectId)) {
            await dependencies.requestEnvironment(
              sandbox,
              {
                method: "POST",
                path: "/api/orchestration/dispatch",
                payload: buildRuntimeProjectCreateCommand(ctx, metadata.workspaceRoot, metadata.createdAt),
              },
              signal,
            );
          }
          if (!shell.threads.some((thread) => thread.id === threadId)) {
            await dependencies.requestEnvironment(
              sandbox,
              {
                method: "POST",
                path: "/api/orchestration/dispatch",
                payload: buildRuntimeThreadCreateCommand(
                  ctx,
                  engine,
                  metadata.createdAt,
                  metadata.runtimeMode,
                ),
              },
              signal,
            );
          }
          return true;
        });
        if (!started) {
          return driverError("runtime_unreachable", "The provider runtime sandbox is unreachable");
        }
        return { status: "ok", value: session(driver, request.runtime, threadId) };
      } catch (error) {
        return driverError(
          error instanceof ExpectedSandboxMismatchError
            ? error.code
            : "session_create_failed",
          error instanceof Error ? error.message : "unknown provider runtime session create error",
        );
      }
    },

    async resume(request) {
      if (!providerSessionMatchesDriver(driver, request.session)) {
        return driverError("stale_session", "Provider runtime session protocol or generation is stale");
      }
      try {
        const result = await readThreadSnapshot(
          dependencies,
          request.session,
          request.signal ?? AbortSignal.timeout(10_000),
          request.metadata,
          typeof request.metadata?.threadId === "string" ? request.metadata.threadId : undefined,
        );
        if (!result) return driverError("runtime_unreachable", "The provider runtime sandbox is unreachable");
        const { snapshot } = result;
        return snapshot.thread.id === request.session.nativeSessionId
          ? { status: "ok", value: request.session }
          : driverError("session_invalid", "The provider runtime thread identity changed");
      } catch (error) {
        return driverError(
          error instanceof ExpectedSandboxMismatchError
            ? error.code
            : isRuntimeEnvironmentMissingSessionError(error)
            ? "session_invalid"
            : "session_resume_failed",
          error instanceof Error ? error.message : "The provider runtime thread is not available",
        );
      }
    },

    async reconcile(request) {
      if (!providerSessionMatchesDriver(driver, request.session)) {
        return providerDriverUnsupported(
          engine,
          "reconcile",
          "Provider runtime session protocol or generation is stale",
        );
      }
      try {
        const result = await readThreadSnapshot(
          dependencies,
          request.session,
          request.signal ?? AbortSignal.timeout(10_000),
          request.metadata,
          request.checkpoint?.eventContext?.threadId,
        );
        if (!result) return { status: "unreachable" };
        const { snapshot } = result;
        const context = request.checkpoint?.eventContext;
        const compact = compactReconciliation(snapshot, request.session, request.checkpoint, engine);
        if (compact) return compact;
        if (!context || !snapshotMatchesAcceptedRun(snapshot, context.runId)) {
          return { status: "no_change" };
        }
        const state = snapshot.thread.latestTurn?.state;
        const events = reconciledRuntimeEvents(snapshot, request.session, request.checkpoint);
        if (state === "running") return { status: "in_progress", events };
        if (state === "completed") {
          return {
            status: "completed",
            summary: context.redact.text(assistantText(snapshot)).trim() || "Run completed",
            events,
          };
        }
        if (state === "error" || state === "interrupted") {
          const fallback = state === "error"
            ? "The provider runtime turn failed"
            : "The provider runtime turn was interrupted";
          return {
            status: "failed",
            summary: context.redact.text(snapshot.thread.session?.lastError?.trim() || fallback),
            events,
          };
        }
        return { status: "no_change" };
      } catch (error) {
        if (error instanceof ExpectedSandboxMismatchError) {
          return { status: "failed", summary: error.message };
        }
        return { status: "unreachable" };
      }
    },

    async steer(request): Promise<HarnessOperationResult> {
      if (!providerSessionMatchesDriver(driver, request.session)) {
        return driverError("stale_session", "Provider runtime session protocol or generation is stale");
      }
      if (request.input.kind !== "prompt") {
        return providerDriverUnsupported(
          engine,
          "steer",
          "The provider runtime currently accepts prompt steering through this seam",
        );
      }
      const input = request.input;
      try {
        const signal = request.signal ?? AbortSignal.timeout(30_000);
        const dispatched = await withDriverRuntime(dependencies, request.session.runtime, request.metadata, request.threadId, signal, async (sandbox) => {
          await dependencies.requestEnvironment(
            sandbox,
            {
              method: "POST",
              path: "/api/orchestration/dispatch",
              payload: buildRuntimeTurnStartCommand(
                {
                  runId: request.runId,
                  threadId: request.threadId,
                  model: input.model,
                  reasoningEffort: input.reasoningEffort,
                },
                engine,
                input.text,
                steerCreatedAt(request.metadata),
                false,
                steerRuntimeMode(request.metadata),
              ),
            },
            signal,
          );
          return true;
        });
        if (!dispatched) {
          return driverError("runtime_unreachable", "The provider runtime sandbox is unreachable");
        }
        return { status: "ok" };
      } catch (error) {
        return driverError(
          error instanceof ExpectedSandboxMismatchError ? error.code : "steer_failed",
          error instanceof Error ? error.message : "unknown provider runtime steer error",
        );
      }
    },

    async cancel(currentSession, _reason, metadata): Promise<HarnessOperationResult> {
      if (!providerSessionMatchesDriver(driver, currentSession)) {
        return driverError("stale_session", "Provider runtime session protocol or generation is stale");
      }
      try {
        const signal = AbortSignal.timeout(10_000);
        const result = await readThreadSnapshot(
          dependencies,
          currentSession,
          signal,
          metadata,
          typeof metadata?.threadId === "string" ? metadata.threadId : undefined,
        );
        if (!result) return driverError("runtime_unreachable", "The provider runtime sandbox is unreachable");
        const { sandbox, snapshot } = result;
        await dependencies.requestEnvironment(
          sandbox,
          {
            method: "POST",
            path: "/api/orchestration/dispatch",
            payload: buildRuntimeTurnInterruptCommand(
              currentSession.nativeSessionId,
              snapshot.thread.latestTurn?.turnId,
            ),
          },
          signal,
        );
        return { status: "ok" };
      } catch (error) {
        return driverError(
          error instanceof ExpectedSandboxMismatchError ? error.code : "cancel_failed",
          error instanceof Error ? error.message : "unknown provider runtime cancel error",
        );
      }
    },
  };
  return driver;
}

export const t3ProviderDrivers: Readonly<Record<RuntimeEngineId, ProviderDriver>> = {
  codex: makeT3ProviderDriver("codex"),
  claude: makeT3ProviderDriver("claude"),
  opencode: makeT3ProviderDriver("opencode"),
};
