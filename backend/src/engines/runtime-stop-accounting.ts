import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

/** How long a stopped turn may spend landing the usage the runtime billed before it halted. */
export const RUNTIME_STOP_ACCOUNTING_MS = 5_000;

/** Resolve with `operation`, or reject the moment `signal` aborts; the
 *  operation itself is left to finish or fail on its own. */
function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * The stop path's accounting, in this order: cancel the runtime turn FIRST
 * (the runtime keeps billing until it halts, and the interruption itself
 * produces the final usage), then ONE read of the terminal snapshot and its
 * projection, both fenced by the same independent bound. The read honours the
 * signal end to end (the exec-based terminal read is raced and its session
 * cleaned up on abort); a read that lands after the bound is never projected,
 * and the projection receives the same signal, so once the bound fires it
 * records nothing further: a write already in flight may finish, but no later
 * usage is written, and a capture already in the run's chain is drained by the
 * settlement before it charges. Best effort: a runtime that cannot answer in
 * time is logged and the stop stands.
 */
export async function settleStoppedTurnUsage(input: {
  readonly cancel: () => Promise<void>;
  readonly read: (signal: AbortSignal) => Promise<RuntimeThreadSnapshot>;
  readonly apply: (snapshot: RuntimeThreadSnapshot, signal: AbortSignal) => Promise<unknown>;
  readonly deadlineSignal?: AbortSignal;
}): Promise<boolean> {
  await input.cancel();
  const deadline = input.deadlineSignal ?? AbortSignal.timeout(RUNTIME_STOP_ACCOUNTING_MS);
  try {
    const snapshot = await untilAborted(input.read(deadline), deadline);
    deadline.throwIfAborted();
    await untilAborted(input.apply(snapshot, deadline), deadline);
    return true;
  } catch (error) {
    console.warn(
      "[runtime] usage billed before the stop was not captured:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * After the turn loop, whatever ended it. A turn the runtime settled needs
 * nothing more. A dispatched turn it did not settle (Stop; a lost transport; a
 * turn that produced nothing in time) may still be running and billing, so it
 * is cancelled and the usage its interruption produced is landed before the
 * run settles. On Stop a cancel that fails is the caller's failure; after a
 * lost transport it is logged and the failure that ended the turn stands.
 */
export async function landUnsettledTurn(input: {
  readonly dispatched: boolean;
  readonly settled: boolean;
  readonly stopping: boolean;
  readonly cancel: () => Promise<void>;
  readonly read: (signal: AbortSignal) => Promise<RuntimeThreadSnapshot>;
  readonly apply: (snapshot: RuntimeThreadSnapshot, signal: AbortSignal) => Promise<unknown>;
  readonly deadlineSignal?: AbortSignal;
}): Promise<"nothing" | "landed" | "lost" | "cancel_failed"> {
  if (!input.dispatched || input.settled) return "nothing";
  try {
    return (await settleStoppedTurnUsage(input)) ? "landed" : "lost";
  } catch (error) {
    if (input.stopping) throw error;
    console.warn(
      "[runtime] the lost turn could not be cancelled:",
      error instanceof Error ? error.message : String(error),
    );
    return "cancel_failed";
  }
}
