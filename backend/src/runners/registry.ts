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

export interface LiveRunner {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly enrolledAt: string;
  readonly fingerprint: string;
  mux: Mux | null;
  hello: HelloFrame | null;
  capacity: HeartbeatFrame["capacity"] | null;
  logins: readonly string[];
  imageDigest: string | null;
  lastSeenAt: number;
  readonly forwarders: LoopbackForwarders;
}

function fingerprintOf(row: Pick<RunnerRow, "id" | "tokenHash">): string {
  return createHash("sha256").update(JSON.stringify(["runner", row.id, row.tokenHash])).digest("hex");
}

/** What the registry writes through to the runners table; tests keep it in memory. */
export interface RunnerPersistence {
  hello(runnerId: string, hello: HelloFrame): Promise<void>;
  heartbeat(runnerId: string, capacity: HeartbeatFrame["capacity"], logins: readonly string[], imageDigest: string | null): Promise<void>;
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
    const runner: LiveRunner = {
      id: row.id,
      orgId: row.orgId,
      userId: row.userId,
      name: row.name,
      enrolledAt: row.enrolledAt.toISOString(),
      fingerprint: fingerprintOf(row),
      mux: null,
      hello: null,
      capacity: row.capacity && "cpu" in row.capacity ? row.capacity : null,
      logins: row.logins ?? [],
      imageDigest: row.imageDigest,
      lastSeenAt: 0,
      forwarders: new LoopbackForwarders(),
    };
    this.live.set(row.id, runner);
    return runner;
  }

  forget(runnerId: string): void {
    const runner = this.live.get(runnerId);
    if (!runner) return;
    runner.forwarders.closeAll();
    runner.mux?.close("runner revoked");
    this.live.delete(runnerId);
  }

  /** A link authenticated and said hello: replace any older link for the same runner. */
  async attach(row: RunnerRow, mux: Mux, hello: HelloFrame): Promise<LiveRunner> {
    const runner = this.know(row);
    if (runner.mux && runner.mux !== mux) runner.mux.close("replaced by a newer link");
    runner.mux = mux;
    runner.hello = hello;
    runner.capacity = hello.capacity;
    runner.logins = hello.logins;
    runner.imageDigest = hello.imageDigest;
    runner.lastSeenAt = this.now();
    await this.persist.hello(runner.id, hello);
    return runner;
  }

  async heartbeat(runnerId: string, mux: Mux, frame: HeartbeatFrame): Promise<void> {
    const runner = this.live.get(runnerId);
    if (!runner || runner.mux !== mux) return;
    runner.capacity = frame.capacity;
    runner.logins = frame.logins;
    runner.imageDigest = frame.imageDigest;
    runner.lastSeenAt = this.now();
    await this.persist.heartbeat(runnerId, frame.capacity, frame.logins, frame.imageDigest);
  }

  async detach(runnerId: string, mux: Mux, reason: string): Promise<void> {
    const runner = this.live.get(runnerId);
    if (!runner || runner.mux !== mux) return;
    runner.mux = null;
    runner.forwarders.closeAll();
    mux.close(reason);
    await this.persist.offline(runnerId);
  }

  isOnline(runner: LiveRunner): boolean {
    return runner.mux !== null && !runner.mux.isClosed && this.now() - runner.lastSeenAt < OFFLINE_AFTER_MS;
  }

  /** The user's most recently seen online machine in this organisation, if any. */
  onlineForUser(orgId: string, userId: string): LiveRunner | null {
    let best: LiveRunner | null = null;
    for (const runner of this.live.values()) {
      if (runner.orgId !== orgId || runner.userId !== userId || !this.isOnline(runner)) continue;
      if (!best || runner.lastSeenAt > best.lastSeenAt) best = runner;
    }
    return best;
  }

  runner(runnerId: string): LiveRunner | null {
    return this.live.get(runnerId) ?? null;
  }

  /** Mark runners whose heartbeats stopped as offline; called on a timer. */
  async sweep(): Promise<string[]> {
    const gone: string[] = [];
    for (const runner of this.live.values()) {
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
      return runner.mux;
    };
    return {
      id: runner.id,
      userId: runner.userId,
      orgId: runner.orgId,
      fingerprint: runner.fingerprint,
      enrolledAt: runner.enrolledAt,
      get online() {
        return registry.isOnline(runner);
      },
      call: (method, params) => requireMux().rpc(method, params),
      openStream: (target) => requireMux().openStream(target) as Promise<MuxStream>,
      async forward(sandboxId, port) {
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
