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
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  /** Bytes received and not yet handed to the consumer. */
  inbound: Uint8Array[];
  inboundWaiter: (() => void) | null;
  sendCredit: number;
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
    this.window = options.window ?? DEFAULT_WINDOW;
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
    this.sendRaw(encodeControlFrame(frame));
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
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.rpcs.delete(id);
      reject(new RpcError("timeout", `${method} did not answer within ${options.timeoutMs ?? this.rpcTimeoutMs} ms`));
    }, options.timeoutMs ?? this.rpcTimeoutMs);
    this.rpcs.set(id, { resolve, reject, timer });
    this.send({ t: "rpc", id, method, params });
    return promise;
  }

  openStream(target: unknown, options: { timeoutMs?: number } = {}): Promise<MuxStream> {
    if (this.closed) return Promise.reject(new StreamRefusedError("closed", "link is closed"));
    let id = this.nextStreamId;
    while (this.streams.has(id)) id += 2;
    this.nextStreamId = id + 2;
    const state = this.createStream(id);
    const { promise, resolve, reject } = Promise.withResolvers<MuxStream>();
    const timer = setTimeout(() => {
      this.opening.delete(id);
      this.finishStream(state, new StreamRefusedError("timeout", "stream open timed out"));
      reject(new StreamRefusedError("timeout", "stream open timed out"));
    }, options.timeoutMs ?? this.streamOpenTimeoutMs);
    this.opening.set(id, { resolve, reject, timer });
    this.send({ t: "stream.open", id, target });
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
    if (!state || state.remoteClosed) return;
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
        pending.resolve(frame.result);
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
        void this.acceptStream(frame.id, frame.target);
        return;
      case "stream.opened": {
        const pending = this.opening.get(frame.id);
        const state = this.streams.get(frame.id);
        if (!pending || !state) return;
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
        state.sendCredit = Math.min(this.window, state.sendCredit + frame.bytes);
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
    try {
      const result = await this.handlers.onRpc(method, params);
      this.send({ t: "rpc.result", id, result: result ?? null });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : "internal";
      const message = error instanceof Error ? error.message : String(error);
      this.send({ t: "rpc.error", id, code, message });
    }
  }

  private async acceptStream(id: number, target: unknown): Promise<void> {
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
    try {
      await this.handlers.onStreamOpen(target, state.stream);
    } catch (error) {
      const code = error instanceof StreamRefusedError ? error.code : "refused";
      const message = error instanceof Error ? error.message : String(error);
      this.finishStream(state, new StreamRefusedError(code, message), false);
      this.send({ t: "stream.refused", id, code, message });
      return;
    }
    if (!state.finished) this.send({ t: "stream.opened", id });
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
      sendCredit: this.window,
      creditWaiters: [],
      localClosed: false,
      remoteClosed: false,
      finished: false,
      error: null,
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
          // Credit is returned as the consumer drains, not as bytes arrive, so a
          // slow consumer slows its own sender and nobody else.
          if (!state.finished) mux.send({ t: "stream.credit", id, bytes: chunk.byteLength });
        },
        cancel() {
          mux.finishStream(state, new Error("readable cancelled"));
        },
      },
      { highWaterMark: 1 },
    );
    const stream: MuxStream = {
      id,
      readable,
      done: settle.promise,
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
          offset += size;
        }
      },
      end() {
        if (state.finished || state.localClosed) return;
        state.localClosed = true;
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
    state.finished = true;
    state.error = error;
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

/** Write every chunk of `source` to `stream`, then half-close it. */
export async function pipeToStream(source: ReadableStream<Uint8Array>, stream: MuxStream): Promise<void> {
  const reader = source.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await stream.write(value);
    }
    stream.end();
  } catch (error) {
    stream.reset(`source failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    reader.releaseLock();
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
