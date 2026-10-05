// The runtime never runs work the plane did not admit. Every run the plane
// starts carries one of its own messages; a run started by anything else (a
// background wake, a restart continuation) has not passed admission or spend,
// so it is interrupted the moment the plane sees it, logged, and recorded as a
// runtime warning on the turn that saw it. The runtime build already turns its
// own continuations off; this is the second line.
import { recordProviderEvent } from "../runs/provider-events";
import type { SandboxHandle } from "../sandboxes/provider";
import { dispatchRuntimeCommand } from "./runtime-dispatch";
import { buildRuntimeTurnInterruptCommand, isRuntimePlaneMessageId } from "./runtime-orchestration";
import { v2RunSettled, type V2Projection, type V2Run } from "./runtime-v2-wire";
import type { EngineRunContext } from "./types";

export const FOREIGN_RUN_REASON = "Started by the provider runtime, not by UseAgent";

/** Active runs the plane did not start. */
export function foreignActiveRuns(projection: V2Projection): V2Run[] {
  return projection.runs.filter((run) => !v2RunSettled(run.status) && !isRuntimePlaneMessageId(run.userMessageId));
}

export interface ForeignRunGuardDependencies {
  readonly dispatch: typeof dispatchRuntimeCommand;
  readonly record: typeof recordProviderEvent;
}

/** Stops each foreign run once per guard; resolves with the runs it stopped. */
export function createForeignRunGuard(input: {
  readonly ctx: Pick<EngineRunContext, "runId" | "threadId">;
  readonly sandbox: SandboxHandle;
  readonly threadId: string;
  readonly signal: AbortSignal;
  readonly dependencies?: ForeignRunGuardDependencies;
}): (projection: V2Projection) => Promise<readonly string[]> {
  const stopped = new Set<string>();
  const { dispatch, record } = input.dependencies ?? { dispatch: dispatchRuntimeCommand, record: recordProviderEvent };
  return async (projection) => {
    const runs = foreignActiveRuns(projection).filter((run) => !stopped.has(run.id));
    for (const run of runs) {
      stopped.add(run.id);
      console.warn(`[runtime] interrupting run ${run.id} on ${input.threadId}: started by message ${run.userMessageId}, not by the plane`);
      await dispatch(input.sandbox, buildRuntimeTurnInterruptCommand(input.threadId, run.id, FOREIGN_RUN_REASON), input.signal);
      await record({
        id: `pe_${input.ctx.runId}_t3_foreign-run-${run.id}`,
        runId: input.ctx.runId,
        threadId: input.ctx.threadId ?? input.ctx.runId,
        provider: "t3",
        eventType: "t3.activity.runtime.warning",
        nativeSessionId: input.threadId,
        payload: { kind: "runtime.warning", summary: "Stopped a run the provider runtime started on its own", runId: run.id, userMessageId: run.userMessageId },
      });
    }
    return runs.map((run) => run.id);
  };
}
