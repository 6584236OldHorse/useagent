import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { pingRuntimeSocket, SandboxUnresponsiveError, watchTurnLiveness } from "./turn-liveness";

const fast = { intervalMs: 5, silenceMs: 20, failureLimit: 3 };

describe("turn liveness", () => {
  test("a silent stream on a sandbox that stops answering fails the turn and stops the keepAlive", async () => {
    let keepAlives = 0;
    let probes = 0;
    const liveness = watchTurnLiveness(
      { keepAlive: async () => { keepAlives += 1; } } as never,
      { ...fast, probe: async () => { probes += 1; return false; } },
    );
    expect(keepAlives).toBe(1); // pushed out at once, not five minutes in
    const reason = await new Promise((resolve) => liveness.signal.addEventListener("abort", () => resolve(liveness.signal.reason)));
    expect(reason).toBeInstanceOf(SandboxUnresponsiveError);
    expect((reason as Error).message).toBe("The sandbox stopped responding");
    expect(probes).toBe(3);
    await delay(30);
    expect(probes).toBe(3);
    liveness.dispose();
  });

  test("a turn whose stream keeps answering is never cut off, even when probes fail", async () => {
    let probes = 0;
    const liveness = watchTurnLiveness({} as never, { ...fast, probe: async () => { probes += 1; return false; } });
    const pongs = setInterval(() => liveness.heard(), 5);
    await delay(150);
    clearInterval(pongs);
    expect(liveness.signal.aborted).toBe(false);
    expect(probes).toBe(0);
    liveness.dispose();
  });

  test("a quiet turn on a sandbox that still answers is never cut off", async () => {
    let probes = 0;
    const liveness = watchTurnLiveness({} as never, { ...fast, probe: async () => { probes += 1; return probes % 3 !== 0; } });
    await delay(150);
    expect(probes).toBeGreaterThan(3);
    expect(liveness.signal.aborted).toBe(false);
    liveness.dispose();
  });

  test("pings the runtime socket and reports its pongs", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request, bunServer) => (bunServer.upgrade(request) ? undefined : new Response("no", { status: 400 })),
      websocket: { message() {} },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    try {
      const pong = Promise.withResolvers<void>();
      const stop = pingRuntimeSocket(socket, () => pong.resolve(), 10);
      await pong.promise;
      stop();
    } finally {
      socket.close();
      server.stop(true);
    }
  });
});
