// The live side of runners: which machines hold a link right now, their
// capacity and logins, and the SandboxLinkDirectory the local provider reads.
// Every enrolled runner is known here (loaded at boot, added on enrolment) so
// a sandbox on a machine that is offline still resolves to its runner and
// fails with "not connected" instead of "not found".

import { createHash } from "node:crypto";
import type { HeartbeatFrame, HelloFrame, Mux, MuxStream, StreamTarget } from "@useagent/runner-protocol";
import type { SandboxLink, SandboxLinkDirectory } from "@useagent/sandbox-contract";
import { LoopbackForwarders } from "./loopback";
import { type RunnerRow, markStaleRunnersOffline, recordHeartbeat, recordHello, recordOffline } from "./store";
import { db } from "../db/client";
import { runners } from "../db/schema";
import { ne } from "drizzle-orm";

/** Missed heartbeats before a runner counts as gone (the runner beats every 15 s). */
export const OFFLINE_AFTER_MS = 45_000;

/** Close code when the control plane drops a link it no longer trusts to be live; the runner reconnects. */
export const CLOSE_LINK_DROPPED = 4410;

/** The socket behind a link, closed by the registry when it drops the link so the runner reconnects. */
export interface RunnerTransport {
  close(code: number, reason: string): void;
}

export interface LiveRunner {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly enrolledAt: string;
  readonly fingerprint: string;
  mux: Mux | null;
  transport: RunnerTransport | null;
  hello: HelloFrame | null;
  capacity: HeartbeatFrame["capacity"] | null;
  logins: readonly string[];
  imageDigest: string | null;
  /** The image name and digest this machine was told to pull in its welcome. */
  image: { readonly ref: string; readonly digest: string } | null;
  lastSeenAt: number;
  readonly forwarders: LoopbackForwarders;
}

function fingerprintOf(row: Pick<RunnerRow, "id" | "tokenHash">): string {
  return createHash("sha256").update(JSON.stringify(["runner", row.id, row.tokenHash])).digest("hex");
}

/** What the registry writes through to the runners table; tests keep it in memory. */
export interface RunnerPersistence {
  /** False when the runner is revoked: the link must not attach. */
  hello(runnerId: string, hello: HelloFrame): Promise<boolean>;
  /** False once the runner is revoked: the link is detached. */
  heartbeat(runnerId: string, capacity: HeartbeatFrame["capacity"], logins: readonly string[], imageDigest: string | null): Promise<boolean>;
  offline(runnerId: string): Promise<void>;
  markStale(exceptIds: readonly string[]): Promise<number>;
}

const dbPersistence: RunnerPersistence = {
  hello: recordHello,
  heartbeat: recordHeartbeat,
  offline: recordOffline,
  markStale: markStaleRunnersOffline,
};

export class RunnerRegistry {
  private readonly live = new Map<string, LiveRunner>();
  /** The most recent attach per runner, so an older hello that finishes recording later cannot win. */
  private readonly attaching = new Map<string, number>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly persist: RunnerPersistence;

  constructor(options: { now?: () => number; persist?: RunnerPersistence } = {}) {
    this.now = options.now ?? Date.now;
    this.persist = options.persist ?? dbPersistence;
  }

  /** Every enrolled runner from the database, offline until it says hello. */
  async load(): Promise<number> {
    const rows = await db.select().from(runners).where(ne(runners.status, "revoked"));
    for (const row of rows) this.know(row);
    await this.persist.markStale([...this.live.keys()].filter((id) => this.live.get(id)?.mux));
    return rows.length;
  }

  know(row: RunnerRow): LiveRunner {
    const existing = this.live.get(row.id);
    if (existing) return existing;
    if (row.status === "revoked") throw new Error(`runner ${row.id} is revoked`);
    const runner: LiveRunner = {
      id: row.id,
      orgId: row.orgId,
      userId: row.userId,
      name: row.name,
      enrolledAt: row.enrolledAt.toISOString(),
      fingerprint: fingerprintOf(row),
      mux: null,
      transport: null,
      hello: null,
      capacity: row.capacity && "cpu" in row.capacity ? row.capacity : null,
      logins: row.logins ?? [],
      imageDigest: row.imageDigest,
      lastSeenAt: 0,
      image: null,
      forwarders: new LoopbackForwarders(),
    };
    this.live.set(row.id, runner);
    return runner;
  }

  forget(runnerId: string): void {
    // A hello still being recorded for this runner must not install it afterwards.
    this.attaching.set(runnerId, (this.attaching.get(runnerId) ?? 0) + 1);
    const runner = this.live.get(runnerId);
    if (!runner) return;
    runner.forwarders.closeAll();
    runner.mux?.close("runner revoked");
    runner.transport?.close(4401, "runner revoked");
    this.live.delete(runnerId);
  }

  /**
   * A link authenticated and said hello: replace any older link for the same
   * runner. Null when the runner was revoked after its token resolved, in
   * which case nothing is attached and the caller closes the socket.
   */
  async attach(row: RunnerRow, mux: Mux, hello: HelloFrame, transport: RunnerTransport | null = null): Promise<LiveRunner | null> {
    const ticket = (this.attaching.get(row.id) ?? 0) + 1;
    this.attaching.set(row.id, ticket);
    if (row.status === "revoked" || !(await this.persist.hello(row.id, hello))) {
      this.forget(row.id);
      return null;
    }
    if (mux.isClosed || this.attaching.get(row.id) !== ticket) {
      mux.close("superseded by a newer link");
      transport?.close(CLOSE_LINK_DROPPED, "superseded by a newer link");
      // The hello just recorded this link as online; with no newer link speaking for the machine, that is wrong.
      if (this.attaching.get(row.id) === ticket && !this.live.get(row.id)?.mux) await this.persist.offline(row.id);
      return null;
    }
    const runner = this.know(row);
    if (runner.mux && runner.mux !== mux) {
      runner.mux.close("replaced by a newer link");
      runner.transport?.close(CLOSE_LINK_DROPPED, "replaced by a newer link");
    }
    runner.mux = mux;
    runner.transport = transport;
    runner.hello = hello;
    runner.capacity = hello.capacity;
    runner.logins = hello.logins;
    runner.imageDigest = hello.imageDigest;
    runner.lastSeenAt = this.now();
    return runner;
  }

  /** False once the runner is revoked; the link is detached and forgotten. */
  async heartbeat(runnerId: string, mux: Mux, frame: HeartbeatFrame): Promise<boolean> {
    const runner = this.live.get(runnerId);
    if (!runner || runner.mux !== mux) return false;
    if (!(await this.persist.heartbeat(runnerId, frame.capacity, frame.logins, frame.imageDigest))) {
      this.forget(runnerId);
      return false;
    }
    runner.capacity = frame.capacity;
    runner.logins = frame.logins;
    runner.imageDigest = frame.imageDigest;
    runner.lastSeenAt = this.now();
    return true;
  }

  async detach(runnerId: string, mux: Mux, reason: string): Promise<void> {
    const runner = this.live.get(runnerId);
    if (!runner || runner.mux !== mux) return;
    runner.mux = null;
    const transport = runner.transport;
    runner.transport = null;
    runner.forwarders.closeAll();
    mux.close(reason);
    // Closing the mux alone leaves the socket open and deaf; the runner must see the link end to reconnect.
    transport?.close(CLOSE_LINK_DROPPED, reason);
    await this.persist.offline(runnerId);
  }

  isOnline(runner: LiveRunner): boolean {
    return runner.mux !== null && !runner.mux.isClosed && this.now() - runner.lastSeenAt < OFFLINE_AFTER_MS;
  }

  /**
   * Connected and holding the sandbox image. A runner still pulling the image
   * heartbeats without a digest and refuses every call until it has one, so
   * it is not offered work; on its first pull that can be a long while.
   */
  isReady(runner: LiveRunner): boolean {
    return this.isOnline(runner) && runner.imageDigest !== null;
  }

  /** The user's most recently seen machine in this organisation that can take work, if any. */
  onlineForUser(orgId: string, userId: string): LiveRunner | null {
    let best: LiveRunner | null = null;
    for (const runner of this.live.values()) {
      if (runner.orgId !== orgId || runner.userId !== userId || !this.isReady(runner)) continue;
      if (!best || runner.lastSeenAt > best.lastSeenAt) best = runner;
    }
    return best;
  }

  runner(runnerId: string): LiveRunner | null {
    return this.live.get(runnerId) ?? null;
  }

  /** Mark runners whose heartbeats stopped as offline and close idle forwarders; called on a timer. */
  async sweep(): Promise<string[]> {
    const gone: string[] = [];
    for (const runner of this.live.values()) {
      runner.forwarders.sweep();
      if (runner.mux && !this.isOnline(runner)) {
        const mux = runner.mux;
        await this.detach(runner.id, mux, "heartbeats stopped");
        gone.push(runner.id);
      }
    }
    return gone;
  }

  startSweeper(intervalMs = 15_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      void this.sweep().catch(() => {});
    }, intervalMs);
    this.sweeper.unref?.();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** The directory the local sandbox provider is built with. */
  get directory(): SandboxLinkDirectory {
    return {
      get: (id) => {
        const runner = this.live.get(id);
        return runner ? this.link(runner) : null;
      },
      list: () => [...this.live.values()].map((runner) => this.link(runner)),
    };
  }

  private link(runner: LiveRunner): SandboxLink {
    const registry = this;
    const requireMux = (): Mux => {
      if (!runner.mux || !registry.isOnline(runner)) throw new Error(`the machine behind runner ${runner.id} is not connected`);
      if (!registry.isReady(runner)) throw new Error(`the machine behind runner ${runner.id} is still preparing its sandbox image`);
      return runner.mux;
    };
    return {
      id: runner.id,
      userId: runner.userId,
      orgId: runner.orgId,
      fingerprint: runner.fingerprint,
      enrolledAt: runner.enrolledAt,
      get online() {
        return registry.isReady(runner);
      },
      get image() {
        return runner.image ?? undefined;
      },
      call: (method, params, options) => requireMux().rpc(method, params, options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      openStream: (target) => requireMux().openStream(target) as Promise<MuxStream>,
      async forward(sandboxId, port) {
        // Connectivity first: a machine that is away gets no listener allocated for it.
        requireMux();
        const forwarder = runner.forwarders.address(sandboxId, port, () =>
          requireMux().openStream({ kind: "port", sandboxId, port } satisfies StreamTarget),
        );
        return { host: forwarder.host, port: forwarder.port };
      },
      async release(sandboxId) {
        runner.forwarders.release(sandboxId);
      },
    };
  }
}

export const runnerRegistry = new RunnerRegistry();
