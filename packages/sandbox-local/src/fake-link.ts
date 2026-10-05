// An in-memory link and directory for tests and dry runs: calls answer from a
// script, streams are pipe pairs. The control plane's conformance run drives
// the local plugin through this instead of a machine.

import type { SandboxLink, SandboxLinkDirectory, SandboxLinkStream } from "@useagent/sandbox-contract";

export interface LinkStreamPair {
  readonly near: SandboxLinkStream;
  readonly far: SandboxLinkStream;
}

function pipeEnd(id: number, peer: { push(bytes: Uint8Array): void; close(): void; fail(reason: Error): void }) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const settle = Promise.withResolvers<void>();
  settle.promise.catch(() => {});
  const state = { localClosed: false, remoteClosed: false, finished: false };
  const finish = () => {
    if (state.localClosed && state.remoteClosed && !state.finished) {
      state.finished = true;
      settle.resolve();
    }
  };
  const end: SandboxLinkStream & { push(bytes: Uint8Array): void; close(): void; fail(reason: Error): void; peer: typeof peer } = {
    id,
    readable,
    done: settle.promise,
    peer,
    async write(bytes) {
      if (state.finished || state.localClosed) throw new Error("stream is closed");
      end.peer.push(bytes.slice());
    },
    end() {
      if (state.localClosed) return;
      state.localClosed = true;
      end.peer.close();
      finish();
    },
    reset(reason) {
      if (state.finished) return;
      state.finished = true;
      const error = new Error(`stream reset: ${reason}`);
      try {
        controller.error(error);
      } catch {
        /* already closed */
      }
      settle.reject(error);
      end.peer.fail(new Error(`stream reset by peer: ${reason}`));
    },
    push(bytes) {
      if (state.remoteClosed || state.finished) return;
      controller.enqueue(bytes);
    },
    close() {
      if (state.remoteClosed) return;
      state.remoteClosed = true;
      try {
        controller.close();
      } catch {
        /* already closed */
      }
      finish();
    },
    fail(reason) {
      if (state.finished) return;
      state.finished = true;
      try {
        controller.error(reason);
      } catch {
        /* already closed */
      }
      settle.reject(reason);
    },
  };
  return end;
}

let nextStreamId = 2;

/** Two connected stream ends; what one writes the other reads. */
export function linkStreamPair(): LinkStreamPair {
  const id = nextStreamId;
  nextStreamId += 2;
  const placeholder = { push() {}, close() {}, fail() {} };
  const near = pipeEnd(id, placeholder);
  const far = pipeEnd(id, placeholder);
  near.peer = far;
  far.peer = near;
  return { near, far };
}

export interface FakeLinkOptions {
  readonly id: string;
  readonly userId?: string | null;
  readonly orgId?: string | null;
  readonly fingerprint?: string;
  readonly enrolledAt?: string;
  readonly online?: boolean;
  /** Answer a call, or throw an error carrying a `code`. */
  readonly onCall?: (method: string, params: unknown) => Promise<unknown> | unknown;
  /** Serve the far end of a stream the provider opened. */
  readonly onStream?: (target: unknown, far: SandboxLinkStream) => void | Promise<void>;
}

export interface FakeLink extends SandboxLink {
  online: boolean;
  readonly calls: Array<{ method: string; params: unknown; timeoutMs?: number }>;
  readonly forwards: Array<{ sandboxId: string; port: number }>;
  readonly released: string[];
}

export function fakeLink(spec: FakeLinkOptions): FakeLink {
  const link: FakeLink = {
    id: spec.id,
    userId: spec.userId ?? "user-1",
    orgId: spec.orgId ?? "org-1",
    fingerprint: spec.fingerprint ?? "f".repeat(64),
    enrolledAt: spec.enrolledAt ?? "2026-09-08T00:00:00.000Z",
    online: spec.online ?? true,
    calls: [],
    forwards: [],
    released: [],
    async call(method, params, options) {
      const timeoutMs = options?.timeoutMs;
      link.calls.push({ method, params, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
      if (!spec.onCall) throw Object.assign(new Error(`no handler for ${method}`), { code: "unsupported" });
      return spec.onCall(method, params);
    },
    async openStream(target) {
      const pair = linkStreamPair();
      if (!spec.onStream) throw Object.assign(new Error("no stream handler"), { code: "unsupported" });
      await spec.onStream(target, pair.far);
      return pair.near;
    },
    async forward(sandboxId, port) {
      link.forwards.push({ sandboxId, port });
      return { host: "127.0.0.1", port: 40_000 + link.forwards.length };
    },
    async release(sandboxId) {
      link.released.push(sandboxId);
    },
  };
  return link;
}

export function fakeLinkDirectory(links: readonly SandboxLink[] = []): SandboxLinkDirectory & { add(link: SandboxLink): void } {
  const byId = new Map(links.map((link) => [link.id, link] as const));
  return {
    get: (id) => byId.get(id) ?? null,
    list: () => [...byId.values()],
    add: (link) => {
      byId.set(link.id, link);
    },
  };
}
