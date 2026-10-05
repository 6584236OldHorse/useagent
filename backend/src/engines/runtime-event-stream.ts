import {
  previewLinkBase,
  type SandboxHandle,
} from "../sandboxes/provider";
import { setTimeout as delay } from "node:timers/promises";
import { RUNTIME_ENVIRONMENT_PORT } from "./runtime-environment";
import { issueRuntimeEnvironmentWebSocketTicket, RUNTIME_THREAD_TURN_WINDOW } from "./runtime-environment-client";
import { pingRuntimeSocket } from "./turn-liveness";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";
import { applyRuntimeThreadEvent, type RuntimeThreadEvent } from "./runtime-thread-events";

const SUBSCRIPTION_REQUEST_ID = 1;
const RPC_REQUEST_ID = 1;
const SUBSCRIPTION_TAG = "orchestration.subscribeThread";
const STREAM_ERROR_DRAIN_MS = 15_000;

export type RuntimeThreadStreamItem =
  | { readonly kind: "snapshot"; readonly snapshot: RuntimeThreadSnapshot }
  | { readonly kind: "event"; readonly event: RuntimeThreadStreamEvent }
  | { readonly kind: "synchronized" };

export interface RuntimeThreadStreamEvent extends RuntimeThreadEvent {
  readonly aggregateKind: "thread";
  readonly aggregateId: string;
}

type RuntimeRpcFrame = Readonly<Record<string, unknown>>;

type RuntimeRpcChunk = RuntimeRpcFrame & {
  readonly _tag: "Chunk";
  readonly requestId: string | number;
  readonly values: readonly unknown[];
};

type RuntimeRpcExit = RuntimeRpcFrame & {
  readonly _tag: "Exit";
  readonly requestId: string | number;
  readonly exit: { readonly _tag: "Success" | "Failure" };
};

function isRuntimeRpcChunk(frame: RuntimeRpcFrame): frame is RuntimeRpcChunk {
  return (
    frame._tag === "Chunk" &&
    (typeof frame.requestId === "string" || typeof frame.requestId === "number") &&
    Array.isArray(frame.values)
  );
}

function isRuntimeRpcExit(frame: RuntimeRpcFrame): frame is RuntimeRpcExit {
  if (
    frame._tag !== "Exit" ||
    (typeof frame.requestId !== "string" && typeof frame.requestId !== "number") ||
    !frame.exit ||
    typeof frame.exit !== "object"
  ) {
    return false;
  }
  const tag = (frame.exit as Readonly<Record<string, unknown>>)._tag;
  return tag === "Success" || tag === "Failure";
}

function parseRuntimeRpcFrame(data: string): RuntimeRpcFrame | undefined {
  const parsed = JSON.parse(data) as unknown;
  return parsed && typeof parsed === "object"
    ? parsed as RuntimeRpcFrame
    : undefined;
}

export function buildRuntimeThreadSubscriptionRequest(
  threadId: string,
  afterSequence?: number,
): Readonly<Record<string, unknown>> {
  return {
    _tag: "Request",
    id: SUBSCRIPTION_REQUEST_ID,
    tag: SUBSCRIPTION_TAG,
    payload: {
      threadId,
      ...(afterSequence === undefined ? {} : { afterSequence }),
      // The first snapshot carries the same recent window as a thread read.
      turnLimit: RUNTIME_THREAD_TURN_WINDOW,
      requestCompletionMarker: true,
    },
    headers: [],
  };
}

function isRuntimeThreadSnapshot(value: unknown): value is RuntimeThreadSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as {
    readonly snapshotSequence?: unknown;
    readonly thread?: unknown;
  };
  if (!Number.isInteger(snapshot.snapshotSequence) || (snapshot.snapshotSequence as number) < 0) {
    return false;
  }
  if (!snapshot.thread || typeof snapshot.thread !== "object") return false;
  const thread = snapshot.thread as Readonly<Record<string, unknown>>;
  return typeof thread.id === "string" &&
    (thread.latestTurn === null || typeof thread.latestTurn === "object") &&
    Array.isArray(thread.messages) &&
    Array.isArray(thread.activities) &&
    (thread.session === null || typeof thread.session === "object");
}

function isRuntimeThreadStreamEvent(value: unknown): value is RuntimeThreadStreamEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Readonly<Record<string, unknown>>;
  return Number.isInteger(event.sequence) &&
    (event.sequence as number) >= 0 &&
    event.aggregateKind === "thread" &&
    typeof event.aggregateId === "string";
}

export function decodeRuntimeThreadStreamItems(data: string): readonly RuntimeThreadStreamItem[] {
  const frame = parseRuntimeRpcFrame(data);
  if (
    !frame ||
    !isRuntimeRpcChunk(frame) ||
    frame.requestId !== SUBSCRIPTION_REQUEST_ID ||
    !frame.values.length
  ) {
    return [];
  }
  return frame.values.filter((value): value is RuntimeThreadStreamItem => {
    if (!value || typeof value !== "object" || !("kind" in value)) return false;
    const item = value as { readonly kind?: unknown; readonly snapshot?: unknown; readonly event?: unknown };
    return item.kind === "synchronized" ||
      (item.kind === "snapshot" && isRuntimeThreadSnapshot(item.snapshot)) ||
      (item.kind === "event" && isRuntimeThreadStreamEvent(item.event));
  });
}

function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) {
    return Promise.resolve(new TextDecoder().decode(data));
  }
  if (data instanceof Blob) return data.text();
  return Promise.reject(new Error("The provider stream returned an unsupported frame"));
}

/**
 * Follows one thread until a snapshot settles it. The thread state starts from
 * the snapshot the subscription sends first, and stream events apply to it in
 * place (runtime-thread-events.ts). An event that cannot be applied, or a gap,
 * reads a full snapshot through the sandbox; events that arrive meanwhile wait
 * and apply on top of it. Every state reaches `applySnapshot` in order.
 */
export async function followRuntimeThreadSnapshots(input: {
  readonly sandbox: SandboxHandle;
  readonly threadId: string;
  readonly initialSequence: number;
  readonly signal: AbortSignal;
  readonly readSnapshot: (signal: AbortSignal) => Promise<RuntimeThreadSnapshot>;
  readonly applySnapshot: (snapshot: RuntimeThreadSnapshot) => Promise<boolean>;
  readonly subscribe?: typeof subscribeRuntimeThread;
  /** Called whenever the stream shows it is alive (a frame or a pong). */
  readonly onHeard?: () => void;
  /** Called after each full snapshot read with how long it took. */
  readonly onRead?: (durationMs: number) => void;
}): Promise<void> {
  let state: RuntimeThreadSnapshot | null = null;
  const observedSequence = () => state?.snapshotSequence ?? input.initialSequence;
  let refreshThroughSequence = input.initialSequence;
  let refreshOperation: Promise<void> | null = null;
  let waiting: RuntimeThreadStreamEvent[] = [];
  let refreshError: unknown;
  let applicationTail: Promise<void> = Promise.resolve();
  let terminalObserved = false;
  const stopped = new AbortController();
  const signal = AbortSignal.any([input.signal, stopped.signal]);
  const fail = (error: unknown) => {
    if (!input.signal.aborted && !stopped.signal.aborted) refreshError ??= error;
    stopped.abort();
  };
  const apply = (value: RuntimeThreadSnapshot): Promise<boolean> => {
    let keepFollowing = true;
    const operation = applicationTail.then(async () => {
      if (signal.aborted) {
        keepFollowing = false;
        return;
      }
      keepFollowing = await input.applySnapshot(value);
      if (!keepFollowing) {
        terminalObserved = true;
        stopped.abort();
      }
    });
    applicationTail = operation;
    return operation.then(() => keepFollowing);
  };
  const follow = (event: RuntimeThreadStreamEvent): void => {
    if (signal.aborted || event.sequence <= observedSequence()) return;
    if (refreshThroughSequence > observedSequence()) {
      waiting.push(event);
      return;
    }
    const next = state && applyRuntimeThreadEvent(state, event);
    if (!next) {
      scheduleRefresh(event.sequence);
      return;
    }
    state = next;
    apply(next).catch(fail);
  };
  /** A snapshot older than the state is stale; one at its sequence only seeds an empty state. */
  const accept = (value: unknown): Promise<boolean> | null => {
    if (!isRuntimeThreadSnapshot(value) || value.thread.id !== input.threadId) return null;
    const sequence = observedSequence();
    if (value.snapshotSequence < sequence || (value.snapshotSequence === sequence && state)) return null;
    state = value;
    const applied = value.snapshotSequence > sequence ? apply(value) : null;
    if (refreshThroughSequence <= observedSequence()) {
      const queued = waiting;
      waiting = [];
      for (const event of queued) follow(event);
    }
    return applied;
  };
  const read = async (readSignal: AbortSignal): Promise<RuntimeThreadSnapshot> => {
    const startedAt = performance.now();
    try {
      return await input.readSnapshot(readSignal);
    } finally {
      input.onRead?.(performance.now() - startedAt);
    }
  };
  const scheduleRefresh = (sequence: number): void => {
    if (sequence <= observedSequence() || signal.aborted) return;
    refreshThroughSequence = Math.max(refreshThroughSequence, sequence);
    if (refreshOperation) return;
    refreshOperation = (async () => {
      try {
        while (!signal.aborted && observedSequence() < refreshThroughSequence) {
          const targetSequence = refreshThroughSequence;
          await accept(await read(signal));
          if (observedSequence() < targetSequence && !signal.aborted) {
            await delay(125, undefined, { signal });
          }
        }
      } catch (error) {
        fail(error);
      } finally {
        refreshOperation = null;
      }
    })();
  };
  const awaitRefresh = async () => {
    const operation = refreshOperation;
    if (operation) await operation;
  };
  const awaitApplications = async () => {
    await applicationTail;
  };

  let streamError: unknown;
  try {
    await (input.subscribe ?? subscribeRuntimeThread)(
      input.sandbox,
      input.threadId,
      undefined,
      signal,
      async (item) => {
        if (item.kind === "snapshot") {
          return await (accept(item.snapshot) ?? applicationTail.then(() => !signal.aborted));
        }
        if (item.kind === "event" && item.event.aggregateId === input.threadId) follow(item.event);
        return true;
      },
      input.onHeard,
    );
    await awaitRefresh();
    await awaitApplications();
    stopped.abort();
  } catch (error) {
    streamError = error;
    // A terminal notification can beat its authoritative refresh to a broken
    // socket. Drain work already in flight before classifying the transport
    // failure, bounded independently of the caller's cancellation/deadline.
    await Promise.race([
      awaitRefresh().then(awaitApplications),
      delay(STREAM_ERROR_DRAIN_MS, undefined, { signal }),
    ]).catch(() => {});
    stopped.abort();
  }
  if (refreshError) throw refreshError;
  if (streamError && !terminalObserved) throw streamError;
  if (!terminalObserved && !input.signal.aborted) {
    throw new Error("The provider thread subscription ended before a terminal snapshot");
  }
}

/** A socket to the runtime's RPC endpoint, admitted by a one-time ticket. */
async function openRuntimeSocket(sandbox: SandboxHandle, signal: AbortSignal): Promise<WebSocket> {
  const [ticket, preview] = await Promise.all([
    issueRuntimeEnvironmentWebSocketTicket(sandbox, signal),
    sandbox.getPreviewLink(RUNTIME_ENVIRONMENT_PORT),
  ]);
  const url = new URL(preview.url.replace(/^http/, "ws"));
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  return new WebSocket(url.toString(), { headers: { ...previewLinkBase(preview).headers } });
}

/** One request-response RPC to the runtime: true once it exits successfully,
 * false on a failed exit, a closed socket, the timeout or an abort. */
export async function requestRuntimeRpc(
  sandbox: SandboxHandle,
  tag: string,
  payload: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<boolean> {
  const socket = await openRuntimeSocket(sandbox, signal);
  const done = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => done.resolve(false), timeoutMs);
  const abort = () => done.resolve(false);
  signal.addEventListener("abort", abort, { once: true });
  socket.onopen = () => {
    socket.send(JSON.stringify({ _tag: "Request", id: RPC_REQUEST_ID, tag, payload, headers: [] }));
  };
  socket.onmessage = (event) => {
    let frame: RuntimeRpcFrame | undefined;
    try {
      frame = parseRuntimeRpcFrame(String(event.data));
    } catch {
      return;
    }
    if (frame && isRuntimeRpcExit(frame) && String(frame.requestId) === String(RPC_REQUEST_ID)) {
      done.resolve(frame.exit._tag === "Success");
    }
  };
  socket.onerror = () => done.resolve(false);
  socket.onclose = () => done.resolve(false);
  try {
    return await done.promise;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    try {
      socket.close();
    } catch {
      // Socket may not have reached OPEN.
    }
  }
}

export async function subscribeRuntimeThread(
  sandbox: SandboxHandle,
  threadId: string,
  afterSequence: number | undefined,
  signal: AbortSignal,
  onItem: (item: RuntimeThreadStreamItem) => Promise<boolean>,
  onHeard: () => void = () => {},
): Promise<void> {
  const socket = await openRuntimeSocket(sandbox, signal);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let processing = Promise.resolve();
    const stopPinging = pingRuntimeSocket(socket, onHeard);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stopPinging();
      signal.removeEventListener("abort", abort);
      try {
        socket.close();
      } catch {
        // Socket may not have reached OPEN.
      }
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          _tag: "Interrupt",
          requestId: SUBSCRIPTION_REQUEST_ID,
        }));
      }
      finish();
    };
    signal.addEventListener("abort", abort, { once: true });

    socket.onopen = () => {
      socket.send(
        JSON.stringify(buildRuntimeThreadSubscriptionRequest(threadId, afterSequence)),
      );
    };
    socket.onmessage = (event) => {
      onHeard();
      processing = processing
        .then(async () => {
          const text = await messageText(event.data);
          const frame = parseRuntimeRpcFrame(text);
          if (!frame) return;
          if (
            isRuntimeRpcChunk(frame) &&
            frame.requestId === SUBSCRIPTION_REQUEST_ID
          ) {
            socket.send(JSON.stringify({
              _tag: "Ack",
              requestId: SUBSCRIPTION_REQUEST_ID,
            }));
            for (const item of decodeRuntimeThreadStreamItems(text)) {
              if (
                (item.kind === "snapshot" && item.snapshot.thread.id !== threadId) ||
                (item.kind === "event" && item.event.aggregateId !== threadId)
              ) {
                continue;
              }
              if (!(await onItem(item))) {
                finish();
                return;
              }
            }
            return;
          }
          if (
            isRuntimeRpcExit(frame) &&
            frame.requestId === SUBSCRIPTION_REQUEST_ID
          ) {
            finish(
              frame.exit._tag === "Failure"
                ? new Error("The provider thread subscription failed")
                : undefined,
            );
          }
        })
        .catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
    };
    socket.onerror = () => finish(new Error("The provider stream connection failed"));
    socket.onclose = () => {
      if (!settled) finish(new Error("The provider stream closed before the turn settled"));
    };
    if (signal.aborted) abort();
  });
}
