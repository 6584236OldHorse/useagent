// The tool gateway's view of runners. It holds no links; it knows the enrolled
// machines from the database, refreshed whenever a run's local sandbox is
// resolved, and reaches one through the backend's bridge (./bridge.ts) with a
// capability for the run being served. The run is captured when the link is
// handed out, inside resolveRunSandbox, so the handles built from it keep
// working after the resolution returns.

import { createHash } from "node:crypto";
import { ne } from "drizzle-orm";
import type { SandboxLink, SandboxLinkDirectory, SandboxLinkStream } from "@useagent/sandbox-contract";
import { db } from "../db/client";
import { runners } from "../db/schema";
import { mintToolToken } from "../knowledge/gateway/token";
import { type BridgeControl, MAX_BRIDGE_QUEUE_BYTES, parseBridgeControl } from "./bridge";
import { type RunnerBridgeContext, currentRunnerBridgeContext } from "./bridge-context";
import type { LiveRunner } from "./registry";
import type { RunnerRow } from "./store";

const CALL_GRACE_MS = 5000;
const TOKEN_TTL_MS = 60_000;

/** Exactly the columns the gateway's database role may read (db/gateway-grants.ts). */
export const KNOWN_RUNNER_COLUMNS = {
  id: runners.id,
  orgId: runners.orgId,
  userId: runners.userId,
  name: runners.name,
  platform: runners.platform,
  status: runners.status,
  logins: runners.logins,
  enrolledAt: runners.enrolledAt,
  tokenHash: runners.tokenHash,
} as const;

export type KnownRunnerRow = Pick<RunnerRow, keyof typeof KNOWN_RUNNER_COLUMNS>;

export type KnownRunner = Pick<LiveRunner, "id" | "orgId" | "userId" | "name" | "enrolledAt" | "fingerprint" | "logins"> & { readonly online: boolean };

function fingerprintOf(row: Pick<RunnerRow, "id" | "tokenHash">): string {
  return createHash("sha256").update(JSON.stringify(["runner", row.id, row.tokenHash])).digest("hex");
}

export interface RemoteDirectoryOptions {
  /** The backend's origin, USEAGENT_API_ORIGIN in the gateway's environment. */
  readonly origin: () => string | null;
  /** Every enrolled machine (default: the runners table through the gateway's role). */
  readonly rows?: () => Promise<readonly KnownRunnerRow[]>;
  readonly fetch?: typeof fetch;
  readonly connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

export class RemoteRunnerDirectory implements SandboxLinkDirectory {
  private readonly known = new Map<string, KnownRunner>();

  constructor(private readonly options: RemoteDirectoryOptions) {}

  /** Every enrolled machine, as the backend last recorded it; the gateway never holds a link. */
  async refresh(): Promise<number> {
    const rows = await (this.options.rows ?? (() => db.select(KNOWN_RUNNER_COLUMNS).from(runners).where(ne(runners.status, "revoked"))))();
    this.known.clear();
    for (const row of rows) this.remember(row);
    return rows.length;
  }

  remember(row: KnownRunnerRow): KnownRunner {
    const runner: KnownRunner = {
      id: row.id,
      orgId: row.orgId,
      userId: row.userId,
      name: row.name,
      enrolledAt: row.enrolledAt.toISOString(),
      fingerprint: fingerprintOf(row),
      logins: row.logins ?? [],
      online: row.status === "online",
    };
    this.known.set(row.id, runner);
    return runner;
  }

  runner(runnerId: string): KnownRunner | null {
    return this.known.get(runnerId) ?? null;
  }

  get(id: string): SandboxLink | null {
    const runner = this.known.get(id);
    return runner ? this.link(runner, currentRunnerBridgeContext()) : null;
  }

  list(): readonly SandboxLink[] {
    const context = currentRunnerBridgeContext();
    return [...this.known.values()].map((runner) => this.link(runner, context));
  }

  private origin(): string {
    const value = this.options.origin();
    if (!value) throw new Error("USEAGENT_API_ORIGIN names no control plane for the runner bridge");
    return value;
  }

  /** A fresh capability for the run captured with the link; the backend admits it only while that run is running. */
  private token(runner: KnownRunner, context: RunnerBridgeContext | null): string {
    if (!context) throw new Error("a local sandbox can only be reached for a run being served");
    if (context.orgId !== runner.orgId) throw new Error("the run and the machine belong to different organisations");
    return mintToolToken({ orgId: context.orgId, userId: context.userId, threadId: context.threadId, runId: context.runId }, TOKEN_TTL_MS);
  }

  private link(runner: KnownRunner, context: RunnerBridgeContext | null): SandboxLink {
    const directory = this;
    return {
      id: runner.id,
      userId: runner.userId,
      orgId: runner.orgId,
      fingerprint: runner.fingerprint,
      enrolledAt: runner.enrolledAt,
      online: runner.online,
      async call(method, params, options) {
        const doFetch = directory.options.fetch ?? fetch;
        const timeoutMs = options?.timeoutMs;
        const response = await doFetch(`${directory.origin()}/api/internal/runners/bridge/call`, {
          method: "POST",
          headers: { authorization: `Bearer ${directory.token(runner, context)}`, "content-type": "application/json" },
          body: JSON.stringify({ runnerId: runner.id, method, params, timeoutMs }),
          signal: AbortSignal.timeout((timeoutMs ?? 30_000) + CALL_GRACE_MS),
        });
        const body = (await response.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
        if (response.ok && body && "result" in body) return body.result;
        const error = body?.error;
        if (typeof error === "object" && error !== null) {
          const { code, message } = error as { code?: string; message?: string };
          throw Object.assign(new Error(message ?? `bridge call failed (${response.status})`), { code: code ?? "internal" });
        }
        throw Object.assign(new Error(typeof error === "string" ? error : `bridge call failed (${response.status})`), { code: response.status === 401 || response.status === 403 ? "refused" : "internal" });
      },
      openStream: (target) => directory.openStream(runner, context, target),
      async forward() {
        throw new Error("preview links are served by the control plane process, not the gateway");
      },
      async release() {},
    };
  }

  private openStream(runner: KnownRunner, context: RunnerBridgeContext | null, target: unknown): Promise<SandboxLinkStream> {
    const url = new URL(`${this.origin()}/api/internal/runners/bridge/stream`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("runnerId", runner.id);
    url.searchParams.set("target", Buffer.from(JSON.stringify(target), "utf8").toString("base64url"));
    const headers = { authorization: `Bearer ${this.token(runner, context)}` };
    const socket = (this.options.connect ?? ((u, h) => new WebSocket(u, { headers: h } as unknown as string[])))(url.toString(), headers);
    socket.binaryType = "arraybuffer";
    return new Promise<SandboxLinkStream>((resolve, reject) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      // Bytes the consumer has not read yet count against the same bound the bridge applies.
      const readable = new ReadableStream<Uint8Array>(
        {
          start(c) {
            controller = c;
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: MAX_BRIDGE_QUEUE_BYTES }),
      );
      const settle = Promise.withResolvers<void>();
      settle.promise.catch(() => {});
      let opened = false;
      let localEnded = false;
      let finished = false;
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        try {
          controller.error(error);
        } catch {
          /* already closed */
        }
        settle.reject(error);
        if (!opened) reject(error);
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      };
      const stream: SandboxLinkStream = {
        id: 0,
        readable,
        done: settle.promise,
        async write(bytes) {
          if (finished) throw new Error("stream is closed");
          socket.send(bytes);
        },
        end() {
          if (localEnded || finished) return;
          localEnded = true;
          socket.send(JSON.stringify({ t: "end" } satisfies BridgeControl));
        },
        reset(reason) {
          if (finished) return;
          try {
            socket.send(JSON.stringify({ t: "reset", reason } satisfies BridgeControl));
          } catch {
            /* socket gone */
          }
          fail(new Error(`stream reset: ${reason}`));
        },
      };
      socket.onmessage = (event) => {
        const data = event.data as string | ArrayBuffer;
        if (typeof data === "string") {
          const control = parseBridgeControl(data);
          if (!control) return;
          if (control.t === "opened") {
            opened = true;
            resolve(stream);
          } else if (control.t === "refused") {
            fail(Object.assign(new Error(control.message), { code: control.code }));
          } else if (control.t === "end") {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          } else if (control.t === "reset") {
            fail(new Error(`stream reset by peer: ${control.reason}`));
          }
          return;
        }
        if (finished) return;
        if ((controller.desiredSize ?? 0) - data.byteLength < 0) {
          stream.reset("the consumer holds more than the bridge may queue");
          return;
        }
        try {
          controller.enqueue(new Uint8Array(data));
        } catch {
          /* consumer gone */
        }
      };
      socket.onerror = () => fail(new Error("bridge socket failed"));
      // The bridge closes 1000 exactly when the sandbox's stream is done in both directions.
      socket.onclose = (event) => {
        if (finished) return;
        if (opened && event.code === 1000) {
          finished = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
          settle.resolve();
          return;
        }
        fail(new Error(opened ? `bridge closed (${event.code})` : `bridge refused (${event.code} ${event.reason})`));
      };
    });
  }
}

export const remoteRunnerDirectory = new RemoteRunnerDirectory({
  origin: () => {
    const raw = process.env.USEAGENT_API_ORIGIN?.trim();
    if (!raw) return null;
    try {
      return new URL(raw).origin;
    } catch {
      return null;
    }
  },
});
