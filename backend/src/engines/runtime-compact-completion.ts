import { recordProviderEvent, runSettlementFence } from "../runs/provider-events";
import type { SecretRedactor } from "../secrets/redact";
import type { SandboxHandle } from "../sandboxes/provider";
import type { followRuntimeThread } from "./runtime-event-stream";
import {
  runtimeActivityProviderEvent,
  runtimeActivityRevision,
  runtimeThreadId,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";
import { RuntimeTurnFailedError } from "./turn-recovery";
import type { EngineRunContext } from "./types";
import {
  COMPACT_TIMED_OUT_WAITING_SUMMARY,
  RUNTIME_COMPACT_TIMEOUT_MS,
} from "./runtime-compact-contract";

const SANDBOX_KEEPALIVE_MS = 5 * 60_000;

interface RuntimeCompactWaitDependencies {
  readonly followRuntimeThread: typeof followRuntimeThread;
  readonly recordProviderEvent?: typeof recordProviderEvent;
}

function runtimeCompactOutcome(
  activity: RuntimeThreadSnapshot["thread"]["activities"][number],
  requestId: string,
): { readonly completed: boolean; readonly failure: string | null } | null {
  if (!activity.payload || typeof activity.payload !== "object") return null;
  const payload = activity.payload as Readonly<Record<string, unknown>>;
  if (payload.requestId !== requestId) return null;
  if (activity.kind === "context-compaction" && payload.state === "compacted") {
    return { completed: true, failure: null };
  }
  return null;
}

/** The compact run's own end, when it settled without a compaction item: a
 *  completed maintenance run compacted; any other end is its failure. */
function runtimeCompactRunOutcome(
  snapshot: RuntimeThreadSnapshot,
  requestId: string,
): { readonly completed: boolean; readonly failure: string | null } | null {
  const turn = snapshot.thread.latestTurn;
  if (!turn || turn.userMessageId !== requestId || turn.state === "running") return null;
  if (turn.state === "completed") return { completed: true, failure: null };
  return { completed: false, failure: turn.error ?? snapshot.thread.session?.lastError ?? "The provider runtime compact command failed" };
}

export async function waitForRuntimeCompact(
  ctx: EngineRunContext,
  sandbox: SandboxHandle,
  priorSnapshot: RuntimeThreadSnapshot,
  redact: Pick<SecretRedactor, "text" | "unknown">,
  requestId: string,
  dependencies: RuntimeCompactWaitDependencies,
  /** Dispatches the compact command; runs once the subscription is live. */
  start?: () => Promise<void>,
): Promise<string> {
  const deadline = AbortSignal.timeout(RUNTIME_COMPACT_TIMEOUT_MS);
  const signal = AbortSignal.any([ctx.signal, deadline]);
  const threadId = runtimeThreadId(ctx);
  const seen = new Map(
    priorSnapshot.thread.activities.map((activity) => [activity.id, runtimeActivityRevision(activity)]),
  );
  let completed = false;
  let failure: string | null = null;
  let streamError: unknown;
  const keepAlive = setInterval(() => {
    void sandbox.keepAlive?.().catch(() => {});
  }, SANDBOX_KEEPALIVE_MS);
  keepAlive.unref?.();
  try {
    await dependencies.followRuntimeThread({
      sandbox,
      threadId,
      signal,
      ...(start ? { start } : {}),
      applySnapshot: async (snapshot) => {
        ctx.reportActivity?.();
        for (const activity of snapshot.thread.activities) {
          const outcome = runtimeCompactOutcome(activity, requestId);
          if (!outcome) continue;
          const revision = runtimeActivityRevision(activity);
          if (seen.get(activity.id) !== revision) {
            seen.set(activity.id, revision);
            await (dependencies.recordProviderEvent ?? recordProviderEvent)(
              runtimeActivityProviderEvent(ctx, threadId, activity, redact),
              { fence: runSettlementFence(ctx.runId) },
            );
          }
          completed = outcome.completed;
          failure = outcome.failure;
          if (completed || failure) return false;
        }
        const ended = runtimeCompactRunOutcome(snapshot, requestId);
        if (!ended) return true;
        completed = ended.completed;
        failure = ended.failure;
        return false;
      },
    });
  } catch (error) {
    streamError = error;
  } finally {
    clearInterval(keepAlive);
  }
  ctx.signal.throwIfAborted();
  if (deadline.aborted) throw new Error(COMPACT_TIMED_OUT_WAITING_SUMMARY);
  if (failure) throw new RuntimeTurnFailedError(failure);
  if (streamError) throw streamError;
  if (!completed) throw new Error("The provider thread subscription ended before compact completed");
  return "Compacted";
}
