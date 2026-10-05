// One socket to the provider runtime, speaking its RPC framing: a request is
// `{_tag:"Request", id, tag, payload, headers}`; a stream answers with `Chunk`
// frames (each acknowledged) and ends with an `Exit`; a call answers with one
// `Exit`. The runtime echoes the request id as sent, so ids stay numbers. A
// turn opens one socket, subscribes to its thread, and dispatches its commands
// on the same socket, so nothing the turn starts can happen before the plane
// is listening.
import { previewLinkBase, type SandboxHandle } from "../sandboxes/provider";
import { RUNTIME_ENVIRONMENT_PORT } from "./runtime-environment";
import { issueRuntimeEnvironmentWebSocketTicket } from "./runtime-environment-client";
import { pingRuntimeSocket } from "./turn-liveness";
import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  runtimeRpcErrorFromExit,
} from "./runtime-v2-wire";

type Frame = Readonly<Record<string, unknown>>;

export interface RuntimeSocket {
  /** Streams one RPC. `onValues` receives each chunk's values in order and
   *  returning false ends the stream. Resolves when the server or `onValues`
   *  ends it, or the socket's signal aborts; rejects on a failure. */
  stream(tag: string, payload: unknown, onValues: (values: readonly unknown[]) => Promise<boolean>): Promise<void>;
  /** One request, one answer: the Exit's success value, or a RuntimeRpcError. */
  call(tag: string, payload: unknown): Promise<unknown>;
  close(): void;
}

interface Pending {
  readonly tag: string;
  readonly onValues?: (values: readonly unknown[]) => Promise<boolean>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  /** A stream's own serial queue: its values are handled in order without
   *  holding up other requests' frames (a handler may await a call on this socket). */
  chain: Promise<void>;
  done: boolean;
}

export type RuntimeSocketConnect = (url: string, headers: Readonly<Record<string, string>>) => WebSocket;

const defaultConnect: RuntimeSocketConnect = (url, headers) => new WebSocket(url, { headers });

/** A socket that neither opens nor fails in this long is treated as failed. */
const OPEN_TIMEOUT_MS = 15_000;

/** The runtime socket URL for a preview link: `/ws` with a one-time ticket and the protocol version. */
export function runtimeSocketUrl(previewUrl: string, ticket: string): string {
  const url = new URL(previewUrl.replace(/^http/, "ws"));
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}

async function text(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return await data.text();
  throw new Error("The provider stream returned an unsupported frame");
}

export async function openRuntimeSocket(input: {
  readonly sandbox: SandboxHandle;
  readonly signal: AbortSignal;
  /** Called whenever the socket shows it is alive (a frame or a pong). */
  readonly onHeard?: () => void;
  readonly connect?: RuntimeSocketConnect;
}): Promise<RuntimeSocket> {
  const [ticket, preview] = await Promise.all([
    issueRuntimeEnvironmentWebSocketTicket(input.sandbox, input.signal),
    input.sandbox.getPreviewLink(RUNTIME_ENVIRONMENT_PORT),
  ]);
  input.signal.throwIfAborted();
  const socket = (input.connect ?? defaultConnect)(
    runtimeSocketUrl(preview.url, ticket),
    { ...previewLinkBase(preview).headers },
  );
  return await attachRuntimeSocket(socket, input.signal, input.onHeard ?? (() => {}), OPEN_TIMEOUT_MS);
}

/** Wraps an opening socket; resolves once it is open. Exported for tests. */
export function attachRuntimeSocket(
  socket: WebSocket,
  signal: AbortSignal,
  onHeard: () => void,
  openTimeoutMs = OPEN_TIMEOUT_MS,
): Promise<RuntimeSocket> {
  const opening = Promise.withResolvers<RuntimeSocket>();
  const pending = new Map<string, Pending>();
  let nextId = 1;
  let closed: Error | null = null;
  let processing = Promise.resolve();
  const stopPinging = pingRuntimeSocket(socket, onHeard);

  const send = (frame: Frame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };
  const shutdown = (error: Error, settle: (entry: Pending) => void) => {
    if (closed) return;
    closed = error;
    stopPinging();
    signal.removeEventListener("abort", abort);
    for (const [id, entry] of pending) {
      if (entry.onValues) send({ _tag: "Interrupt", requestId: Number(id) });
      entry.done = true;
      settle(entry);
    }
    pending.clear();
    try {
      socket.close();
    } catch {
      // The socket may not have reached OPEN.
    }
  };
  const fail = (error: Error) => shutdown(error, (entry) => entry.reject(error));
  // A local abort ends streams quietly (the caller reads its own signal) and fails calls.
  function abort() {
    const reason = signal.reason instanceof Error ? signal.reason : new Error("Provider runtime socket aborted");
    opening.reject(reason);
    shutdown(reason, (entry) => entry.onValues ? entry.resolve(undefined) : entry.reject(reason));
  }
  signal.addEventListener("abort", abort, { once: true });

  const finishStream = (id: string, entry: Pending, settle: () => void) => {
    if (entry.done) return;
    entry.done = true;
    pending.delete(id);
    settle();
  };

  const handle = (frame: Frame) => {
    const id = frame.requestId === undefined ? undefined : String(frame.requestId);
    const entry = id === undefined ? undefined : pending.get(id);
    if (frame._tag === "Chunk" && entry?.onValues && Array.isArray(frame.values)) {
      send({ _tag: "Ack", requestId: frame.requestId });
      const values = frame.values;
      const onValues = entry.onValues;
      entry.chain = entry.chain.then(async () => {
        if (entry.done) return;
        if (!(await onValues(values))) {
          send({ _tag: "Interrupt", requestId: frame.requestId });
          finishStream(id!, entry, () => entry.resolve(undefined));
        }
      }).catch((error: unknown) => {
        send({ _tag: "Interrupt", requestId: frame.requestId });
        finishStream(id!, entry, () => entry.reject(error instanceof Error ? error : new Error(String(error))));
      });
      return;
    }
    if (frame._tag === "Exit" && entry) {
      const exit = frame.exit as Frame | undefined;
      const settle = () => exit?._tag === "Success"
        ? entry.resolve(exit.value)
        : entry.reject(runtimeRpcErrorFromExit(entry.tag, exit));
      if (entry.onValues) {
        // A stream ends only after the values it already delivered are handled.
        entry.chain = entry.chain.then(() => finishStream(id!, entry, settle));
      } else {
        pending.delete(id!);
        settle();
      }
      return;
    }
    if (frame._tag === "Defect" || frame._tag === "ClientProtocolError") {
      fail(new Error(`The provider runtime socket failed (${frame._tag})`));
    }
  };

  const request = (tag: string, payload: unknown, onValues?: Pending["onValues"]) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) {
        reject(closed);
        return;
      }
      const id = nextId++;
      pending.set(String(id), { tag, onValues, resolve, reject, chain: Promise.resolve(), done: false });
      send({ _tag: "Request", id, tag, payload, headers: [] });
    });

  const runtimeSocket: RuntimeSocket = {
    stream: async (tag, payload, onValues) => {
      await request(tag, payload, onValues);
    },
    call: (tag, payload) => request(tag, payload),
    close: () => shutdown(new Error("Provider runtime socket closed"), (entry) =>
      entry.onValues ? entry.resolve(undefined) : entry.reject(new Error("Provider runtime socket closed"))),
  };

  const openTimer = setTimeout(() => {
    const error = new Error("The provider stream did not open");
    opening.reject(error);
    fail(error);
  }, openTimeoutMs);
  openTimer.unref?.();
  socket.onopen = () => {
    clearTimeout(openTimer);
    opening.resolve(runtimeSocket);
  };
  socket.onmessage = (event) => {
    onHeard();
    // Decoding stays in arrival order; handling a frame never waits on a handler.
    processing = processing
      .then(async () => {
        const parsed: unknown = JSON.parse(await text(event.data));
        if (parsed && typeof parsed === "object") handle(parsed as Frame);
      })
      .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
  };
  const lost = (error: Error) => {
    clearTimeout(openTimer);
    opening.reject(error);
    processing = processing.then(async () => {
      // Frames that arrived first are handled. Calls fail now, since a stream
      // handler may be waiting on one; streams fail after their values are handled.
      for (const [id, entry] of [...pending]) {
        if (entry.onValues) continue;
        pending.delete(id);
        entry.reject(error);
      }
      await Promise.all([...pending.values()].map((entry) => entry.chain));
      fail(error);
    });
  };
  socket.onerror = () => lost(new Error("The provider stream connection failed"));
  socket.onclose = () => lost(new Error("The provider stream closed"));
  if (signal.aborted) abort();
  opening.promise.catch(() => clearTimeout(openTimer));
  return opening.promise;
}
