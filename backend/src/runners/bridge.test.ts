// The tool gateway reaching a machine through the backend: a remote directory
// on one side of a real HTTP and WebSocket bridge, a registry with an
// in-memory runner on the other, and the capability rules between them.

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { type HelloFrame, Mux, PROTOCOL_VERSION } from "@useagent/runner-protocol";
import type { AppEnv } from "../http";
import { mintToolToken, verifyToolToken } from "../knowledge/gateway/token";
import { createRunnerBridgeRoutes } from "./bridge";
import { withRunnerBridgeContext } from "./bridge-context";
import { RunnerRegistry } from "./registry";
import { RemoteRunnerDirectory } from "./remote-directory";
import { type RunnerRow, hashRunnerToken } from "./store";

function row(overrides: Partial<RunnerRow> = {}): RunnerRow {
  return {
    id: "rn_a",
    orgId: "org-a",
    userId: "user-1",
    name: "laptop",
    platform: "darwin-arm64",
    backend: "docker",
    version: "0.1.0",
    protocol: 1,
    capacity: { cpu: 4, memoryMb: 8192, sandboxes: 1 },
    logins: ["codex"],
    imageDigest: null,
    status: "online",
    lastSeenAt: new Date(),
    enrolledAt: new Date("2026-09-08T00:00:00Z"),
    revokedAt: null,
    tokenHash: hashRunnerToken("uart_rn_a.secret"),
    ...overrides,
  };
}

const hello: HelloFrame = {
  t: "hello",
  runnerId: "rn_a",
  version: "0.1.0",
  protocol: PROTOCOL_VERSION,
  backend: "docker",
  platform: "darwin-arm64",
  capacity: { cpu: 4, memoryMb: 8192, sandboxes: 1 },
  logins: ["codex"],
  imageDigest: null,
};

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A registry whose runner is an in-memory mux answering like a machine would. */
async function planeWithRunner() {
  const registry = new RunnerRegistry({ persist: { hello: async () => true, heartbeat: async () => true, offline: async () => {}, markStale: async () => 0 } });
  registry.know(row());
  let planeMux!: Mux;
  let runnerMux!: Mux;
  const deliver = (fn: () => void) => queueMicrotask(fn);
  const encoder = new TextEncoder();
  const calls: Array<{ method: string; params: unknown }> = [];
  planeMux = new Mux("plane", { send: (m) => deliver(() => runnerMux.receive(m)) });
  runnerMux = new Mux("runner", { send: (m) => deliver(() => planeMux.receive(m)) }, {
    onRpc: async (method, params) => {
      calls.push({ method, params });
      if (method === "process.execute") return { exitCode: 0, result: `ran ${(params as { command: string }).command}` };
      throw Object.assign(new Error(`no ${method}`), { code: "unsupported" });
    },
    onStreamOpen: (target, stream) => {
      const t = target as { kind: string; path?: string };
      void (async () => {
        if (t.kind === "file.read") {
          await stream.write(encoder.encode(`contents of ${t.path}`));
          stream.end();
          return;
        }
        if (t.kind === "file.write") {
          const parts: Uint8Array[] = [];
          for await (const chunk of stream.readable) parts.push(chunk);
          calls.push({ method: "wrote", params: new TextDecoder().decode(Buffer.concat(parts)) });
          stream.end();
        }
      })();
    },
  });
  await registry.attach(row(), planeMux, hello);
  return { registry, calls };
}

function serve(registry: RunnerRegistry, runs: Record<string, { orgId: string; sandboxId: string | null }>) {
  const app = new Hono<AppEnv>().route(
    "/api/internal/runners",
    createRunnerBridgeRoutes({
      directory: registry.directory,
      verify: (token) => verifyToolToken(token),
      run: async (orgId, runId) => {
        const run = runs[runId];
        return run && run.orgId === orgId ? { id: runId, orgId: run.orgId, sandboxId: run.sandboxId } : null;
      },
    }),
  );
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const context = { orgId: "org-a", userId: "user-1", runId: "run-1", threadId: "thread-1" };

describe("runner bridge", () => {
  test("a capability for a run reaches its own container for calls and streams", async () => {
    const { registry, calls } = await planeWithRunner();
    const origin = serve(registry, { "run-1": { orgId: "org-a", sandboxId: "local:rn_a:c1" } });
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    await withRunnerBridgeContext(context, async () => {
      const link = remote.get("rn_a")!;
      expect(link.online).toBe(true);
      expect(link.fingerprint).toBe(registry.directory.get("rn_a")!.fingerprint);
      expect(await link.call("process.execute", { sandboxId: "c1", command: "id" }, { timeoutMs: 5000 })).toEqual({ exitCode: 0, result: "ran id" });
      const read = await link.openStream({ kind: "file.read", sandboxId: "c1", path: "/home/user/a.txt" });
      const parts: Uint8Array[] = [];
      for await (const chunk of read.readable) parts.push(chunk);
      expect(new TextDecoder().decode(Buffer.concat(parts))).toBe("contents of /home/user/a.txt");
      read.end();
      await read.done;
      const write = await link.openStream({ kind: "file.write", sandboxId: "c1", path: "/home/user/b.txt" });
      await write.write(new TextEncoder().encode("hello "));
      await write.write(new TextEncoder().encode("bridge"));
      write.end();
      await write.done;
      expect(calls.at(-1)).toEqual({ method: "wrote", params: "hello bridge" });
      await expect(link.forward("c1", 80)).rejects.toThrow(/control plane process/);
    });
  });

  test("outside a served run, across organisations, or for another container, the bridge refuses", async () => {
    const { registry } = await planeWithRunner();
    const origin = serve(registry, {
      "run-1": { orgId: "org-a", sandboxId: "local:rn_a:c1" },
      "run-b": { orgId: "org-b", sandboxId: "local:rn_a:c1" },
      "run-cloud": { orgId: "org-a", sandboxId: "box-123" },
    });
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    const link = remote.get("rn_a")!;
    await expect(link.call("process.execute", { sandboxId: "c1", command: "id" })).rejects.toThrow(/run being served/);
    await withRunnerBridgeContext({ ...context, orgId: "org-b", runId: "run-b" }, async () => {
      await expect(link.call("process.execute", { sandboxId: "c1", command: "id" })).rejects.toThrow(/different organisations/);
    });
    await withRunnerBridgeContext({ ...context, runId: "run-cloud" }, async () => {
      const error = await link.call("process.execute", { sandboxId: "c1", command: "id" }).catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("refused");
      expect(String(error)).toMatch(/sandbox_not_on_runner/);
    });
    await withRunnerBridgeContext(context, async () => {
      const error = await link.call("process.execute", { sandboxId: "c2", command: "id" }).catch((e: unknown) => e);
      expect(String(error)).toMatch(/sandbox_not_granted/);
      await expect(link.call("sandbox.list", {})).rejects.toThrow(/sandbox_not_granted/);
      await expect(link.openStream({ kind: "file.read", sandboxId: "c2", path: "/x" })).rejects.toThrow(/not this capability's sandbox/);
    });
    // A token from another signer, or none, is unauthorized.
    const bad = await fetch(`${origin}/api/internal/runners/bridge/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer v1.nope.nope" },
      body: JSON.stringify({ runnerId: "rn_a", method: "process.execute", params: { sandboxId: "c1" } }),
    });
    expect(bad.status).toBe(401);
    const none = await fetch(`${origin}/api/internal/runners/bridge/call`, { method: "POST", body: "{}" });
    expect(none.status).toBe(400);
  });

  test("a runner that is away answers through the bridge as not connected", async () => {
    const registry = new RunnerRegistry({ persist: { hello: async () => true, heartbeat: async () => true, offline: async () => {}, markStale: async () => 0 } });
    registry.know(row({ status: "offline" }));
    const origin = serve(registry, { "run-1": { orgId: "org-a", sandboxId: "local:rn_a:c1" } });
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row({ status: "offline" }));
    await withRunnerBridgeContext(context, async () => {
      const link = remote.get("rn_a")!;
      expect(link.online).toBe(false);
      await expect(link.call("process.execute", { sandboxId: "c1", command: "id" })).rejects.toThrow(/not connected/);
      await expect(link.openStream({ kind: "file.read", sandboxId: "c1", path: "/x" })).rejects.toThrow(/not connected/);
    });
    expect(verifyToolToken(mintToolToken({ orgId: "org-a", userId: "u", threadId: "", runId: "run-1" }, 1000))?.runId).toBe("run-1");
  });
});
