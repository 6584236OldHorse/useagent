// Sends one orchestration command to a sandbox's runtime. A turn that is
// following its thread registers its socket here, so the turn's own commands
// (its message, an approval reply, a cancel) go out on the socket that is
// already subscribed: nothing they start can happen before the plane listens.
// Any other caller gets a one-shot socket. The registry is process-local, like
// every live turn in a single-backend deployment.
import type { SandboxHandle } from "../sandboxes/provider";
import { openRuntimeSocket, type RuntimeSocket } from "./runtime-rpc-socket";
import { RUNTIME_RPC, RuntimeRpcError, type RuntimeCommand } from "./runtime-v2-wire";

const turnSockets = new Map<string, RuntimeSocket>();

/** How long a dispatch waits for the runtime's answer before it is treated as lost. */
const DISPATCH_ANSWER_TIMEOUT_MS = 30_000;

/** The call's answer, or the bound's reason if the runtime never answers. */
async function answered(call: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  const bound = AbortSignal.any([signal, AbortSignal.timeout(DISPATCH_ANSWER_TIMEOUT_MS)]);
  const stopped = Promise.withResolvers<never>();
  const onStop = () => stopped.reject(bound.reason instanceof Error ? bound.reason : new Error("The provider runtime did not answer the command"));
  bound.addEventListener("abort", onStop, { once: true });
  if (bound.aborted) onStop();
  try {
    return await Promise.race([call, stopped.promise]);
  } finally {
    bound.removeEventListener("abort", onStop);
  }
}

const socketKey = (sandboxId: string, threadId: string) => `${sandboxId}\u0000${threadId}`;

/** Lends a turn's subscribed socket to its thread's commands; the returned function withdraws it. */
export function registerRuntimeTurnSocket(sandboxId: string, threadId: string, socket: RuntimeSocket): () => void {
  const key = socketKey(sandboxId, threadId);
  turnSockets.set(key, socket);
  return () => {
    if (turnSockets.get(key) === socket) turnSockets.delete(key);
  };
}

function receipt(value: unknown): { readonly sequence: number } {
  const sequence = (value as { sequence?: unknown } | null)?.sequence;
  if (!Number.isInteger(sequence)) throw new Error("The provider runtime returned an invalid dispatch receipt");
  return { sequence: sequence as number };
}

export interface RuntimeDispatchDependencies {
  readonly open: typeof openRuntimeSocket;
}

/**
 * Dispatches `command` and resolves with the runtime's receipt. A refusal
 * rejects with a RuntimeRpcError (the runtime keeps a refused command id
 * refused, so a retry needs a new id). A command id is answered with its first
 * receipt, so a transport failure on the turn's socket is retried once on a
 * fresh one.
 */
export async function dispatchRuntimeCommand(
  sandbox: SandboxHandle,
  command: RuntimeCommand & { readonly threadId: string },
  signal: AbortSignal,
  dependencies: RuntimeDispatchDependencies = { open: openRuntimeSocket },
): Promise<{ readonly sequence: number }> {
  const live = turnSockets.get(socketKey(sandbox.id, command.threadId));
  if (live) {
    try {
      return receipt(await answered(live.call(RUNTIME_RPC.dispatchCommand, command), signal));
    } catch (error) {
      // An answer from the runtime stands; only a lost socket or a dead handler is retried.
      const answered = error instanceof RuntimeRpcError && error.errorTag !== "Defect" && error.errorTag !== "Interrupt";
      if (answered || signal.aborted) throw error;
    }
  }
  const socket = await dependencies.open({ sandbox, signal });
  try {
    return receipt(await answered(socket.call(RUNTIME_RPC.dispatchCommand, command), signal));
  } finally {
    socket.close();
  }
}
