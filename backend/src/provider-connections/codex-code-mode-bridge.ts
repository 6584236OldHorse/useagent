// Backend end of the code-mode tunnel: the subscription app-server dials its
// remote code-mode host over plain gRPC at a loopback URL, and each connection
// is carried byte for byte over a WebSocket to the forwarder in the sandbox
// (engines/codex-code-mode-sandbox.ts), which admits only this run's bearer.
import type { Socket, TCPSocketListener } from "bun";

const DEFAULT_MAX_CONNECTIONS = 4;
const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;

interface TunnelData {
  upstream: WebSocket | null;
  pending: Uint8Array[];
  pendingBytes: number;
  out: Uint8Array[];
  outBytes: number;
}

export interface CodexCodeModeBridge {
  /** The `--code-mode-host` URL for the app-server. */
  readonly url: string;
  /** Dial the sandbox with this run's bearer from now on (open tunnels stay). */
  rotateBearer(bearerToken: string): void;
  close(): void;
}

export function openCodexCodeModeBridge(input: {
  readonly upstreamUrl: string;
  readonly expectedUpstreamHost: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bearerToken: string;
  readonly maxConnections?: number;
  readonly maxPendingBytes?: number;
}): CodexCodeModeBridge {
  const upstream = new URL(input.upstreamUrl);
  if ((upstream.protocol !== "ws:" && upstream.protocol !== "wss:") || upstream.username || upstream.password) {
    throw new Error("Codex code-mode bridge requires a websocket URL");
  }
  if (upstream.host !== input.expectedUpstreamHost) {
    throw new Error("Codex code-mode bridge upstream host mismatch");
  }
  if (!input.bearerToken) throw new Error("Codex code-mode bridge requires a bearer");
  let bearerToken = input.bearerToken;
  const maxConnections = input.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxPendingBytes = input.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  const sockets = new Set<Socket<TunnelData>>();
  let closed = false;

  const listener: TCPSocketListener<TunnelData> = Bun.listen<TunnelData>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { upstream: null, pending: [], pendingBytes: 0, out: [], outBytes: 0 };
        if (closed || sockets.size >= maxConnections) {
          socket.end();
          return;
        }
        sockets.add(socket);
        const remote = new WebSocket(input.upstreamUrl, {
          headers: { ...input.headers, authorization: `Bearer ${bearerToken}` },
        });
        remote.binaryType = "arraybuffer";
        socket.data.upstream = remote;
        remote.onopen = () => {
          for (const chunk of socket.data.pending.splice(0)) remote.send(chunk);
          socket.data.pendingBytes = 0;
        };
        // The sandbox side is untrusted: what the app-server has not read yet is
        // bounded, so a flood ends the connection instead of growing this process.
        remote.onmessage = (event) => {
          const chunk = event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : typeof event.data === "string" ? new TextEncoder().encode(event.data) : null;
          if (chunk && !write(socket, chunk, maxPendingBytes)) {
            remote.close(1009, "code-mode backlog limit exceeded");
            socket.end();
          }
        };
        remote.onerror = () => socket.end();
        remote.onclose = () => socket.end();
      },
      data(socket, chunk) {
        const remote = socket.data.upstream;
        if (remote?.readyState === WebSocket.OPEN) {
          remote.send(chunk);
          return;
        }
        socket.data.pendingBytes += chunk.byteLength;
        if (socket.data.pendingBytes > maxPendingBytes) {
          socket.end();
          return;
        }
        socket.data.pending.push(new Uint8Array(chunk));
      },
      drain(socket) {
        while (socket.data.out.length > 0) {
          const chunk = socket.data.out[0]!;
          const written = Math.max(socket.write(chunk), 0);
          socket.data.outBytes -= written;
          if (written < chunk.byteLength) {
            socket.data.out[0] = chunk.subarray(written);
            return;
          }
          socket.data.out.shift();
        }
      },
      close(socket) {
        sockets.delete(socket);
        try {
          socket.data.upstream?.close(1000, "code-mode client closed");
        } catch {
          // An upstream that never opened has nothing to close.
        }
        socket.data.upstream = null;
      },
    },
  });

  return {
    url: `http://127.0.0.1:${listener.port}`,
    rotateBearer(next) {
      if (!next) throw new Error("Codex code-mode bridge requires a bearer");
      bearerToken = next;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.end();
      listener.stop(true);
    },
  };
}

/** Write or queue `chunk`; false once the unread backlog passes `limit`. */
function write(socket: Socket<TunnelData>, chunk: Uint8Array, limit: number): boolean {
  const written = socket.data.out.length > 0 ? 0 : Math.max(socket.write(chunk), 0);
  if (written < chunk.byteLength) {
    socket.data.out.push(chunk.subarray(written));
    socket.data.outBytes += chunk.byteLength - written;
  }
  return socket.data.outBytes <= limit;
}
