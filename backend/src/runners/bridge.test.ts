// The tool gateway reaching a machine through the backend: a remote directory
// on one side of a real HTTP and WebSocket bridge, a registry with an
// in-memory runner on the other, and the capability rules between them.

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { type HelloFrame, Mux, PROTOCOL_VERSION } from "@useagent/runner-protocol";
import type { SandboxLink, SandboxLinkDirectory, SandboxLinkStream } from "@useagent/sandbox-contract";
import { GATEWAY_GRANTS } from "../db/gateway-grants";
import type { AppEnv } from "../http";
import { type ToolTokenClaims, mintToolToken, verifyToolToken } from "../knowledge/gateway/token";
import { MAX_BRIDGE_QUEUE_BYTES, type RunnerBridgeDeps, createRunnerBridgeRoutes } from "./bridge";
import { withRunnerBridgeContext } from "./bridge-context";
import { RunnerRegistry } from "./registry";
import { KNOWN_RUNNER_COLUMNS, RemoteRunnerDirectory } from "./remote-directory";
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
  imageDigest: "sha256:" + "b".repeat(64),
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
      if (method === "sandbox.get") return { id: (params as { sandboxId: string }).sandboxId, state: "running" };
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
          const total = parts.reduce((n, part) => n + part.byteLength, 0);
          calls.push(t.path === "/big" ? { method: "wrote-bytes", params: total } : { method: "wrote", params: new TextDecoder().decode(Buffer.concat(parts)) });
          stream.end();
        }
      })();
    },
  });
  await registry.attach(row(), planeMux, hello);
  return { registry, calls };
}

interface ServedRun {
  readonly orgId: string;
  readonly sandboxId: string | null;
  status?: "running" | "completed" | "cancelled";
}

function serve(
  directory: SandboxLinkDirectory,
  runs: Record<string, ServedRun>,
  overrides: Partial<Pick<RunnerBridgeDeps, "policy" | "env" | "identity" | "recheckMs">> = {},
) {
  const app = new Hono<AppEnv>().route(
    "/api/internal/runners",
    createRunnerBridgeRoutes({
      directory,
      verify: (token) => verifyToolToken(token),
      // What run-authorization does: the capability is inert unless its run is running now.
      identity: async (claims: ToolTokenClaims) => ((runs[claims.runId]?.status ?? "running") === "running" ? claims : null),
      run: async (orgId, runId) => {
        const run = runs[runId];
        return run && run.orgId === orgId ? { id: runId, orgId: run.orgId, sandboxId: run.sandboxId } : null;
      },
      policy: async () => ({ allowLocalExecution: true }),
      ...overrides,
    }),
  );
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const context = { orgId: "org-a", userId: "user-1", runId: "run-1", threadId: "thread-1" };
const ownRun = { "run-1": { orgId: "org-a", sandboxId: "local:rn_a:c1" } };

/** A link whose streams the test controls, for the bridge's own state machine. */
function fakeStream(options: { readonly failWrites?: string } = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const done = Promise.withResolvers<void>();
  done.promise.catch(() => {});
  const written: string[] = [];
  const resets: string[] = [];
  const ended = Promise.withResolvers<void>();
  const stream: SandboxLinkStream = {
    id: 3,
    readable,
    done: done.promise,
    async write(bytes) {
      if (options.failWrites) throw new Error(options.failWrites);
      written.push(new TextDecoder().decode(bytes));
    },
    end() {
      ended.resolve();
    },
    reset(reason) {
      resets.push(reason);
      done.reject(new Error(reason));
    },
  };
  return { stream, controller, done, written, resets, ended: ended.promise };
}

function fakeDirectory(open: (target: unknown) => Promise<SandboxLinkStream>): SandboxLinkDirectory {
  const link: SandboxLink = {
    id: "rn_a",
    userId: "user-1",
    orgId: "org-a",
    fingerprint: "fp",
    enrolledAt: "2026-09-08T00:00:00.000Z",
    online: true,
    call: async () => null,
    openStream: open,
    async forward() {
      throw new Error("no forwarders here");
    },
    async release() {},
  };
  return { get: (id) => (id === "rn_a" ? link : null), list: () => [link] };
}

function rawStreamSocket(origin: string, target: unknown) {
  const url = new URL(`${origin.replace(/^http/, "ws")}/api/internal/runners/bridge/stream`);
  url.searchParams.set("runnerId", "rn_a");
  url.searchParams.set("target", Buffer.from(JSON.stringify(target)).toString("base64url"));
  const token = mintToolToken(context, 60_000);
  const socket = new WebSocket(url.toString(), { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  const texts: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.onclose = (event) => resolve({ code: event.code, reason: event.reason });
  });
  socket.onmessage = (event) => {
    if (typeof event.data === "string") texts.push(event.data);
  };
  const open = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("socket failed"));
  });
  return { socket, texts, closed, open };
}

describe("runner bridge", () => {
  test("a capability for a run reaches its own container for calls and streams", async () => {
    const { registry, calls } = await planeWithRunner();
    const origin = serve(registry.directory, ownRun);
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

  test("a link handed out while a run is served keeps working after the resolution returns", async () => {
    const { registry } = await planeWithRunner();
    const origin = serve(registry.directory, ownRun);
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    const link = await withRunnerBridgeContext(context, async () => remote.get("rn_a")!);
    expect(await link.call("sandbox.get", { sandboxId: "c1" })).toEqual({ id: "c1", state: "running" });
    const read = await link.openStream({ kind: "file.read", sandboxId: "c1", path: "/x" });
    read.end();
    await read.done;
    // Without a run there is nothing to mint a capability for.
    await expect(remote.get("rn_a")!.call("sandbox.get", { sandboxId: "c1" })).rejects.toThrow(/run being served/);
  });

  test("only what a run's tools do inside their container crosses the bridge", async () => {
    const { registry, calls } = await planeWithRunner();
    const origin = serve(registry.directory, ownRun);
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    await withRunnerBridgeContext(context, async () => {
      const link = remote.get("rn_a")!;
      for (const method of ["sandbox.list", "sandbox.create", "sandbox.delete", "sandbox.start", "pty.resize"]) {
        await expect(link.call(method, { sandboxId: "c1", streamId: 42, cols: 80, rows: 24 })).rejects.toThrow(/method_not_bridged/);
      }
      for (const target of [
        { kind: "pty", sandboxId: "c1", cols: 80, rows: 24 },
        { kind: "port", sandboxId: "c1", port: 80 },
      ]) {
        await expect(link.openStream(target)).rejects.toThrow(/not served through the bridge/);
      }
    });
    expect(calls.filter((call) => call.method !== "process.execute" && call.method !== "sandbox.get")).toEqual([]);
  });

  test("outside a served run, across organisations, or for another container, the bridge refuses", async () => {
    const { registry } = await planeWithRunner();
    const origin = serve(registry.directory, {
      ...ownRun,
      "run-b": { orgId: "org-b", sandboxId: "local:rn_a:c1" },
      "run-cloud": { orgId: "org-a", sandboxId: "box-123" },
    });
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    await expect(remote.get("rn_a")!.call("process.execute", { sandboxId: "c1", command: "id" })).rejects.toThrow(/run being served/);
    await withRunnerBridgeContext({ ...context, orgId: "org-b", runId: "run-b" }, async () => {
      await expect(remote.get("rn_a")!.call("process.execute", { sandboxId: "c1", command: "id" })).rejects.toThrow(/different organisations/);
    });
    await withRunnerBridgeContext({ ...context, runId: "run-cloud" }, async () => {
      const error = await remote.get("rn_a")!.call("process.execute", { sandboxId: "c1", command: "id" }).catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("refused");
      expect(String(error)).toMatch(/sandbox_not_on_runner/);
    });
    await withRunnerBridgeContext(context, async () => {
      const link = remote.get("rn_a")!;
      const error = await link.call("process.execute", { sandboxId: "c2", command: "id" }).catch((e: unknown) => e);
      expect(String(error)).toMatch(/sandbox_not_granted/);
      await expect(link.call("process.execute", {})).rejects.toThrow(/sandbox_not_granted/);
      await expect(link.openStream({ kind: "file.read", sandboxId: "c2", path: "/x" })).rejects.toThrow(/not this capability's sandbox/);
    });
    // A token from another signer, or none, is unauthorized.
    const bad = await fetch(`${origin}/api/internal/runners/bridge/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer v1.nope.nope" },
      body: JSON.stringify({ runnerId: "rn_a", method: "process.execute", params: { sandboxId: "c1" } }),
    });
    expect(bad.status).toBe(401);
    const none = await fetch(`${origin}/api/internal/runners/bridge/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runnerId: "rn_a", method: "process.execute", params: { sandboxId: "c1" } }),
    });
    expect(none.status).toBe(401);
  });

  test("a capability whose run is no longer running is inert", async () => {
    const { registry } = await planeWithRunner();
    const origin = serve(registry.directory, {
      ...ownRun,
      "run-done": { orgId: "org-a", sandboxId: "local:rn_a:c1", status: "completed" },
      "run-stopped": { orgId: "org-a", sandboxId: "local:rn_a:c1", status: "cancelled" },
    });
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    for (const runId of ["run-done", "run-stopped"]) {
      await withRunnerBridgeContext({ ...context, runId }, async () => {
        const link = remote.get("rn_a")!;
        await expect(link.call("process.execute", { sandboxId: "c1", command: "id" })).rejects.toThrow(/inactive_capability/);
        await expect(link.openStream({ kind: "file.read", sandboxId: "c1", path: "/x" })).rejects.toThrow(/inactive_capability/);
      });
    }
  });

  test("the switches that stop local execution stop the bridge too", async () => {
    const { registry } = await planeWithRunner();
    const off = serve(registry.directory, ownRun, { env: { LOCAL_RUNNERS: "off" } });
    const forbidden = serve(registry.directory, ownRun, { policy: async () => ({ allowLocalExecution: false }) });
    for (const origin of [off, forbidden]) {
      const remote = new RemoteRunnerDirectory({ origin: () => origin });
      remote.remember(row());
      await withRunnerBridgeContext(context, async () => {
        const link = remote.get("rn_a")!;
        await expect(link.call("process.execute", { sandboxId: "c1", command: "id" })).rejects.toThrow(/local_execution_disabled/);
        await expect(link.openStream({ kind: "file.read", sandboxId: "c1", path: "/x" })).rejects.toThrow(/local_execution_disabled/);
      });
    }
  });

  test("a runner that is away answers through the bridge as not connected", async () => {
    const registry = new RunnerRegistry({ persist: { hello: async () => true, heartbeat: async () => true, offline: async () => {}, markStale: async () => 0 } });
    registry.know(row({ status: "offline" }));
    const origin = serve(registry.directory, ownRun);
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row({ status: "offline" }));
    await withRunnerBridgeContext(context, async () => {
      const link = remote.get("rn_a")!;
      expect(link.online).toBe(false);
      await expect(link.call("process.execute", { sandboxId: "c1", command: "id" })).rejects.toThrow(/not connected/);
      await expect(link.openStream({ kind: "file.read", sandboxId: "c1", path: "/x" })).rejects.toThrow(/not connected/);
    });
  });

  test("the gateway's view follows the backend's records, reading only the columns its role is granted", async () => {
    let rows = [row({ status: "offline" })];
    const remote = new RemoteRunnerDirectory({ origin: () => "http://127.0.0.1:1", rows: async () => rows });
    expect(await remote.refresh()).toBe(1);
    expect(remote.runner("rn_a")?.online).toBe(false);
    expect(remote.runner("rn_b")).toBeNull();
    rows = [row({ status: "online" }), row({ id: "rn_b", tokenHash: hashRunnerToken("uart_rn_b.secret") })];
    expect(await remote.refresh()).toBe(2);
    expect(remote.runner("rn_a")?.online).toBe(true);
    expect(remote.runner("rn_b")?.online).toBe(true);
    const grant = GATEWAY_GRANTS.find((statement) => statement.includes("ON runners TO"))!;
    const granted = grant.slice(grant.indexOf("(") + 1, grant.indexOf(")")).split(",").map((name) => name.trim());
    for (const column of Object.values(KNOWN_RUNNER_COLUMNS)) expect(granted).toContain(column.name);
  });

  test("bytes queued before the sandbox opened are bounded, and a reset or a close while opening reaches the stream", async () => {
    const opens: PromiseWithResolvers<SandboxLinkStream>[] = [];
    const origin = serve(
      fakeDirectory(() => {
        const open = Promise.withResolvers<SandboxLinkStream>();
        opens.push(open);
        return open.promise;
      }),
      ownRun,
    );
    const target = { kind: "file.write", sandboxId: "c1", path: "/x" };
    // Too much before the sandbox answered: the bridge resets and closes.
    const flood = rawStreamSocket(origin, target);
    await flood.open;
    const chunk = new Uint8Array(1024 * 1024);
    for (let sent = 0; sent <= MAX_BRIDGE_QUEUE_BYTES; sent += chunk.byteLength) flood.socket.send(chunk);
    const floodClose = await flood.closed;
    expect(floodClose.code).toBe(1011);
    expect(flood.texts.some((text) => text.includes('"reset"') && text.includes("more than it may queue"))).toBe(true);
    // A reset while the sandbox is still opening, and a socket that went away meanwhile.
    const early = rawStreamSocket(origin, target);
    await early.open;
    early.socket.send(new TextEncoder().encode("first"));
    early.socket.send(JSON.stringify({ t: "reset", reason: "gateway gave up" }));
    const gone = rawStreamSocket(origin, target);
    await gone.open;
    gone.socket.send(new TextEncoder().encode("first"));
    gone.socket.close();
    await gone.closed;
    await Bun.sleep(50);
    expect(opens.length).toBe(3);
    const fakes = [fakeStream(), fakeStream(), fakeStream()];
    opens.forEach((open, index) => open.resolve(fakes[index]!.stream));
    await Bun.sleep(50);
    expect(fakes.map((fake) => fake.written)).toEqual([[], [], []]);
    expect(fakes.map((fake) => fake.resets)).toEqual([["the bridge holds more than it may queue for the sandbox"], ["gateway gave up"], ["bridge closed"]]);
    early.socket.close();
  });

  test("a failure after the sandbox's side ended still reaches the gateway", async () => {
    const fake = fakeStream();
    const origin = serve(fakeDirectory(async () => fake.stream), ownRun);
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    const link = await withRunnerBridgeContext(context, async () => remote.get("rn_a")!);
    const stream = await link.openStream({ kind: "file.write", sandboxId: "c1", path: "/x" });
    await stream.write(new TextEncoder().encode("payload"));
    fake.controller.close();
    const parts: Uint8Array[] = [];
    for await (const chunk of stream.readable) parts.push(chunk);
    expect(parts).toEqual([]);
    stream.end();
    await fake.ended;
    fake.done.reject(new Error("the sandbox could not keep the file"));
    await expect(stream.done).rejects.toThrow(/could not keep the file/);
    expect(fake.written).toEqual(["payload"]);
  });

  test("an open stream ends when its run stops or local execution is switched off", async () => {
    const runs: Record<string, ServedRun> = { "run-1": { orgId: "org-a", sandboxId: "local:rn_a:c1", status: "running" } };
    let allowed = true;
    const origin = serve(fakeDirectory(async () => fakeStream().stream), runs, { recheckMs: 30, policy: async () => ({ allowLocalExecution: allowed }) });
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    const link = await withRunnerBridgeContext(context, async () => remote.get("rn_a")!);
    const stopped = await link.openStream({ kind: "file.write", sandboxId: "c1", path: "/x" });
    runs["run-1"]!.status = "cancelled";
    await expect(stopped.done).rejects.toThrow(/no longer valid: inactive_capability/);
    await expect(stopped.write(new Uint8Array(1))).rejects.toThrow(/no longer valid/);
    runs["run-1"]!.status = "running";
    const forbidden = await link.openStream({ kind: "file.write", sandboxId: "c1", path: "/x" });
    allowed = false;
    await expect(forbidden.done).rejects.toThrow(/no longer valid: local_execution_disabled/);
  });

  test("an upload larger than the bridge's window flows under credit, and writing after end is refused", async () => {
    const { registry, calls } = await planeWithRunner();
    const origin = serve(registry.directory, ownRun);
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    const link = await withRunnerBridgeContext(context, async () => remote.get("rn_a")!);
    const stream = await link.openStream({ kind: "file.write", sandboxId: "c1", path: "/big" });
    const size = MAX_BRIDGE_QUEUE_BYTES + 1024 * 1024;
    await stream.write(new Uint8Array(size));
    stream.end();
    await expect(stream.write(new Uint8Array(1))).rejects.toThrow(/already ended/);
    await stream.done;
    expect(calls.at(-1)).toEqual({ method: "wrote-bytes", params: size });
  });

  test("a write the sandbox rejects ends the stream as a failure", async () => {
    const fake = fakeStream({ failWrites: "no space left on the machine" });
    const origin = serve(fakeDirectory(async () => fake.stream), ownRun);
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    const link = await withRunnerBridgeContext(context, async () => remote.get("rn_a")!);
    const stream = await link.openStream({ kind: "file.write", sandboxId: "c1", path: "/x" });
    await stream.write(new TextEncoder().encode("payload"));
    stream.end();
    await expect(stream.done).rejects.toThrow(/write failed: no space left/);
    expect(fake.resets).toEqual(["write failed: no space left on the machine"]);
  });

  test("output the gateway does not read is bounded", async () => {
    const fake = fakeStream();
    const origin = serve(fakeDirectory(async () => fake.stream), ownRun);
    const remote = new RemoteRunnerDirectory({ origin: () => origin });
    remote.remember(row());
    const link = await withRunnerBridgeContext(context, async () => remote.get("rn_a")!);
    const stream = await link.openStream({ kind: "file.read", sandboxId: "c1", path: "/x" });
    const chunk = new Uint8Array(MAX_BRIDGE_QUEUE_BYTES / 2);
    for (let i = 0; i < 3; i += 1) fake.controller.enqueue(chunk);
    await expect(stream.done).rejects.toThrow(/more than the bridge may queue/);
    await Bun.sleep(20);
    expect(fake.resets.length).toBe(1);
  });
});
