// Loopback forwarders: a TCP listener on 127.0.0.1 per (sandbox, port) whose
// every accepted connection becomes one stream over the runner's link. Preview
// links point at these, so the port, desktop and runtime proxies keep fetching
// plain HTTP and WebSockets without knowing a runner exists.
//
// Only this process can reach a listener (loopback, single-backend host). The
// set is bounded per machine and idle listeners are closed, so a user cannot
// grow the plane's descriptor table by asking for port after port.

import type { MuxStream } from "@useagent/runner-protocol";

type Socket = Bun.Socket<{ stream: MuxStream | null; queue: Uint8Array[]; writing: boolean; closed: boolean }>;

/** Bytes a slow link may leave queued from one browser connection before it is dropped. */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/** Listeners one machine may hold at once (every retained thread's runtime, terminal, desktop and a few previews). */
export const MAX_FORWARDERS_PER_RUNNER = 64;
/** A listener with no connection for this long is closed; the next preview re-resolves it. */
export const FORWARDER_IDLE_MS = 10 * 60 * 1000;

export interface Forwarder {
  readonly host: string;
  readonly port: number;
  close(): void;
}

interface Entry {
  forwarder: Forwarder;
  connections: number;
  lastActivity: number;
}

export class LoopbackForwarders {
  private readonly listeners = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(options: { now?: () => number; readonly max?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.max = options.max ?? MAX_FORWARDERS_PER_RUNNER;
  }

  private readonly max: number;

  /** The loopback address for `sandboxId:port`, listening from now on. */
  address(sandboxId: string, port: number, open: () => Promise<MuxStream>): Forwarder {
    const key = `${sandboxId}:${port}`;
    const existing = this.listeners.get(key);
    if (existing) {
      existing.lastActivity = this.now();
      return existing.forwarder;
    }
    this.sweep();
    if (this.listeners.size >= this.max) {
      throw new Error(`this machine already serves ${this.max} preview ports; close some before opening more`);
    }
    const entry: Entry = { forwarder: null as unknown as Forwarder, connections: 0, lastActivity: this.now() };
    const forwarders = this;
    const listener = Bun.listen<Socket["data"]>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.data = { stream: null, queue: [], writing: false, closed: false };
          entry.connections += 1;
          entry.lastActivity = forwarders.now();
          let opening: Promise<MuxStream>;
          try {
            opening = open();
          } catch (error) {
            opening = Promise.reject(error instanceof Error ? error : new Error(String(error)));
          }
          void opening.then(
            (stream) => {
              if (socket.data.closed) {
                stream.reset("browser side closed before the link answered");
                return;
              }
              socket.data.stream = stream;
              void pipeToSocket(stream, socket);
              void drain(socket);
              void stream.done.catch(() => {}).finally(() => {
                if (!socket.data.closed) socket.end();
              });
            },
            () => {
              if (!socket.data.closed) socket.end();
            },
          );
        },
        data(socket, bytes) {
          const data = socket.data;
          if (data.closed) return;
          entry.lastActivity = forwarders.now();
          data.queue.push(new Uint8Array(bytes));
          if (data.queue.reduce((n, chunk) => n + chunk.byteLength, 0) > MAX_QUEUED_BYTES) {
            data.stream?.reset("browser side outran the link");
            socket.end();
            return;
          }
          void drain(socket);
        },
        close(socket) {
          const data = socket.data;
          if (data.closed) return;
          data.closed = true;
          entry.connections = Math.max(0, entry.connections - 1);
          entry.lastActivity = forwarders.now();
          data.stream?.end();
        },
        error(socket) {
          socket.data.closed = true;
          socket.data.stream?.reset("browser side errored");
        },
        drain() {
          /* pipeToSocket awaits write() return values instead */
        },
      },
    });
    entry.forwarder = {
      host: "127.0.0.1",
      port: listener.port,
      close: () => {
        listener.stop(true);
        this.listeners.delete(key);
      },
    };
    this.listeners.set(key, entry);
    return entry.forwarder;
  }

  /** Close listeners that have had no connection for FORWARDER_IDLE_MS. */
  sweep(): number {
    let closed = 0;
    for (const entry of [...this.listeners.values()]) {
      if (entry.connections === 0 && this.now() - entry.lastActivity >= FORWARDER_IDLE_MS) {
        entry.forwarder.close();
        closed += 1;
      }
    }
    return closed;
  }

  release(sandboxId: string): void {
    for (const [key, entry] of this.listeners) {
      if (key.startsWith(`${sandboxId}:`)) entry.forwarder.close();
    }
  }

  closeAll(): void {
    for (const entry of [...this.listeners.values()]) entry.forwarder.close();
  }

  get size(): number {
    return this.listeners.size;
  }
}

/** Queued browser bytes into the link stream, in order, one writer at a time. */
async function drain(socket: Socket): Promise<void> {
  const data = socket.data;
  if (data.writing || !data.stream) return;
  data.writing = true;
  try {
    while (data.queue.length > 0) {
      const chunk = data.queue.shift()!;
      await data.stream.write(chunk);
    }
    if (data.closed) data.stream.end();
  } catch {
    if (!data.closed) socket.end();
  } finally {
    data.writing = false;
  }
}

/** Link stream bytes to the browser socket; half-close the socket when the stream ends. */
async function pipeToSocket(stream: MuxStream, socket: Socket): Promise<void> {
  try {
    for await (const chunk of stream.readable) {
      let offset = 0;
      while (offset < chunk.byteLength && !socket.data.closed) {
        const written = socket.write(chunk.subarray(offset));
        if (written > 0) offset += written;
        else await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    if (!socket.data.closed) socket.shutdown();
  } catch {
    if (!socket.data.closed) socket.end();
  }
}
