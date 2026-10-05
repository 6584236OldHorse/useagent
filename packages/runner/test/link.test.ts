import { afterEach, describe, expect, test } from "bun:test";
import { Mux, PROTOCOL_VERSION, type WelcomeFrame } from "@useagent/runner-protocol";
import { LINK_PATH, LinkClient, type LinkOptions, type LinkStop, linkUrl } from "../src/link";

interface FakePlaneOptions {
  readonly token?: string;
  readonly welcome?: Partial<WelcomeFrame>;
  readonly onMux?: (mux: Mux, ws: { close(code: number, reason: string): void }) => void;
  readonly rejectWith?: number;
}

const WELCOME: WelcomeFrame = {
  t: "welcome",
  protocol: 1,
  minProtocol: 1,
  image: { ref: "ghcr.io/useagenthq/sandbox:test", digest: "sha256:" + "0".repeat(64) },
  heartbeatSeconds: 1,
  release: "test",
};

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A control plane that speaks the link protocol over Bun's WebSocket server. */
function fakePlane(options: FakePlaneOptions = {}) {
  const state = { connections: 0, hellos: [] as unknown[], heartbeats: 0, digests: [] as Array<string | null>, muxes: [] as Mux[], events: [] as unknown[] };
  const server = Bun.serve<{ mux: Mux | null; authorized: boolean }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname !== LINK_PATH) return new Response("not found", { status: 404 });
      const authorized = request.headers.get("authorization") === `Bearer ${options.token ?? "uart_r1.secret"}`;
      if (server.upgrade(request, { data: { mux: null, authorized } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        state.connections += 1;
        if (!ws.data.authorized) {
          ws.close(options.rejectWith ?? 4401, "token rejected");
          return;
        }
        const mux = new Mux("plane", { send: (m) => ws.send(m) }, {
          onHello: (frame) => {
            state.hellos.push(frame);
            mux.send({ ...WELCOME, ...options.welcome });
          },
          onHeartbeat: (frame) => {
            state.heartbeats += 1;
            state.digests.push(frame.imageDigest);
          },
          onEvent: (frame) => {
            state.events.push(frame);
          },
        });
        ws.data.mux = mux;
        state.muxes.push(mux);
        options.onMux?.(mux, ws);
      },
      message(ws, message) {
        ws.data.mux?.receive(typeof message === "string" ? message : new Uint8Array(message));
      },
      close(ws) {
        ws.data.mux?.close("closed");
      },
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, state, server };
}

function client(planeUrl: string, overrides: Partial<LinkOptions> = {}) {
  const states: string[] = [];
  const welcomes: WelcomeFrame[] = [];
  const link = new LinkClient({
    planeUrl,
    token: "uart_r1.secret",
    runnerId: "r1",
    version: "0.1.0-test",
    backend: "docker",
    platform: "test",
    capacity: () => ({ cpu: 2, memoryMb: 2048, sandboxes: 0 }),
    logins: () => ["codex"],
    imageDigest: () => null,
    rpc: async (method, params) => ({ method, params }),
    stream: () => {
      throw new Error("no streams in this test");
    },
    onWelcome: (frame) => {
      welcomes.push(frame);
    },
    onState: (s, detail) => states.push(`${s}:${detail}`),
    backoff: { initialMs: 10, maxMs: 20 },
    ...overrides,
  });
  return { link, states, welcomes };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("link client", () => {
  test("builds the link URL from the plane origin", () => {
    expect(linkUrl("https://app.useagent.org")).toBe(`wss://app.useagent.org${LINK_PATH}`);
    expect(linkUrl("http://127.0.0.1:3201/")).toBe(`ws://127.0.0.1:3201${LINK_PATH}`);
  });

  test("a stop aborts the welcome's pull and waits for its cleanup before run() returns", async () => {
    const plane = fakePlane();
    let release: (() => void) | null = null;
    let sawAbort = false;
    let cleanedUp = false;
    const { link } = client(plane.url, {
      onWelcome: (_frame, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => { sawAbort = true; }, { once: true });
          release = () => { cleanedUp = true; resolve(); };
        }),
    });
    const run = link.run();
    await until(() => release !== null);
    link.stop("signal");
    await until(() => sawAbort);
    const early = await Promise.race([run.then(() => "returned"), new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 150))]);
    expect(early).toBe("pending");
    release!();
    expect((await run).reason).toBe("stopped");
    expect(cleanedUp).toBe(true);
  });

  test("a stop waits for a dropped link's pull as well as the current one", async () => {
    const sockets: Array<{ close(code?: number, reason?: string): void }> = [];
    const plane = fakePlane({ onMux: (_mux, ws) => { sockets.push(ws); } });
    const releases: Array<() => void> = [];
    const { link } = client(plane.url, {
      onWelcome: () => new Promise<void>((resolve) => { releases.push(resolve); }),
    });
    const run = link.run();
    await until(() => releases.length === 1);
    // The plane drops the first link while its pull is still running; the reconnect is welcomed again.
    sockets[0]!.close(1012, "restart");
    await until(() => releases.length === 2);
    link.stop("signal");
    releases[1]!();
    const early = await Promise.race([run.then(() => "returned"), new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 150))]);
    expect(early).toBe("pending");
    releases[0]!();
    expect((await run).reason).toBe("stopped");
  });

  test("says hello, takes the welcome, heartbeats and answers rpc", async () => {
    let planeMux: Mux | null = null;
    const plane = fakePlane({ onMux: (mux) => { planeMux = mux; } });
    const { link, states, welcomes } = client(plane.url);
    const run = link.run();
    await until(() => plane.state.heartbeats >= 2);
    expect(plane.state.hellos[0]).toMatchObject({ t: "hello", runnerId: "r1", backend: "docker", logins: ["codex"], protocol: PROTOCOL_VERSION });
    expect(welcomes[0]?.image.ref).toBe(WELCOME.image.ref);
    expect(states.some((s) => s.startsWith("online:"))).toBe(true);
    expect(await planeMux!.rpc("sandbox.list", { a: 1 })).toEqual({ method: "sandbox.list", params: { a: 1 } });
    link.stop();
    expect((await run).reason).toBe("stopped");
  });

  test("an event reaches the plane once the link is up, and is dropped while it is not", async () => {
    const plane = fakePlane();
    const { link } = client(plane.url);
    link.event("image.pull", { progress: 0.1 });
    const run = link.run();
    await until(() => plane.state.heartbeats >= 1);
    link.event("image.pull", { progress: 0.5, detail: "layer 2/4" });
    await until(() => plane.state.events.length === 1);
    expect(plane.state.events[0]).toEqual({ t: "event", sandboxId: null, kind: "image.pull", detail: { progress: 0.5, detail: "layer 2/4" } });
    link.stop();
    expect((await run).reason).toBe("stopped");
  });

  test("nothing is served before the plane's welcome landed", async () => {
    let releaseWelcome!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWelcome = resolve;
    });
    const answered: unknown[] = [];
    const plane = fakePlane({
      onMux: (mux) => {
        // The plane calls the moment the socket is up, before the runner is welcomed and its image ready.
        setTimeout(() => {
          answered.push(mux.rpc("sandbox.list", {}, { timeoutMs: 2000 }).then(() => "answered", (e: unknown) => (e as { code?: string }).code ?? String(e)));
        }, 20);
      },
    });
    const calls: string[] = [];
    const { link } = client(plane.url, {
      rpc: async (method) => {
        calls.push(method);
        return [];
      },
      onWelcome: () => gate,
    });
    void link.run();
    await until(() => answered.length === 1);
    expect(await answered[0]).toBe("unavailable");
    expect(calls).toEqual([]);
    releaseWelcome();
    await until(() => plane.state.heartbeats >= 1);
    expect(await plane.state.muxes[0]!.rpc("sandbox.list", {}, { timeoutMs: 2000 })).toEqual([]);
    expect(calls).toEqual(["sandbox.list"]);
    link.stop();
  });

  test("a rejected token ends the link with exit reason token_rejected", async () => {
    const plane = fakePlane({ token: "uart_r1.other" });
    const { link } = client(plane.url);
    const stop: LinkStop = await link.run();
    expect(stop.reason).toBe("token_rejected");
    expect(plane.state.connections).toBe(1);
  });

  test("close code 4426 means the runner is too old", async () => {
    const plane = fakePlane({ token: "uart_r1.other", rejectWith: 4426 });
    const { link } = client(plane.url);
    expect((await link.run()).reason).toBe("runner_too_old");
  });

  test("a welcome demanding a newer protocol stops with runner_too_old", async () => {
    const plane = fakePlane({ welcome: { minProtocol: 99 } });
    const { link } = client(plane.url);
    const stop = await link.run();
    expect(stop.reason).toBe("runner_too_old");
    expect(stop.detail).toMatch(/needs protocol 99/);
  });

  test("a plane older than the runner can speak stops with plane_too_old", async () => {
    const plane = fakePlane({ welcome: { protocol: 0 } });
    const { link } = client(plane.url);
    expect((await link.run()).reason).toBe("plane_too_old");
  });

  test("reconnects after the plane drops the socket", async () => {
    const plane = fakePlane({
      onMux: (_mux, ws) => {
        if (plane.state.connections === 1) setTimeout(() => ws.close(1012, "restarting"), 50);
      },
    });
    const { link, states } = client(plane.url);
    const run = link.run();
    await until(() => plane.state.connections >= 2 && plane.state.heartbeats >= 1, 5000);
    expect(states.some((s) => s.startsWith("offline:"))).toBe(true);
    link.stop();
    await run;
  });

  test("keeps retrying while the plane is unreachable, then stops on request", async () => {
    const { link, states } = client("http://127.0.0.1:1");
    const run = link.run();
    await until(() => states.filter((s) => s.startsWith("offline:")).length >= 2, 5000);
    link.stop();
    expect((await run).reason).toBe("stopped");
  });

  test("heartbeats without a digest while the image is still being pulled", async () => {
    let releasePull!: () => void;
    const pull = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    let digest: string | null = null;
    const plane = fakePlane();
    const { link, states } = client(plane.url, {
      imageDigest: () => digest,
      onWelcome: async () => {
        await pull;
        digest = WELCOME.image.digest;
      },
    });
    const run = link.run();
    // Two beats land while the pull is still running, and none of them carries a digest.
    await until(() => plane.state.heartbeats >= 2);
    expect(plane.state.digests).toEqual([null, null]);
    expect(states.some((s) => s.startsWith("online:"))).toBe(false);
    expect(plane.state.connections).toBe(1);
    releasePull();
    await until(() => states.some((s) => s.startsWith("online:")));
    await until(() => plane.state.digests.at(-1) === WELCOME.image.digest);
    expect(plane.state.connections).toBe(1);
    link.stop();
    expect((await run).reason).toBe("stopped");
  });

  test("an image pull that fails does not report online and the link reconnects", async () => {
    let attempts = 0;
    const plane = fakePlane();
    const { link, states } = client(plane.url, {
      onWelcome: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("pull failed");
      },
    });
    const run = link.run();
    await until(() => attempts >= 2 && states.some((s) => s.startsWith("online:")), 5000);
    link.stop();
    await run;
  });
});
