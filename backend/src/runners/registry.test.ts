// The live side of runners under competing links: the newest hello wins even
// when an older one finishes recording later or closed while it was recorded.

import { describe, expect, test } from "bun:test";
import { type HelloFrame, Mux, PROTOCOL_VERSION } from "@useagent/runner-protocol";
import { CLOSE_LINK_DROPPED, RunnerRegistry, type RunnerPersistence } from "./registry";
import { type RunnerRow, hashRunnerToken } from "./store";

function row(): RunnerRow {
  return {
    id: "rn_a",
    orgId: "org-a",
    userId: "user-1",
    name: "laptop",
    platform: "darwin-arm64",
    backend: "docker",
    version: "0.1.0",
    protocol: 1,
    capacity: { cpu: 4, memoryMb: 8192, sandboxes: 0 },
    logins: [],
    imageDigest: null,
    status: "offline",
    lastSeenAt: null,
    enrolledAt: new Date("2026-09-08T00:00:00Z"),
    revokedAt: null,
    tokenHash: hashRunnerToken("uart_rn_a.secret"),
  };
}

const hello: HelloFrame = {
  t: "hello",
  runnerId: "rn_a",
  version: "0.1.0",
  protocol: PROTOCOL_VERSION,
  backend: "docker",
  platform: "darwin-arm64",
  capacity: { cpu: 4, memoryMb: 8192, sandboxes: 0 },
  logins: [],
  imageDigest: null,
};

function persistence(hello: RunnerPersistence["hello"], offline: string[] = []): RunnerPersistence {
  return {
    hello,
    heartbeat: async () => true,
    offline: async (id) => {
      offline.push(id);
    },
    markStale: async () => 0,
  };
}

function transport() {
  const closes: Array<{ code: number; reason: string }> = [];
  return { closes, close: (code: number, reason: string) => closes.push({ code, reason }) };
}

function mux(): Mux {
  return new Mux("plane", { send: () => {} });
}

describe("runner registry", () => {
  test("a hello that finishes recording after a newer link attached does not replace it", async () => {
    const first = Promise.withResolvers<boolean>();
    let calls = 0;
    const registry = new RunnerRegistry({ persist: persistence(() => (++calls === 1 ? first.promise : Promise.resolve(true))) });
    registry.know(row());
    const older = mux();
    const newer = mux();
    const olderAttach = registry.attach(row(), older, hello);
    const attached = await registry.attach(row(), newer, hello);
    expect(attached?.mux).toBe(newer);
    first.resolve(true);
    expect(await olderAttach).toBeNull();
    expect(older.isClosed).toBe(true);
    expect(newer.isClosed).toBe(false);
    expect(registry.runner("rn_a")?.mux).toBe(newer);
    expect(registry.isOnline(registry.runner("rn_a")!)).toBe(true);
  });

  test("a link that closed while its hello was being recorded is not installed", async () => {
    const gate = Promise.withResolvers<boolean>();
    const registry = new RunnerRegistry({ persist: persistence(() => gate.promise) });
    registry.know(row());
    const link = mux();
    const attach = registry.attach(row(), link, hello);
    link.close("socket dropped");
    gate.resolve(true);
    expect(await attach).toBeNull();
    expect(registry.runner("rn_a")?.mux).toBeNull();
    expect(registry.onlineForUser("org-a", "user-1")).toBeNull();
  });

  test("revocation while a hello is being recorded discards the attachment", async () => {
    const gate = Promise.withResolvers<boolean>();
    const registry = new RunnerRegistry({ persist: persistence(() => gate.promise) });
    registry.know(row());
    const link = mux();
    const attach = registry.attach(row(), link, hello);
    registry.forget("rn_a");
    gate.resolve(true);
    expect(await attach).toBeNull();
    expect(link.isClosed).toBe(true);
    expect(registry.runner("rn_a")).toBeNull();
    expect(registry.onlineForUser("org-a", "user-1")).toBeNull();
  });

  test("a discarded link is recorded offline again unless a newer link speaks for the machine", async () => {
    const offline: string[] = [];
    const gate = Promise.withResolvers<boolean>();
    const registry = new RunnerRegistry({ persist: persistence(() => gate.promise, offline) });
    registry.know(row());
    const link = mux();
    const attach = registry.attach(row(), link, hello);
    link.close("socket dropped");
    gate.resolve(true);
    expect(await attach).toBeNull();
    expect(offline).toEqual(["rn_a"]);
    // Overtaken: the newer hello wrote the row online and the discarded one must not undo it.
    const later: string[] = [];
    const first = Promise.withResolvers<boolean>();
    let calls = 0;
    const raced = new RunnerRegistry({ persist: persistence(() => (++calls === 1 ? first.promise : Promise.resolve(true)), later) });
    raced.know(row());
    const olderAttach = raced.attach(row(), mux(), hello);
    await raced.attach(row(), mux(), hello);
    first.resolve(true);
    expect(await olderAttach).toBeNull();
    expect(later).toEqual([]);
  });

  test("dropping a link closes the socket behind it so the runner reconnects", async () => {
    const registry = new RunnerRegistry({ persist: persistence(async () => true) });
    registry.know(row());
    const first = transport();
    const firstMux = mux();
    await registry.attach(row(), firstMux, hello, first);
    const second = transport();
    const secondMux = mux();
    await registry.attach(row(), secondMux, hello, second);
    expect(first.closes).toEqual([{ code: CLOSE_LINK_DROPPED, reason: "replaced by a newer link" }]);
    await registry.detach("rn_a", secondMux, "heartbeats stopped");
    expect(second.closes).toEqual([{ code: CLOSE_LINK_DROPPED, reason: "heartbeats stopped" }]);
    expect(registry.runner("rn_a")?.mux).toBeNull();
    const third = transport();
    await registry.attach(row(), mux(), hello, third);
    registry.forget("rn_a");
    expect(third.closes).toEqual([{ code: 4401, reason: "runner revoked" }]);
  });

  test("the newest link replaces an older live one", async () => {
    const registry = new RunnerRegistry({ persist: persistence(async () => true) });
    registry.know(row());
    const older = mux();
    const newer = mux();
    await registry.attach(row(), older, hello);
    await registry.attach(row(), newer, hello);
    expect(older.isClosed).toBe(true);
    expect(registry.runner("rn_a")?.mux).toBe(newer);
  });
});
