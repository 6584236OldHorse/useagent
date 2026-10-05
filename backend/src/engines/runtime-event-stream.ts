// Follows one runtime thread over its socket until the caller is done with it.
// The subscription first delivers the thread (a bounded snapshot), then
// `synchronized`, then live events. `start` runs once, at `synchronized`, on
// the subscribed socket: the turn's own command goes out only after the plane
// is listening, so nothing it starts can be missed. Every change becomes a new
// view handed to `applySnapshot`, in order. A socket that drops before the
// caller is done resumes from the applied sequence (the runtime replays what
// was missed, or sends a fresh snapshot when it cannot).
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxHandle } from "../sandboxes/provider";
import { registerRuntimeTurnSocket } from "./runtime-dispatch";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";
import { openRuntimeSocket } from "./runtime-rpc-socket";
import { applyV2StreamItem, type V2MirrorState } from "./runtime-v2-mirror";
import { runtimeThreadView } from "./runtime-v2-view";
import { decodeV2ThreadStreamItem, RUNTIME_RPC, type V2ThreadSnapshot } from "./runtime-v2-wire";

/** Consecutive reconnects without progress before the follow gives up. */
const RESUME_LIMIT = 3;
const RESUME_DELAY_MS = 1_000;

export function buildRuntimeThreadSubscription(threadId: string, afterSequence?: number): Readonly<Record<string, unknown>> {
  return {
    threadId,
    ...(afterSequence === undefined ? {} : { afterSequence }),
    acceptBoundedSnapshot: true,
    requestCompletionMarker: true,
  };
}

/** Raised for a failure of the caller's own callbacks, which a resume must not retry. */
class CallbackFailure {
  constructor(readonly error: unknown) {}
}

export interface FollowRuntimeThreadInput {
  readonly sandbox: SandboxHandle;
  readonly threadId: string;
  readonly signal: AbortSignal;
  /** Runs once the subscription has caught up, before any live event is followed. */
  readonly start?: () => Promise<void>;
  /** Receives every new view of the thread, with the runtime state it came from; returning false ends the follow. */
  readonly applySnapshot: (snapshot: RuntimeThreadSnapshot, source: V2ThreadSnapshot) => Promise<boolean>;
  /** Called whenever the socket shows it is alive (a frame or a pong). */
  readonly onHeard?: () => void;
  readonly open?: typeof openRuntimeSocket;
  readonly resumeDelayMs?: number;
}

/**
 * Resolves when `applySnapshot` ends the follow or the signal aborts. Rejects
 * with the error of `start` or `applySnapshot`, or with the transport's error
 * once resuming stopped making progress.
 */
export async function followRuntimeThread(input: FollowRuntimeThreadInput): Promise<void> {
  const open = input.open ?? openRuntimeSocket;
  let state = null as V2MirrorState | null;
  let started = input.start === undefined;
  let done = false;
  let attempts = 0;
  for (;;) {
    if (input.signal.aborted) return;
    const startSequence = state?.sequence ?? -1;
    let synchronizedHere = false;
    let failure: CallbackFailure | null = null;
    let transportError: unknown;
    try {
      const socket = await open({ sandbox: input.sandbox, signal: input.signal, onHeard: input.onHeard });
      const withdraw = registerRuntimeTurnSocket(input.sandbox.id, input.threadId, socket);
      try {
        await socket.stream(
          RUNTIME_RPC.subscribeThread,
          buildRuntimeThreadSubscription(input.threadId, state?.sequence),
          async (values) => {
            let changed = false;
            let synchronized = false;
            for (const value of values) {
              const item = decodeV2ThreadStreamItem(value);
              if (!item) continue;
              if (item.kind === "synchronized") {
                synchronized = true;
                continue;
              }
              const next = applyV2StreamItem(state, item, input.threadId);
              state = next.state;
              changed ||= next.changed;
            }
            synchronizedHere ||= synchronized;
            try {
              if (synchronized && !started) {
                started = true;
                await input.start!();
              }
              const source = state && { snapshotSequence: state.sequence, projection: state.projection };
              if (changed && source && !(await input.applySnapshot(runtimeThreadView(source), source))) {
                done = true;
                return false;
              }
            } catch (error) {
              failure = new CallbackFailure(error);
              return false;
            }
            return true;
          },
        );
      } finally {
        withdraw();
        socket.close();
      }
    } catch (error) {
      transportError = error;
    }
    if (failure) throw (failure as CallbackFailure).error;
    if (done || input.signal.aborted) return;
    // Progress is the cursor moving or the turn being dispatched, not a resent snapshot.
    const progressed = ((state as V2MirrorState | null)?.sequence ?? -1) > startSequence || (synchronizedHere && startSequence < 0);
    attempts = progressed ? 1 : attempts + 1;
    if (attempts > RESUME_LIMIT) {
      throw transportError ?? new Error("The provider thread subscription ended before the turn settled");
    }
    await delay(input.resumeDelayMs ?? RESUME_DELAY_MS, undefined, { signal: input.signal }).catch(() => {});
  }
}
