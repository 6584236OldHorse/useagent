// The link route end to end: a runner-side Mux over a real WebSocket against
// the Hono route, the registry it feeds, and the local provider reading the
// registry's directory, including a loopback forwarder carrying a port stream.

import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { type HelloFrame, Mux, type MuxHandlers, PROTOCOL_VERSION, readAllFromStream } from "@useagent/runner-protocol";
import { localPlugin, localProviderConfig } from "@useagent/sandbox-local";
import type { AppEnv } from "../http";
import { CLOSE_RUNNER_TOO_OLD, CLOSE_TOKEN_REJECTED, createRunnerLinkRoutes, imageForRunner, welcomeFor } from "./link";
import { OFFLINE_AFTER_MS, type RunnerPersistence, RunnerRegistry, CLOSE_LINK_DROPPED } from "./registry";
import { type RunnerRow, hashRunnerToken } from "./store";

const TOKEN = "uart_rn_a.secret";
const IMAGE = { ref: "ghcr.io/useagenthq/sandbox:test", digest: "sha256:" + "a".repeat(64) };

function row(overrides: Partial<RunnerRow> = {}): RunnerRow {
  return {
    id: "rn_a",
    orgId: "org-a",
    userId: "user-1",
    name: "laptop",
    platform: "darwin-arm64",
    backend: null,
    version: null,
    protocol: null,
    capacity: {} as RunnerRow["capacity"],
    logins: [],
    imageDigest: null,
    status: "enrolled",
    lastSeenAt: null,
    enrolledAt: new Date("2026-09-08T00:00:00Z"),
    revokedAt: null,
    tokenHash: hashRunnerToken(TOKEN),
    ...overrides,
  };
}

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function plane(options: {
  enabled?: boolean;
  image?: typeof IMAGE | null;
  minProtocol?: number;
  now?: () => number;
  /** What the store answers for hello and heartbeat: false means revoked. */
  alive?: () => boolean;
  runnerForToken?: (token: string) => Promise<RunnerRow | null>;
  helloTimeoutMs?: number;
} = {}) {
  const persisted: string[] = [];
  const alive = options.alive ?? (() => true);
  const persist: RunnerPersistence = {
    hello: async (id) => {
      persisted.push(`hello:${id}`);
      return alive();
    },
    heartbeat: async (id) => {
      persisted.push(`heartbeat:${id}`);
      return alive();
    },
    offline: async (id) => {
      persisted.push(`offline:${id}`);
    },
    markStale: async () => 0,
  };
  const registry = new RunnerRegistry({ persist, now: options.now });
  registry.know(row());
  const logged: string[] = [];
  const routes = createRunnerLinkRoutes({
    registry,
    runnerForToken: options.runnerForToken ?? (async (token) => (token === TOKEN ? row() : null)),
    config: () => ({ enabled: options.enabled ?? true, minProtocol: options.minProtocol ?? 1, image: options.image === undefined ? IMAGE : options.image }),
    release: () => "run-events-v1:abc",
    helloTimeoutMs: options.helloTimeoutMs,
    log: (message) => logged.push(message),
  });
  const app = new Hono<AppEnv>().route("/api/internal/runners", routes);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket });
  servers.push(server);
  return { registry, persisted, logged, url: `ws://127.0.0.1:${server.port}/api/internal/runners/link` };
}

function hello(overrides: Partial<HelloFrame> = {}): HelloFrame {
  return {
    t: "hello",
    runnerId: "rn_a",
    version: "0.1.0",
    protocol: PROTOCOL_VERSION,
    backend: "docker",
    platform: "darwin-arm64",
    capacity: { cpu: 4, memoryMb: 8192, sandboxes: 0 },
    logins: ["codex"],
    imageDigest: IMAGE.digest,
    ...overrides,
  };
}

/** A runner-side Mux over a real socket; resolves once the socket is open. */
async function connect(url: string, token: string, handlers: MuxHandlers = {}) {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.onclose = (event) => resolve({ code: event.code, reason: event.reason });
  });
  const mux = new Mux("runner", { send: (m) => socket.send(m) }, handlers);
  socket.onmessage = (event) => mux.receive(event.data as string | ArrayBuffer);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("socket failed"));
    void closed.then(() => resolve());
  });
  return { socket, mux, closed };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("runner link", () => {
  test("welcome carries the image and heartbeat interval; nothing without an image or when switched off", () => {
    expect(welcomeFor({ enabled: true, minProtocol: 1, image: IMAGE }, "r")).toMatchObject({ t: "welcome", image: IMAGE, heartbeatSeconds: 15, release: "r", minProtocol: 1 });
    expect(welcomeFor({ enabled: true, minProtocol: 1, image: null }, "r")).toBeNull();
    expect(welcomeFor({ enabled: false, minProtocol: 1, image: IMAGE }, "r")).toBeNull();
    // Served through the plane: the runner pulls from the plane's host with its own token.
    expect(imageForRunner({ ref: "ghcr.io/useagenthq/sandbox:native-1", digest: IMAGE.digest }, "https://app.useagent.org")).toEqual({
      ref: "app.useagent.org/useagenthq/sandbox:native-1",
      digest: IMAGE.digest,
      pull: { registry: "app.useagent.org", username: "runner" },
    });
    expect(imageForRunner(IMAGE, null)).toBe(IMAGE);
  });

  test("hello attaches the runner, heartbeats keep it online, close detaches it", async () => {
    let now = 1_000_000;
    const { registry, persisted, url } = plane({ now: () => now });
    const welcomes: unknown[] = [];
    const { mux, closed } = await connect(url, TOKEN, { onWelcome: (frame) => welcomes.push(frame) });
    mux.send(hello());
    await until(() => welcomes.length === 1);
    expect(welcomes[0]).toMatchObject({ image: IMAGE, minProtocol: 1 });
    // The directory link names the image the machine was told to pull.
    expect(registry.directory.get("rn_a")?.image).toEqual({ ref: IMAGE.ref, digest: IMAGE.digest });
    const live = registry.runner("rn_a")!;
    expect(registry.isOnline(live)).toBe(true);
    expect(registry.onlineForUser("org-a", "user-1")?.id).toBe("rn_a");
    expect(registry.onlineForUser("org-a", "user-2")).toBeNull();
    expect(live.logins).toEqual(["codex"]);
    now += OFFLINE_AFTER_MS - 1000;
    mux.send({ t: "heartbeat", capacity: { cpu: 4, memoryMb: 8192, sandboxes: 2 }, logins: ["codex", "claude"], imageDigest: IMAGE.digest });
    await until(() => live.logins.length === 2);
    expect(live.capacity?.sandboxes).toBe(2);
    expect(live.imageDigest).toBe(IMAGE.digest);
    expect(registry.isOnline(live)).toBe(true);
    now += OFFLINE_AFTER_MS + 1;
    expect(registry.isOnline(live)).toBe(false);
    expect(await registry.sweep()).toEqual(["rn_a"]);
    expect(live.mux).toBeNull();
    // The sweep ends the socket too, so the runner sees the link drop and reconnects.
    expect(await closed).toMatchObject({ code: CLOSE_LINK_DROPPED, reason: "heartbeats stopped" });
    await until(() => persisted.includes("offline:rn_a"));
    expect(persisted.slice(0, 2)).toEqual(["hello:rn_a", "heartbeat:rn_a"]);
  });

  test("a bad token closes with 4401 and an old runner with 4426", async () => {
    const { url } = plane({ minProtocol: 99 });
    const rejected = await connect(url, "uart_rn_a.wrong");
    expect((await rejected.closed).code).toBe(CLOSE_TOKEN_REJECTED);
    const old = await connect(url, TOKEN);
    old.mux.send(hello());
    expect((await old.closed).code).toBe(CLOSE_RUNNER_TOO_OLD);
  });

  test("a hello naming another runner, or a plane without an image, ends the link", async () => {
    const wrong = plane();
    const a = await connect(wrong.url, TOKEN);
    a.mux.send(hello({ runnerId: "rn_other" }));
    expect((await a.closed).code).toBe(4400);
    const noImage = plane({ image: null });
    const b = await connect(noImage.url, TOKEN);
    b.mux.send(hello());
    const close = await b.closed;
    expect(close.code).toBe(1013);
    expect(close.reason).toMatch(/image/);
  });

  test("the local provider reaches the runner through the registry, and a preview link is a loopback forwarder", async () => {
    const { registry, url } = plane();
    const encoder = new TextEncoder();
    const requests: string[] = [];
    const { mux } = await connect(url, TOKEN, {
      onRpc: async (method, params) => {
        if (method === "sandbox.get") {
          return { id: (params as { sandboxId: string }).sandboxId, state: "running", labels: {}, cpu: 2, memoryMb: 8192, imageDigest: IMAGE.digest, createdAt: "" };
        }
        throw Object.assign(new Error(`unexpected ${method}`), { code: "unsupported" });
      },
      onStreamOpen: (target, stream) => {
        expect(target).toEqual({ kind: "port", sandboxId: "c1", port: 8080 });
        // Serve in the background: the plane sends the request only after the open is acknowledged.
        void (async () => {
          const reader = stream.readable.getReader();
          const { value } = await reader.read();
          reader.releaseLock();
          requests.push(new TextDecoder().decode(value));
          await stream.write(encoder.encode("HTTP/1.0 200 OK\r\nContent-Length: 5\r\n\r\nhello"));
          stream.end();
        })();
      },
    });
    mux.send(hello());
    await until(() => registry.onlineForUser("org-a", "user-1") !== null);
    const provider = localPlugin.createProvider(localProviderConfig({ SANDBOX_IMAGE_REF: IMAGE.ref, SANDBOX_IMAGE_DIGEST: IMAGE.digest }, { runnerId: "rn_a" }), { links: registry.directory });
    const handle = await provider.get("local:rn_a:c1");
    expect(handle.state).toBe("started");
    const preview = await handle.getPreviewLink(8080);
    expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${preview.url}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(requests[0]).toMatch(/^GET \/ HTTP/);
    const same = await handle.getPreviewLink(8080);
    expect(same.url).toBe(preview.url);
    await registry.directory.get("rn_a")!.release("c1");
    await expect(fetch(`${preview.url}/`)).rejects.toThrow();
  });

  test("a runner revoked after its token resolved is refused, and one revoked mid-link is dropped", async () => {
    let revoked = false;
    const first = plane({ alive: () => !revoked });
    revoked = true;
    const a = await connect(first.url, TOKEN);
    a.mux.send(hello());
    expect((await a.closed).code).toBe(CLOSE_TOKEN_REJECTED);
    expect(first.registry.runner("rn_a")).toBeNull();

    revoked = false;
    const second = plane({ alive: () => !revoked });
    const welcomes: unknown[] = [];
    const b = await connect(second.url, TOKEN, { onWelcome: (frame) => welcomes.push(frame) });
    b.mux.send(hello());
    await until(() => welcomes.length === 1);
    revoked = true;
    b.mux.send({ t: "heartbeat", capacity: { cpu: 1, memoryMb: 1024, sandboxes: 0 }, logins: [], imageDigest: null });
    expect((await b.closed).code).toBe(CLOSE_TOKEN_REJECTED);
    expect(second.registry.runner("rn_a")).toBeNull();
  });

  test("a silent link is dropped, and a failing token lookup rejects instead of crashing", async () => {
    const quiet = plane({ helloTimeoutMs: 100 });
    const a = await connect(quiet.url, TOKEN);
    const close = await a.closed;
    expect(close.code).toBe(4400);
    expect(close.reason).toMatch(/no hello/);
    const broken = plane({ runnerForToken: async () => { throw new Error("database away"); } });
    const b = await connect(broken.url, TOKEN);
    b.mux.send(hello());
    expect((await b.closed).code).toBe(CLOSE_TOKEN_REJECTED);
    expect(broken.logged.some((m) => m.includes("database away"))).toBe(true);
  });

  test("a hello that arrives before the token resolves is not lost", async () => {
    let release!: (row: RunnerRow | null) => void;
    const slow = plane({ runnerForToken: () => new Promise((resolve) => { release = resolve; }) });
    const welcomes: unknown[] = [];
    const a = await connect(slow.url, TOKEN, { onWelcome: (frame) => welcomes.push(frame) });
    a.mux.send(hello());
    await new Promise((resolve) => setTimeout(resolve, 50));
    release(row());
    await until(() => welcomes.length === 1);
    expect(slow.registry.onlineForUser("org-a", "user-1")?.id).toBe("rn_a");
    a.socket.close();
  });

  test("a stream opened while the runner is away fails at once", async () => {
    const { registry } = plane();
    const provider = localPlugin.createProvider(localProviderConfig({ SANDBOX_IMAGE_REF: IMAGE.ref, SANDBOX_IMAGE_DIGEST: IMAGE.digest }, { runnerId: "rn_a" }), { links: registry.directory });
    await expect(provider.get("local:rn_a:c1")).rejects.toThrow(/not connected/);
    expect(registry.directory.get("rn_a")?.online).toBe(false);
    expect(registry.directory.get("rn_zzz")).toBeNull();
  });
});

export { readAllFromStream };
