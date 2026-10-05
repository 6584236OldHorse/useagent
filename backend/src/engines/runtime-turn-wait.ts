// Waits for one runtime turn: subscribes to the thread, dispatches the turn on
// the subscribed socket (`start`), and projects every new view of the thread
// until the run settles, then drains a final answer that landed a moment late.
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxHandle } from "../sandboxes/provider";
import type { createSecretRedactor } from "../secrets/redact";
import { refuseReadOnlyRequest, replyToRuntimeApproval, runtimeApprovalRequest } from "./runtime-approval";
import {
  buildRuntimeEnvironmentRequestCommand,
  decodeRuntimeEnvironmentCommandOutput,
  runtimeThreadSnapshotRequest,
} from "./runtime-environment-client";
import { runtimeFirstActivityTimeoutMs, runtimeNoProgressTimeoutMs } from "./runtime-environment";
import { followRuntimeThread } from "./runtime-event-stream";
import { createChildThreadFollower } from "./runtime-child-threads";
import { createForeignRunGuard } from "./runtime-foreign-runs";
import { awaitRuntimeOperation } from "./runtime-operation";
import { isRuntimePlaneMessageId, runtimeThreadId, type RuntimeEngineId, type RuntimeThreadSnapshot } from "./runtime-orchestration";
import { RuntimeFirstActivityTimeoutError } from "./runtime-startup-recovery.js";
import { decodeRuntimeThreadResponse, readRuntimeThreadView } from "./runtime-thread-read";
import { runtimeThreadView } from "./runtime-v2-view";
import { createNoProgressWatchdog } from "./turn-no-progress";
import { watchTurnLiveness } from "./turn-liveness";
import { createTurnProjector, type TurnProjector } from "./turn-projector";
import { RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR, RuntimeTurnFailedError } from "./turn-recovery";
import type { EngineRunContext } from "./types";

const RUNTIME_POLL_INTERVAL_MS = 125;
// The final message can land a moment after the run reports completion; a loaded sandbox needs more than a couple of seconds.
const RUNTIME_TERMINAL_OUTPUT_DRAIN_MS = 15_000;
const RUNTIME_TERMINAL_OUTPUT_DRAIN_SECONDS = 2;
const RUNTIME_TERMINAL_CLEANUP_MS = 250;

export async function readThreadSnapshot(
  ctx: EngineRunContext,
  sandbox: SandboxHandle,
  signal: AbortSignal = ctx.signal,
): Promise<RuntimeThreadSnapshot> {
  return await readRuntimeThreadView(sandbox, runtimeThreadId(ctx), signal);
}

export async function drainRuntimeTerminalOutput(input: {
  readonly initialText: string;
  readonly fallbackText: string;
  readonly signal: AbortSignal;
  readonly readAndApplySnapshot: (signal: AbortSignal) => Promise<string>;
  readonly deadlineSignal?: AbortSignal;
}): Promise<string> {
  let text = input.initialText;
  const deadlineSignal = input.deadlineSignal ?? AbortSignal.timeout(RUNTIME_TERMINAL_OUTPUT_DRAIN_MS);
  const drainSignal = AbortSignal.any([input.signal, deadlineSignal]);

  while (!text.trim()) {
    try {
      input.signal.throwIfAborted();
      await delay(RUNTIME_POLL_INTERVAL_MS, undefined, { signal: drainSignal });
      text = await input.readAndApplySnapshot(drainSignal);
      input.signal.throwIfAborted();
      if (text.trim()) return text;
      deadlineSignal.throwIfAborted();
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      if (deadlineSignal.aborted) {
        if (input.fallbackText.trim()) return input.fallbackText;
        throw new Error(RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR);
      }
      throw error;
    }
  }
  input.signal.throwIfAborted();
  return text;
}

export function createRuntimeTerminalSessionCleanup(
  sandbox: SandboxHandle,
  sessionId: string,
  options: {
    readonly deadlineSignal?: AbortSignal;
    readonly warn?: (message: string, context: Record<string, string>) => void;
  } = {},
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let warned = false;
  return () => {
    if (inFlight) return inFlight;
    const deadline = options.deadlineSignal ?? AbortSignal.timeout(RUNTIME_TERMINAL_CLEANUP_MS);
    const operation: Promise<void> = awaitRuntimeOperation(
      sandbox.process.deleteSession(sessionId), deadline, async () => {},
    ).then(() => {}).catch((error) => {
        if (warned) return;
        warned = true;
        (options.warn ?? ((message, context) => console.warn(message, context)))(
          "[runtime-terminal-drain] session cleanup failed",
          { sessionId, error: error instanceof Error ? error.message : String(error) },
        );
      });
    inFlight = operation.finally(() => {
      inFlight = null;
    });
    return inFlight!;
  };
}

/** A thread read on its own short-lived shell session, bounded for the drain. */
export async function readRuntimeTerminalSnapshot(
  ctx: EngineRunContext,
  sandbox: SandboxHandle,
  signal: AbortSignal,
): Promise<RuntimeThreadSnapshot> {
  const sessionId = `useagent-terminal-drain-${crypto.randomUUID()}`;
  const cleanup = createRuntimeTerminalSessionCleanup(sandbox, sessionId);
  try {
    await awaitRuntimeOperation(sandbox.process.createSession(sessionId), signal, cleanup);
    const result = await awaitRuntimeOperation(
      sandbox.process.executeSessionCommand(sessionId, {
        command: buildRuntimeEnvironmentRequestCommand(runtimeThreadSnapshotRequest(runtimeThreadId(ctx))),
        runAsync: false,
      }, RUNTIME_TERMINAL_OUTPUT_DRAIN_SECONDS),
      signal,
      cleanup,
    );
    const response = decodeRuntimeEnvironmentCommandOutput(
      result.output ?? `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
    if ((result.exitCode ?? 1) !== 0 || response.status === undefined || response.status >= 400) {
      throw new Error("The provider runtime terminal snapshot request failed");
    }
    return runtimeThreadView(decodeRuntimeThreadResponse(JSON.parse(response.body)));
  } finally {
    await cleanup();
  }
}

export interface RuntimeTurnWaitDependencies {
  readonly readThreadSnapshot: typeof readThreadSnapshot;
  readonly followRuntimeThread: typeof followRuntimeThread;
  /** How a read-only run declines a request; the real reply path unless a test injects one. */
  readonly replyToRuntimeApproval?: typeof replyToRuntimeApproval;
  readonly watchLiveness?: typeof watchTurnLiveness;
  readonly guardForeignRuns?: typeof createForeignRunGuard;
  readonly followChildThreads?: typeof createChildThreadFollower;
}

export const runtimeTurnWaitDependencies: RuntimeTurnWaitDependencies = {
  readThreadSnapshot,
  followRuntimeThread,
  replyToRuntimeApproval,
};

export async function waitForRuntimeTurn(
  ctx: EngineRunContext,
  sandbox: SandboxHandle,
  preExistingActivities: ReadonlyMap<string, string>,
  priorSnapshot: RuntimeThreadSnapshot,
  redact: ReturnType<typeof createSecretRedactor>,
  dependencies: RuntimeTurnWaitDependencies = runtimeTurnWaitDependencies,
  engine: RuntimeEngineId | null = null,
  projector: TurnProjector = createTurnProjector({ ctx, redact, engine, seen: preExistingActivities }),
  /** Dispatches the turn; runs once the subscription is live. */
  start?: () => Promise<void>,
): Promise<string> {
  // Single owner of the turn-stream no-progress bound: a provider retry storm
  // (only runtime.warning activities, no tool/text progress) must terminate
  // the run with the real provider reason instead of running forever.
  const watchdog = createNoProgressWatchdog(runtimeNoProgressTimeoutMs(), redact.text);
  // A long-running tool emits no new revisions while it executes, so the
  // stream goes silent even though the turn is making real progress. While the
  // latest view shows an open tool call, tick the watchdog on a timer; provider
  // stalls (no tool running, no text) stay fully guarded.
  let toolInFlight = false;
  const toolHeartbeat = setInterval(() => {
    if (toolInFlight) {
      watchdog.observeProgress();
      ctx.reportActivity?.();
    }
  }, 15_000);
  toolHeartbeat.unref?.();
  // Keeps the sandbox's lifetime clock pushed out while the turn runs; fails the
  // turn only when the sandbox stops answering, never because it is slow.
  const liveness = (dependencies.watchLiveness ?? watchTurnLiveness)(sandbox);
  const threadId = runtimeThreadId(ctx);
  const priorTurnId = priorSnapshot.thread.latestTurn?.turnId ?? null;
  let currentTurnObserved = false;
  const firstActivityDeadline = new AbortController();
  const firstActivityTimer = setTimeout(
    () => firstActivityDeadline.abort(),
    runtimeFirstActivityTimeoutMs(),
  );
  firstActivityTimer.unref?.();
  const streamSignal = AbortSignal.any([
    ctx.signal,
    watchdog.signal,
    firstActivityDeadline.signal,
    liveness.signal,
  ]);
  const guardForeignRuns = (dependencies.guardForeignRuns ?? createForeignRunGuard)({ ctx, sandbox, threadId, signal: ctx.signal });
  // Each subagent's own thread is followed beside the turn and stops with it.
  const children = (dependencies.followChildThreads ?? createChildThreadFollower)({
    ctx, sandbox, parentThreadId: threadId, redact, signal: streamSignal,
  });
  // A read-only run answers the runtime's own approval requests itself: every
  // command and file change is declined the moment it is recorded, through the
  // same reply path a person uses, so the sandbox never writes and the record
  // shows the refusal. Reads pass; a person may still answer those.
  const refusedRequests = new Set<string>();
  const observe = async (activity: RuntimeThreadSnapshot["thread"]["activities"][number]): Promise<void> => {
    watchdog.observeActivity(activity);
    if (ctx.permissionMode !== "read-only") return;
    const request = runtimeApprovalRequest(activity, threadId);
    if (!request || refusedRequests.has(request.id)) return;
    refusedRequests.add(request.id);
    const refused = await refuseReadOnlyRequest({
      runId: ctx.runId,
      threadId: ctx.threadId ?? ctx.runId,
      sessionId: threadId,
      request,
      signal: ctx.signal,
      expectedSandbox: ctx.expectedSandbox ?? null,
    }, dependencies.replyToRuntimeApproval);
    if (refused) await ctx.emit(refused.step);
  };
  const applySnapshot = async (snapshot: RuntimeThreadSnapshot): Promise<boolean> => {
    const applied = await projector.apply(snapshot, observe);
    toolInFlight = applied.toolInFlight;
    if (applied.delta) watchdog.observeProgress();
    if (applied.error) throw new RuntimeTurnFailedError(applied.error);
    return !applied.settled;
  };
  const acceptSnapshot = async (snapshot: RuntimeThreadSnapshot): Promise<boolean> => {
    const latest = snapshot.thread.latestTurn;
    if (!currentTurnObserved) {
      // The turn is the plane's run that followed the prior one; a run started
      // by anything else is never taken for it.
      if (!latest || latest.turnId === priorTurnId || !isRuntimePlaneMessageId(latest.userMessageId)) return true;
      currentTurnObserved = true;
      clearTimeout(firstActivityTimer);
    }
    return await applySnapshot(snapshot);
  };

  let streamError: unknown;
  try {
    await dependencies.followRuntimeThread({
      sandbox,
      threadId,
      signal: streamSignal,
      ...(start ? { start } : {}),
      applySnapshot: async (snapshot, source) => {
        await guardForeignRuns(source.projection);
        children.observe(source.projection);
        return await acceptSnapshot(snapshot);
      },
      onHeard: liveness.heard,
    });
  } catch (error) {
    streamError = error;
  } finally {
    clearTimeout(firstActivityTimer);
    clearInterval(toolHeartbeat);
    liveness.dispose();
    watchdog.dispose();
    await children.close();
  }
  if (watchdog.signal.aborted) throw watchdog.signal.reason;
  ctx.signal.throwIfAborted();
  if (liveness.signal.aborted) throw liveness.signal.reason;
  if (firstActivityDeadline.signal.aborted && !currentTurnObserved) {
    throw new RuntimeFirstActivityTimeoutError(runtimeFirstActivityTimeoutMs());
  }
  if (streamError) throw streamError;
  if (!currentTurnObserved) {
    throw new Error("Provider thread subscription ended before the dispatched turn was observed");
  }
  return await drainRuntimeTerminalOutput({
    initialText: projector.finalText,
    fallbackText: projector.publishedText,
    signal: ctx.signal,
    readAndApplySnapshot: async (drainSignal) => {
      await applySnapshot(await readRuntimeTerminalSnapshot(ctx, sandbox, drainSignal));
      return projector.finalText;
    },
  });
}
