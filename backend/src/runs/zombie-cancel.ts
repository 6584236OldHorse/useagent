import { CANCEL_SUMMARY } from "../commands/cancel";
import { settleCommandForRun } from "../commands/dispatch";
import { finalizeRun, resolveDurableFinalizationOutcome } from "./finalize";
import { deleteReconcile } from "./reconcile-queue";

/** Stop on a run with no live worker: settle it now, and its command with it, so
 *  the Stop's pump can dispatch the thread's next queued turn. */
export async function settleZombieCancel(runId: string): Promise<string | null> {
  console.warn(
    `[cancel] run ${runId} is 'running' with no live canceller; finalizing as stopped now.`,
  );
  const finalized = await finalizeRun(runId, "failed", CANCEL_SUMMARY, 0);
  const durable = await resolveDurableFinalizationOutcome(runId, finalized);
  await deleteReconcile(runId);
  await settleCommandForRun(runId);
  return !finalized.applied && durable ? durable.status : null;
}
