// Follows the subagent threads a turn spawns. A provider-native subagent runs
// in its own runtime thread, and its tool calls and messages stream only on
// that thread, so each child the parent names gets its own follower. What the
// child does is recorded on the parent's run, owned by the child, exactly as
// the plane records a child's work from any engine. A child never fails its
// parent's turn, and the parent never waits on a child: when the turn ends its
// children stop following, after the writes already in flight land.
import { setTimeout as delay } from "node:timers/promises";
import { CaptureFenceError, recordProviderEvent, runSettlementFence } from "../runs/provider-events";
import type { SandboxHandle } from "../sandboxes/provider";
import type { SecretRedactor } from "../secrets/redact";
import { followRuntimeThread } from "./runtime-event-stream";
import { runtimeActivityProviderEvent, runtimeActivityRevision } from "./runtime-orchestration";
import { runtimeChildThreadActivities } from "./runtime-v2-view";
import type { V2Projection } from "./runtime-v2-wire";
import type { EngineRunContext } from "./types";

/** How long the end of a turn waits for its children's in-flight writes. */
const CHILD_DRAIN_MS = 2_000;

export interface ChildThreadFollowerDependencies {
  readonly follow: typeof followRuntimeThread;
  readonly record: typeof recordProviderEvent;
}

export interface ChildThreadFollower {
  /** Starts a follower for every subagent thread the parent names that is not followed yet. */
  observe(projection: V2Projection): void;
  /** Stops every child follower; resolves once their in-flight writes land or the drain bound passes. */
  close(): Promise<void>;
}

export function createChildThreadFollower(input: {
  readonly ctx: Pick<EngineRunContext, "runId" | "threadId">;
  readonly sandbox: SandboxHandle;
  readonly parentThreadId: string;
  readonly redact: Pick<SecretRedactor, "text" | "unknown">;
  readonly signal: AbortSignal;
  readonly dependencies?: ChildThreadFollowerDependencies;
}): ChildThreadFollower {
  const { follow, record } = input.dependencies ?? { follow: followRuntimeThread, record: recordProviderEvent };
  const children = new Map<string, { readonly controller: AbortController; readonly done: Promise<void> }>();
  const revisions = new Map<string, string>();
  let closed = false;

  const start = (childThreadId: string) => {
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const done = follow({
      sandbox: input.sandbox,
      threadId: childThreadId,
      signal,
      applySnapshot: async (_view, source) => {
        for (const activity of runtimeChildThreadActivities(source, input.parentThreadId)) {
          const revision = runtimeActivityRevision(activity);
          if (revisions.get(activity.id) === revision) continue;
          revisions.set(activity.id, revision);
          await record(
            runtimeActivityProviderEvent(input.ctx, input.parentThreadId, activity, input.redact),
            { fence: runSettlementFence(input.ctx.runId) },
          );
        }
        return true;
      },
    }).catch((error: unknown) => {
      // A settled run takes no more writes; a stopped child is the normal end.
      if (error instanceof CaptureFenceError || signal.aborted) return;
      console.warn(
        `[runtime] subagent thread ${childThreadId} of ${input.parentThreadId} stopped following: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    });
    children.set(childThreadId, { controller, done });
  };

  return {
    observe(projection) {
      if (closed) return;
      for (const item of projection.turnItems) {
        const childThreadId = typeof item.childThreadId === "string" ? item.childThreadId.trim() : "";
        if (item.type === "subagent" && childThreadId && !children.has(childThreadId)) start(childThreadId);
      }
    },
    async close() {
      closed = true;
      for (const child of children.values()) child.controller.abort();
      const drained = Promise.allSettled([...children.values()].map((child) => child.done));
      await Promise.race([drained, delay(CHILD_DRAIN_MS)]);
    },
  };
}
