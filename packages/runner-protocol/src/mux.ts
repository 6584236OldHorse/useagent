// One socket, many conversations. The mux turns a WebSocket (or anything that
// can send text and bytes) into RPC calls plus independent byte streams with
// their own flow control, so one stalled noVNC canvas cannot starve a runtime
// session sharing the link.
//
// Pure TypeScript on web standards only (Promise, ReadableStream, TextEncoder):
// the runner and the control plane both run it unchanged.

import {
  type ControlFrame,
  decodeDataFrame,
  encodeControlFrame,
  encodeDataFrame,
  type EventFrame,
  type HeartbeatFrame,
  type HelloFrame,
  parseControlFrame,
  type WelcomeFrame,
} from "./frames";

export type MuxRole = "plane" | "runner";

export interface MuxTransport {
  send(message: string | Uint8Array): void;
}

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class StreamRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StreamRefusedError";
  }
}

export interface MuxStream {
  readonly id: number;
  /** Bytes from the peer; closes when the peer half-closes, errors on reset. */
  readonly readable: ReadableStream<Uint8Array>;
  /** Resolves once the bytes fit in the peer's window; rejects on reset. */
  write(bytes: Uint8Array): Promise<void>;
  /** Half-close: no more bytes from this side. */
  end(): void;
  /** Abort both directions. */
  reset(reason: string): void;
  /** Settles when both directions are done (resolve) or the stream was reset (reject). */
  readonly done: Promise<void>;
  /** Why the stream failed, or null while it is healthy or finished cleanly. */
  readonly failure: Error | null;
}

export interface MuxHandlers {
  onRpc?: (method: string, params: unknown) => Promise<unknown>;
  /** Accept by returning; refuse by throwing (a StreamRefusedError keeps its code). */
  onStreamOpen?: (target: unknown, stream: MuxStream) => Promise<void> | void;
  onHello?: (frame: HelloFrame) => void;
  onWelcome?: (frame: WelcomeFrame) => void;
  onHeartbeat?: (frame: HeartbeatFrame) => void;
  onEvent?: (frame: EventFrame) => void;
  /** A text frame that parsed to nothing known; ignored by the mux. */
  onUnknownFrame?: (text: string) => void;
}

export interface MuxOptions {
  /** Bytes a stream may have in flight before the receiver credits more. */
  readonly window?: number;
  readonly rpcTimeoutMs?: number;
  readonly streamOpenTimeoutMs?: number;
  readonly now?: () => number;
}

const DEFAULT_WINDOW = 256 * 1024;
/** What a peer that does not advertise a window (protocol 1 without the field) accepts. */
const ASSUMED_PEER_WINDOW = 256 * 1024;
const MAX_CHUNK = 64 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_OPEN_TIMEOUT_MS = 15_000;

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface StreamState {
  readonly id: number;
  stream: MuxStream;
  /** Why the stream finished early, for writers that wake up after the fact. */
  error: Error | null;
  /** Set only by an abnormal finish (reset, refusal, link closed). */
  failure: Error | null;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  /** Bytes received and not yet handed to the consumer. */
  inbound: Uint8Array[];
  inboundWaiter: (() => void) | null;
  sendCredit: number;
  /** The peer's receive window, from its open or opened frame. */
  peerWindow: number;
  /** What this side accepts in flight: its own window, or the protocol default for a peer that advertised none. */
  recvWindow: number;
  /** Bytes received and not yet credited back; a peer past the window is reset. */
  recvOutstanding: number;
  creditWaiters: Array<() => void>;
  localClosed: boolean;
  remoteClosed: boolean;
  finished: boolean;
  settle: { resolve: () => void; reject: (error: Error) => void };
}

export class Mux {
  private nextStreamId: number;
  private nextRpcId = 1;
  private readonly rpcs = new Map<number, Pending<unknown>>();
  private readonly opening = new Map<number, Pending<MuxStream>>();
  private readonly streams = new Map<number, StreamState>();
  private readonly window: number;
  private readonly rpcTimeoutMs: number;
  private readonly streamOpenTimeoutMs: number;
  private closed = false;

  constructor(
    readonly role: MuxRole,
    private readonly transport: MuxTransport,
    private readonly handlers: MuxHandlers = {},
    options: MuxOptions = {},
  ) {
    // Stream ids never collide: the plane opens even ids, the runner odd ones.
    this.nextStreamId = role === "plane" ? 2 : 1;
    const window = options.window ?? DEFAULT_WINDOW;
    if (!Number.isSafeInteger(window) || window < 1) throw new RangeError("window must be a positive integer");
    this.window = window;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.streamOpenTimeoutMs = options.streamOpenTimeoutMs ?? DEFAULT_STREAM_OPEN_TIMEOUT_MS;
  }

  get openStreams(): number {
    return this.streams.size;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(frame: ControlFrame): void {
    let encoded: string;
    try {
      encoded = encodeControlFrame(frame);
    } catch (error) {
      this.close(`frame cannot be serialised: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.sendRaw(encoded);
  }

  /** A transport that throws is a dead link: everything pending fails at once. */
  private sendRaw(message: string | Uint8Array): void {
    if (this.closed) return;
    try {
      this.transport.send(message);
    } catch (error) {
      this.close(`transport failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  rpc(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError("closed", "link is closed"));
    const id = this.nextRpcId++;
    let encoded: string;
    try {
      encoded = encodeControlFrame({ t: "rpc", id, method, params });
    } catch (error) {
      return Promise.reject(new RpcError("invalid_params", `params cannot be serialised: ${error instanceof Error ? error.message : String(error)}`));
    }
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.rpcs.delete(id);
      reject(new RpcError("timeout", `${method} did not answer within ${options.timeoutMs ?? this.rpcTimeoutMs} ms`));
    }, options.timeoutMs ?? this.rpcTimeoutMs);
    this.rpcs.set(id, { resolve, reject, timer });
    this.sendRaw(encoded);
    return promise;
  }

  openStream(target: unknown, options: { timeoutMs?: number } = {}): Promise<MuxStream> {
    if (this.closed) return Promise.reject(new StreamRefusedError("closed", "link is closed"));
    let id = this.nextStreamId;
    while (this.streams.has(id)) id += 2;
    let encoded: string;
    try {
      encoded = encodeControlFrame({ t: "stream.open", id, target, window: this.window });
    } catch (error) {
      return Promise.reject(new StreamRefusedError("invalid_params", `target cannot be serialised: ${error instanceof Error ? error.message : String(error)}`));
    }
    this.nextStreamId = id + 2;
    const state = this.createStream(id);
    // Until the acceptor answers, it might be an older peer sending against the
    // protocol default; the acknowledgement settles which allowance applies.
    state.recvWindow = Math.max(this.window, ASSUMED_PEER_WINDOW);
    const { promise, resolve, reject } = Promise.withResolvers<MuxStream>();
    const timer = setTimeout(() => {
      this.opening.delete(id);
      this.finishStream(state, new StreamRefusedError("timeout", "stream open timed out"));
      reject(new StreamRefusedError("timeout", "stream open timed out"));
    }, options.timeoutMs ?? this.streamOpenTimeoutMs);
    this.opening.set(id, { resolve, reject, timer });
    this.sendRaw(encoded);
    return promise;
  }

  /** Feed one message from the socket. */
  receive(message: string | Uint8Array | ArrayBuffer): void {
    if (this.closed) return;
    if (typeof message === "string") {
      const frame = parseControlFrame(message);
      if (!frame) {
        this.handlers.onUnknownFrame?.(message);
        return;
      }
      this.receiveControl(frame);
      return;
    }
    const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
    const data = decodeDataFrame(bytes);
    if (!data) return;
    const state = this.streams.get(data.streamId);
    if (!state || state.remoteClosed || data.payload.byteLength === 0) return;
    state.recvOutstanding += data.payload.byteLength;
    if (state.recvOutstanding > state.recvWindow) {
      this.finishStream(state, new Error("peer exceeded the stream window"));
      return;
    }
    // Copy: the socket may reuse its buffer after this call returns.
    state.inbound.push(data.payload.slice());
    state.inboundWaiter?.();
  }

  /** The socket is gone: fail every pending call and stream. */
  close(reason = "link closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.rpcs) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError("closed", reason));
      this.rpcs.delete(id);
    }
    for (const [id, pending] of this.opening) {
      clearTimeout(pending.timer);
      pending.reject(new StreamRefusedError("closed", reason));
      this.opening.delete(id);
    }
    for (const state of [...this.streams.values()]) {
      this.finishStream(state, new Error(reason));
    }
  }

  private receiveControl(frame: ControlFrame): void {
    switch (frame.t) {
      case "hello":
        this.handlers.onHello?.(frame);
        return;
      case "welcome":
        this.handlers.onWelcome?.(frame);
        return;
      case "heartbeat":
        this.handlers.onHeartbeat?.(frame);
        return;
      case "event":
        this.handlers.onEvent?.(frame);
        return;
      case "rpc":
        void this.answerRpc(frame.id, frame.method, frame.params);
        return;
      case "rpc.result": {
        const pending = this.rpcs.get(frame.id);
        if (!pending) return;
        this.rpcs.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame.result ?? null);
        return;
      }
      case "rpc.error": {
        const pending = this.rpcs.get(frame.id);
        if (!pending) return;
        this.rpcs.delete(frame.id);
        clearTimeout(pending.timer);
        pending.reject(new RpcError(frame.code, frame.message));
        return;
      }
      case "stream.open":
        void this.acceptStream(frame.id, frame.target, frame.window);
        return;
      case "stream.opened": {
        const pending = this.opening.get(frame.id);
        const state = this.streams.get(frame.id);
        if (!pending || !state) return;
        // A lowered allowance is checked against what already arrived; a violation
        // resets the stream, which rejects this opener through finishStream.
        if (!this.grantPeerWindow(state, frame.window)) return;
        this.opening.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(state.stream);
        return;
      }
      case "stream.refused": {
        const pending = this.opening.get(frame.id);
        const state = this.streams.get(frame.id);
        if (!pending) return;
        this.opening.delete(frame.id);
        clearTimeout(pending.timer);
        if (state) this.finishStream(state, new StreamRefusedError(frame.code, frame.message));
        pending.reject(new StreamRefusedError(frame.code, frame.message));
        return;
      }
      case "stream.credit": {
        const state = this.streams.get(frame.id);
        if (!state) return;
        // Credit only ever returns what was sent; a peer cannot mint a bigger window.
        state.sendCredit = Math.min(state.peerWindow, state.sendCredit + frame.bytes);
        const waiters = state.creditWaiters;
        state.creditWaiters = [];
        for (const wake of waiters) wake();
        return;
      }
      case "stream.close": {
        const state = this.streams.get(frame.id);
        if (!state || state.remoteClosed) return;
        state.remoteClosed = true;
        state.inboundWaiter?.();
        this.maybeFinish(state);
        return;
      }
      case "stream.reset": {
        const pending = this.opening.get(frame.id);
        if (pending) {
          this.opening.delete(frame.id);
          clearTimeout(pending.timer);
          pending.reject(new StreamRefusedError("reset", frame.reason));
        }
        const state = this.streams.get(frame.id);
        if (!state) return;
        this.finishStream(state, new Error(`stream reset by peer: ${frame.reason}`), false);
        return;
      }
    }
  }

  private async answerRpc(id: number, method: string, params: unknown): Promise<void> {
    if (!this.handlers.onRpc) {
      this.send({ t: "rpc.error", id, code: "unsupported", message: `no handler for ${method}` });
      return;
    }
    let encoded: string;
    try {
      const result = (await this.handlers.onRpc(method, params)) ?? null;
      encoded = encodeControlFrame({ t: "rpc.result", id, result });
      // What was actually encoded is what counts: a toJSON that yields nothing drops the member.
      if (!Object.hasOwn(JSON.parse(encoded) as object, "result")) throw new RpcError("internal", "result cannot be serialised");
    } catch (error) {
      const code = error instanceof RpcError ? error.code : "internal";
      const message = error instanceof Error ? error.message : String(error);
      this.send({ t: "rpc.error", id, code, message });
      return;
    }
    this.sendRaw(encoded);
  }

  /**
   * The peer told us how much it accepts in flight; writes may start. A peer
   * that advertised nothing predates the field: it sends against the protocol
   * default, so that is what this side must accept from it.
   */
  private grantPeerWindow(state: StreamState, window: number | undefined): boolean {
    state.peerWindow = window ?? ASSUMED_PEER_WINDOW;
    state.recvWindow = window === undefined ? Math.max(this.window, ASSUMED_PEER_WINDOW) : this.window;
    if (state.recvOutstanding > state.recvWindow) {
      this.finishStream(state, new Error("peer exceeded the stream window"));
      return false;
    }
    state.sendCredit = state.peerWindow;
    const waiters = state.creditWaiters;
    state.creditWaiters = [];
    for (const wake of waiters) wake();
    return true;
  }

  private async acceptStream(id: number, target: unknown, peerWindow: number | undefined): Promise<void> {
    // The peer's ids have the other parity; anything else is a protocol error, not a stream.
    if (this.streams.has(id) || id % 2 === (this.role === "plane" ? 0 : 1)) {
      this.send({ t: "stream.refused", id, code: "invalid_params", message: "stream id in use or not the peer's to open" });
      return;
    }
    if (!this.handlers.onStreamOpen) {
      this.send({ t: "stream.refused", id, code: "unsupported", message: "peer opens no streams" });
      return;
    }
    const state = this.createStream(id);
    this.grantPeerWindow(state, peerWindow);
    try {
      await this.handlers.onStreamOpen(target, state.stream);
    } catch (error) {
      const code = error instanceof StreamRefusedError ? error.code : "refused";
      const message = error instanceof Error ? error.message : String(error);
      this.finishStream(state, new StreamRefusedError(code, message), false);
      this.send({ t: "stream.refused", id, code, message });
      return;
    }
    if (!state.finished) this.send({ t: "stream.opened", id, window: this.window });
  }

  private createStream(id: number): StreamState {
    const mux = this;
    const settle = Promise.withResolvers<void>();
    const state: StreamState = {
      id,
      stream: null as unknown as MuxStream,
      controller: null,
      inbound: [],
      inboundWaiter: null,
      sendCredit: 0,
      peerWindow: 0,
      recvWindow: this.window,
      recvOutstanding: 0,
      creditWaiters: [],
      localClosed: false,
      remoteClosed: false,
      finished: false,
      error: null,
      failure: null,
      settle,
    };
    const readable = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          state.controller = controller;
        },
        async pull(controller) {
          while (state.inbound.length === 0) {
            if (state.remoteClosed || state.finished) {
              if (!state.finished || state.remoteClosed) {
                try {
                  controller.close();
                } catch {
                  /* already closed or errored */
                }
              }
              return;
            }
            await new Promise<void>((resolve) => {
              state.inboundWaiter = resolve;
            });
            state.inboundWaiter = null;
          }
          const chunk = state.inbound.shift()!;
          controller.enqueue(chunk);
          state.recvOutstanding -= chunk.byteLength;
          // Credit is returned as the consumer drains, not as bytes arrive, so a
          // slow consumer slows its own sender and nobody else.
          if (!state.finished) mux.send({ t: "stream.credit", id, bytes: chunk.byteLength });
        },
        cancel() {
          state.inbound = [];
          mux.finishStream(state, new Error("readable cancelled"));
        },
      },
      { highWaterMark: 1 },
    );
    const stream: MuxStream = {
      id,
      readable,
      done: settle.promise,
      get failure() {
        return state.failure;
      },
      async write(bytes) {
        let offset = 0;
        while (offset < bytes.byteLength) {
          if (state.finished) throw state.error ?? new Error("stream is closed");
          if (state.localClosed) throw new Error("stream already ended");
          if (state.sendCredit <= 0) {
            await new Promise<void>((resolve) => state.creditWaiters.push(resolve));
            continue;
          }
          const size = Math.min(MAX_CHUNK, state.sendCredit, bytes.byteLength - offset);
          state.sendCredit -= size;
          mux.sendRaw(encodeDataFrame(id, bytes.subarray(offset, offset + size)));
          if (state.finished) throw state.error ?? new Error("stream is closed");
          offset += size;
        }
      },
      end() {
        if (state.finished || state.localClosed) return;
        state.localClosed = true;
        const waiters = state.creditWaiters;
        state.creditWaiters = [];
        for (const wake of waiters) wake();
        mux.send({ t: "stream.close", id });
        mux.maybeFinish(state);
      },
      reset(reason) {
        if (state.finished) return;
        mux.send({ t: "stream.reset", id, reason });
        mux.finishStream(state, new Error(`stream reset: ${reason}`), false);
      },
    };
    state.stream = stream;
    // A stream nobody awaits must not surface as an unhandled rejection.
    settle.promise.catch(() => {});
    this.streams.set(id, state);
    return state;
  }

  private maybeFinish(state: StreamState): void {
    if (state.localClosed && state.remoteClosed && !state.finished) {
      state.finished = true;
      state.error = new Error("stream is closed");
      this.streams.delete(state.id);
      const waiters = state.creditWaiters;
      state.creditWaiters = [];
      for (const wake of waiters) wake();
      state.settle.resolve();
    }
  }

  private finishStream(state: StreamState, error: Error, notifyPeer = true): void {
    if (state.finished) return;
    const opening = this.opening.get(state.id);
    if (opening) {
      this.opening.delete(state.id);
      clearTimeout(opening.timer);
      opening.reject(error instanceof StreamRefusedError ? error : new StreamRefusedError("failed", error.message));
    }
    state.finished = true;
    state.error = error;
    state.failure = error;
    state.inbound = [];
    this.streams.delete(state.id);
    if (notifyPeer && !this.closed && !(state.localClosed && state.remoteClosed)) {
      this.send({ t: "stream.reset", id: state.id, reason: error.message });
    }
    const waiters = state.creditWaiters;
    state.creditWaiters = [];
    for (const wake of waiters) wake();
    state.inboundWaiter?.();
    try {
      state.controller?.error(error);
    } catch {
      /* readable already closed */
    }
    state.settle.reject(error);
  }
}

/**
 * Write every chunk of `source` to `stream`, then half-close it (unless
 * `end` is false, for callers that decide the ending themselves). A failure on
 * either side ends the pipe: the source is cancelled when the stream fails,
 * the stream is reset when the source fails, even while a write waits for
 * credit or a read is idle. One subscription per side, however many chunks.
 */
export async function pipeToStream(
  source: ReadableStream<Uint8Array>,
  stream: MuxStream,
  options: { readonly end?: boolean } = {},
): Promise<void> {
  const reader = source.getReader();
  let sourceFailure: Error | null = null;
  // A failed destination ends the pending read; a failed source ends the pending write.
  const onStreamFailure = stream.done.catch((error: unknown) => {
    void reader.cancel(error).catch(() => {});
  });
  const onSourceFailure = reader.closed.catch((error: unknown) => {
    sourceFailure = error instanceof Error ? error : new Error(String(error));
    stream.reset(`source failed: ${sourceFailure.message}`);
  });
  const check = () => {
    if (sourceFailure) throw sourceFailure;
    if (stream.failure) throw stream.failure;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      check();
      if (done) break;
      await stream.write(value);
      check();
    }
    if (options.end !== false) {
      stream.end();
      // end() reports a transport failure through the stream, not by throwing.
      await Promise.resolve();
      check();
    }
  } catch (error) {
    stream.reset(`source failed: ${error instanceof Error ? error.message : String(error)}`);
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    await Promise.allSettled([onStreamFailure, onSourceFailure].map((p) => Promise.race([p, Promise.resolve()])));
    try {
      reader.releaseLock();
    } catch {
      /* a read may still be pending on a cancelled reader */
    }
  }
}

/** Every byte the peer sends until it half-closes. */
export async function readAllFromStream(stream: MuxStream): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream.readable) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
