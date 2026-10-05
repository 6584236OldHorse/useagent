import { awaitRuntimeOperation } from "./runtime-operation";
import { RuntimeEnvironmentRequestError, requestRuntimeEnvironment, runtimeThreadSnapshotRequest } from "./runtime-environment-client";
import type { SandboxHandle } from "../sandboxes/provider";
import { setTimeout as delay } from "node:timers/promises";

const RUNTIME_POLL_INTERVAL_MS = 125;
const OPENCODE_CONFIG_RELOAD_DEADLINE_MS = 10_000;

function stableId(prefix: string, value: string): string {
  return `${prefix}-${value}`.replace(/[^a-zA-Z0-9._~-]/g, "-");
}

/** A plain stop. The plane runs one turn per thread and stops a session only
 *  while preparing that turn, after reading it idle, so no turn can start on the
 *  thread between the read and the stop. */
export function buildRuntimeSessionStopCommand(
  threadId: string,
  createdAt = new Date().toISOString(),
  revision: string = crypto.randomUUID(),
): Readonly<Record<string, unknown>> {
  return {
    type: "thread.session.stop",
    commandId: stableId("skynet-session-stop", `${revision}-${threadId}`),
    threadId,
    createdAt,
  };
}

/** The runtime declined the stop. A conditional stop (`onlyIfSettled`, still
 *  sent by an older plane) is declined unless the thread was settled, and a
 *  declined command id stays declined. Either way no stop happened, and neither
 *  is the current turn's failure. The HTTP dispatch route answers every refused command with one
 *  body and no cause, `{_tag: "EnvironmentInternalError", reason:
 *  "orchestration_dispatch_failed"}`, so for this command it reads as declined;
 *  a body that names its cause (`{reason, cause: {_tag, commandType, commandId}}`)
 *  is judged by that cause. */
export function runtimeDeclinedSessionStop(error: unknown): boolean {
  if (!(error instanceof RuntimeEnvironmentRequestError)) return false;
  const cause = error.response?.cause;
  if (cause === undefined) {
    return error.status === 500 &&
      error.response?._tag === "EnvironmentInternalError" &&
      error.response.reason === "orchestration_dispatch_failed";
  }
  if (!cause || typeof cause !== "object") return false;
  const { _tag, commandType, commandId } = cause as Record<string, unknown>;
  if (_tag === "OrchestrationCommandInvariantError") return commandType === "thread.session.stop";
  if (_tag === "OrchestrationCommandPreviouslyRejectedError") {
    return typeof commandId === "string" && commandId.startsWith("skynet-session-stop-");
  }
  return false;
}

export interface OpenCodeSessionReloadDependencies {
  readonly requestEnvironment: typeof requestRuntimeEnvironment;
  readonly wait: (signal: AbortSignal) => Promise<void>;
}

const openCodeSessionReloadDependencies: OpenCodeSessionReloadDependencies = {
  requestEnvironment: requestRuntimeEnvironment,
  async wait(signal) {
    await delay(RUNTIME_POLL_INTERVAL_MS, undefined, { signal });
  },
};

const awaitReloadOperation = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> =>
  awaitRuntimeOperation(operation, signal, async () => {});

const OPENCODE_RELOAD_SESSION_STATUSES = new Set([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);

function reloadThreadState(
  value: unknown,
  expectedThreadId: string,
): { readonly latestTurnRunning: boolean; readonly sessionStatus: string | null } {
  const isoDate = (candidate: unknown): boolean =>
    typeof candidate === "string" && Number.isFinite(Date.parse(candidate));
  const nullableIsoDate = (candidate: unknown): boolean => candidate === null || isoDate(candidate);
  const nullableTrimmedString = (candidate: unknown): boolean =>
    candidate === null || (typeof candidate === "string" && candidate.trim().length > 0);
  if (!value || typeof value !== "object") {
    throw new Error("OpenCode retained thread snapshot is malformed");
  }
  const thread = (value as { thread?: unknown }).thread;
  if (
    !thread ||
    typeof thread !== "object" ||
    (thread as { id?: unknown }).id !== expectedThreadId ||
    !Object.hasOwn(thread, "latestTurn") ||
    !Object.hasOwn(thread, "session")
  ) {
    throw new Error("OpenCode retained thread snapshot is malformed");
  }
  const latestTurn = (thread as { latestTurn: unknown }).latestTurn;
  if (
    latestTurn !== null &&
    (!latestTurn ||
      typeof latestTurn !== "object" ||
      typeof (latestTurn as { turnId?: unknown }).turnId !== "string" ||
      (latestTurn as { turnId: string }).turnId.trim().length === 0 ||
      !["running", "completed", "interrupted", "error"].includes(
        String((latestTurn as { state?: unknown }).state),
      ) ||
      !isoDate((latestTurn as { requestedAt?: unknown }).requestedAt) ||
      !nullableIsoDate((latestTurn as { startedAt?: unknown }).startedAt) ||
      !nullableIsoDate((latestTurn as { completedAt?: unknown }).completedAt) ||
      !nullableTrimmedString((latestTurn as { assistantMessageId?: unknown }).assistantMessageId))
  ) {
    throw new Error("OpenCode retained thread snapshot is malformed");
  }
  const session = (thread as { session: unknown }).session;
  if (session === null) {
    return {
      latestTurnRunning: latestTurn !== null &&
        (latestTurn as { state: string }).state === "running",
      sessionStatus: null,
    };
  }
  if (!session || typeof session !== "object") {
    throw new Error("OpenCode retained session snapshot is malformed");
  }
  const record = session as Record<string, unknown>;
  if (
    record.threadId !== expectedThreadId ||
    typeof record.status !== "string" ||
    !OPENCODE_RELOAD_SESSION_STATUSES.has(record.status) ||
    !nullableTrimmedString(record.providerName) ||
    !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(
      String(record.runtimeMode),
    ) ||
    !nullableTrimmedString(record.activeTurnId) ||
    !nullableTrimmedString(record.lastError) ||
    !isoDate(record.updatedAt)
  ) {
    throw new Error("OpenCode retained session snapshot is malformed");
  }
  return {
    latestTurnRunning: latestTurn !== null &&
      (latestTurn as { state: string }).state === "running",
    sessionStatus: record.status,
  };
}

/** Stops an idle retained OpenCode session so it restarts with the changed model
 *  limits. Resolves true when the limits are applied (the session is stopped or
 *  there was none), false when the runtime declined the stop: the
 *  turn then runs on the retained session as it is, the refresh stays
 *  unacknowledged, and a later turn tries again. Every attempt is its own
 *  command with its own id and time: the runtime remembers a declined command
 *  id for good. */
export async function reloadRetainedOpenCodeSession(input: {
  readonly sandbox: SandboxHandle;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly threadExists: boolean;
  readonly modelLimitsChanged: boolean;
  readonly modelLimitsRevision?: string | null;
  readonly deadlineMs?: number;
  readonly dependencies?: OpenCodeSessionReloadDependencies;
}): Promise<boolean> {
  if (!input.threadExists || !input.modelLimitsChanged) return true;
  if (!input.modelLimitsRevision) {
    throw new Error("OpenCode model-limit refresh command state is missing");
  }

  const dependencies = input.dependencies ?? openCodeSessionReloadDependencies;
  const deadline = AbortSignal.timeout(input.deadlineMs ?? OPENCODE_CONFIG_RELOAD_DEADLINE_MS);
  const signal = AbortSignal.any([input.signal, deadline]);
  const readThread = async () => reloadThreadState(await awaitReloadOperation(
    dependencies.requestEnvironment<unknown>(
      input.sandbox,
      runtimeThreadSnapshotRequest(input.threadId),
      signal,
    ),
    signal,
  ), input.threadId);

  try {
    let state = await readThread();
    if (state.latestTurnRunning) {
      throw new Error("OpenCode model limits changed while the retained native turn is running");
    }
    if (state.sessionStatus === "running" || state.sessionStatus === "starting") {
      throw new Error(`OpenCode model limits changed while the retained session is ${state.sessionStatus}`);
    }
    if (state.sessionStatus === null || state.sessionStatus === "stopped") return true;

    try {
      await awaitReloadOperation(
        dependencies.requestEnvironment(
          input.sandbox,
          {
            method: "POST",
            path: "/api/orchestration/dispatch",
            payload: buildRuntimeSessionStopCommand(
              input.threadId,
              undefined,
              `${input.modelLimitsRevision}-${crypto.randomUUID()}`,
            ),
          },
          signal,
        ),
        signal,
      );
    } catch (error) {
      input.signal.throwIfAborted();
      deadline.throwIfAborted();
      if (runtimeDeclinedSessionStop(error)) {
        console.warn(
          `[opencode] the runtime declined the session stop for ${input.threadId}; ` +
            `the retained session keeps its model limits until a later turn: ${(error as Error).message}`,
        );
        return false;
      }
      state = await readThread();
      if (state.latestTurnRunning || state.sessionStatus === "running" || state.sessionStatus === "starting") {
        throw new Error("OpenCode retained session reactivated before the stop");
      }
      if (state.sessionStatus !== "stopped") throw error;
    }
    while (state.sessionStatus !== "stopped") {
      await awaitReloadOperation(dependencies.wait(signal), signal);
      state = await readThread();
      if (state.latestTurnRunning || state.sessionStatus === "running" || state.sessionStatus === "starting") {
        throw new Error("OpenCode retained session became active while waiting for stop");
      }
      if (state.sessionStatus === null) {
        throw new Error("OpenCode retained session disappeared before stop was confirmed");
      }
    }
    return true;
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (deadline.aborted) {
      throw new Error("Timed out waiting for the retained OpenCode session to stop");
    }
    throw error;
  }
}
