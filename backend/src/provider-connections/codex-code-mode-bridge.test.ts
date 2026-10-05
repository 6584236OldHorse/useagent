import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess, TCPSocketListener } from "bun";
import { CODEX_CODE_MODE_FORWARDER_SOURCE } from "../engines/codex-code-mode-sandbox";
import { openCodexCodeModeBridge } from "./codex-code-mode-bridge";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let echo: TCPSocketListener<undefined>;
let floodClosed = Promise.withResolvers<void>();
let forwarder: Subprocess;
let forwarderPort = 0;
let tokenFile = "";

async function freePort(): Promise<number> {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

beforeAll(async () => {
  // Stands in for the code-mode host: echoes every byte it receives.
  // A "flood" request makes it push 16 MB as fast as the connection takes it.
  const block = new Uint8Array(64 * 1024);
  let flooding: { socket: { write(chunk: Uint8Array): number }; left: number } | null = null;
  const pump = () => {
    while (flooding && flooding.left > 0) {
      const written = flooding.socket.write(block);
      flooding.left -= Math.max(written, 0);
      if (written < block.byteLength) return;
    }
  };
  echo = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        if (Buffer.from(chunk).toString() === "flood") {
          flooding = { socket, left: 16 * 1024 * 1024 };
          pump();
          return;
        }
        socket.write(chunk);
      },
      drain() { pump(); },
      close(socket) { if (flooding?.socket === socket) floodClosed.resolve(); },
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "useagent-code-mode-"));
  const script = join(directory, "forwarder.js");
  tokenFile = join(directory, "token.sha256");
  await writeFile(script, CODEX_CODE_MODE_FORWARDER_SOURCE);
  await writeFile(tokenFile, `${sha256("run-token")}\n`);
  forwarderPort = await freePort();
  forwarder = Bun.spawn([process.execPath, script, String(forwarderPort), "127.0.0.1", String(echo.port), tokenFile], { stdout: "ignore", stderr: "ignore" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${forwarderPort}/`).then(() => true, () => false)) return;
    await Bun.sleep(50);
  }
  throw new Error("forwarder did not start");
});

afterAll(() => {
  forwarder?.kill();
  echo?.stop(true);
});

/** Send bytes through a bridge and collect what comes back until it closes or times out. */
async function roundTrip(bearerToken: string, payload: string): Promise<string> {
  const bridge = openCodexCodeModeBridge({
    upstreamUrl: `ws://127.0.0.1:${forwarderPort}/`,
    expectedUpstreamHost: `127.0.0.1:${forwarderPort}`,
    headers: {},
    bearerToken,
  });
  let received = "";
  const done = Promise.withResolvers<void>();
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port: Number(new URL(bridge.url).port),
    socket: {
      data(_socket, chunk) {
        received += Buffer.from(chunk).toString("utf8");
        if (received.length >= payload.length) done.resolve();
      },
      close() { done.resolve(); },
    },
  });
  client.write(payload);
  await Promise.race([done.promise, Bun.sleep(2_000)]);
  client.end();
  bridge.close();
  return received;
}

describe("Codex code-mode tunnel", () => {
  test("the forwarder refuses a missing or wrong bearer before any upgrade", async () => {
    expect((await fetch(`http://127.0.0.1:${forwarderPort}/`)).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${forwarderPort}/`, { headers: { authorization: "Bearer wrong" } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${forwarderPort}/`, { headers: { authorization: "Bearer run-token" } })).status).toBe(426);
  });

  test("carries bytes end to end for the run's bearer and nothing for another", async () => {
    expect(await roundTrip("run-token", "grpc-frame-bytes")).toBe("grpc-frame-bytes");
    expect(await roundTrip("other-token", "grpc-frame-bytes")).toBe("");
  });

  test("a rotated digest shuts out the previous run's bearer", async () => {
    await writeFile(tokenFile, `${sha256("next-run-token")}\n`);
    expect(await roundTrip("run-token", "late-frame")).toBe("");
    expect(await roundTrip("next-run-token", "fresh-frame")).toBe("fresh-frame");
  });

  test("cuts a flooding host off instead of buffering what the app-server has not read", async () => {
    await writeFile(tokenFile, `${sha256("flood-token")}\n`);
    floodClosed = Promise.withResolvers<void>();
    const bridge = openCodexCodeModeBridge({
      upstreamUrl: `ws://127.0.0.1:${forwarderPort}/`,
      expectedUpstreamHost: `127.0.0.1:${forwarderPort}`,
      headers: {},
      bearerToken: "flood-token",
      maxPendingBytes: 256 * 1024,
    });
    const { createConnection } = await import("node:net");
    const client = createConnection({ host: "127.0.0.1", port: Number(new URL(bridge.url).port) });
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.pause(); // An app-server that stops reading.
    client.write("flood");
    const cut = await Promise.race([floodClosed.promise.then(() => true), Bun.sleep(5_000).then(() => false)]);
    client.destroy();
    bridge.close();
    expect(cut).toBe(true);
  });

  test("accepts only a websocket upstream on the expected host", () => {
    const base = { headers: {}, bearerToken: "t" };
    expect(() => openCodexCodeModeBridge({ ...base, upstreamUrl: "https://a.test/", expectedUpstreamHost: "a.test" })).toThrow("websocket");
    expect(() => openCodexCodeModeBridge({ ...base, upstreamUrl: "wss://b.test/", expectedUpstreamHost: "a.test" })).toThrow("host mismatch");
    expect(() => openCodexCodeModeBridge({ ...base, bearerToken: "", upstreamUrl: "wss://a.test/", expectedUpstreamHost: "a.test" })).toThrow("bearer");
  });
});
