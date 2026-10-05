import { describe, expect, test } from "bun:test";
import { Mux, type MuxHandlers, type MuxOptions, type MuxStream, RpcError, StreamRefusedError, pipeToStream, readAllFromStream } from "./mux";

/** Two muxes joined by an in-memory socket that delivers in order, asynchronously. */
function connectPair(
  planeHandlers: MuxHandlers = {},
  runnerHandlers: MuxHandlers = {},
  options: MuxOptions = {},
): { plane: Mux; runner: Mux; sent: { plane: number; runner: number } } {
  const sent = { plane: 0, runner: 0 };
  let plane: Mux;
  let runner: Mux;
  const queue: Array<() => void> = [];
  let draining = false;
  const deliver = (fn: () => void) => {
    queue.push(fn);
    if (draining) return;
    draining = true;
    queueMicrotask(() => {
      while (queue.length > 0) queue.shift()!();
      draining = false;
    });
  };
  plane = new Mux("plane", { send: (m) => { sent.plane += 1; deliver(() => runner.receive(m)); } }, planeHandlers, options);
  runner = new Mux("runner", { send: (m) => { sent.runner += 1; deliver(() => plane.receive(m)); } }, runnerHandlers, options);
  return { plane, runner, sent };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function settled(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("rpc", () => {
  test("round-trips a result", async () => {
    const { plane } = connectPair({}, {
      onRpc: async (method, params) => ({ echoed: method, params }),
    });
    await expect(plane.rpc("sandbox.get", { sandboxId: "c1" })).resolves.toEqual({
      echoed: "sandbox.get",
      params: { sandboxId: "c1" },
    });
  });

  test("carries the handler's error code", async () => {
    const { plane } = connectPair({}, {
      onRpc: async () => {
        throw new RpcError("not_found", "no such sandbox");
      },
    });
    const error = await plane.rpc("sandbox.get", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe("not_found");
    expect((error as RpcError).message).toBe("no such sandbox");
  });

  test("answers unsupported when the peer has no handler", async () => {
    const { plane } = connectPair();
    const error = await plane.rpc("anything", {}).catch((e: unknown) => e);
    expect((error as RpcError).code).toBe("unsupported");
  });

  test("times out when the peer never answers", async () => {
    const { plane } = connectPair({}, { onRpc: () => new Promise(() => {}) });
    const error = await plane.rpc("slow", {}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect((error as RpcError).code).toBe("timeout");
  });

  test("a null result arrives as null", async () => {
    const { plane } = connectPair({}, { onRpc: async () => undefined });
    await expect(plane.rpc("x", {})).resolves.toBeNull();
  });
});

describe("streams", () => {
  test("open, exchange bytes both ways, half-close each side", async () => {
    const accepted: unknown[] = [];
    let runnerSide!: MuxStream;
    const { plane, runner } = connectPair({}, {
      onStreamOpen: (target, stream) => {
        accepted.push(target);
        runnerSide = stream;
        void (async () => {
          const bytes = await readAllFromStream(stream);
          await stream.write(encoder.encode(`echo:${decoder.decode(bytes)}`));
          stream.end();
        })();
      },
    });
    const stream = await plane.openStream({ kind: "port", sandboxId: "c1", port: 80 });
    expect(accepted).toEqual([{ kind: "port", sandboxId: "c1", port: 80 }]);
    expect(stream.id % 2).toBe(0);
    await stream.write(encoder.encode("hel"));
    await stream.write(encoder.encode("lo"));
    stream.end();
    expect(decoder.decode(await readAllFromStream(stream))).toBe("echo:hello");
    await stream.done;
    await runnerSide.done;
    expect(plane.openStreams).toBe(0);
    expect(runner.openStreams).toBe(0);
  });

  test("the runner opens odd ids", async () => {
    const { runner } = connectPair({ onStreamOpen: () => {} });
    const stream = await runner.openStream({ kind: "event" });
    expect(stream.id % 2).toBe(1);
  });

  test("a refused open rejects with the handler's code", async () => {
    const { plane } = connectPair({}, {
      onStreamOpen: () => {
        throw new StreamRefusedError("not_found", "no sandbox c9");
      },
    });
    const error = await plane.openStream({ kind: "port", sandboxId: "c9", port: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamRefusedError);
    expect((error as StreamRefusedError).code).toBe("not_found");
    expect(plane.openStreams).toBe(0);
  });

  test("open times out when the peer is silent", async () => {
    const plane = new Mux("plane", { send: () => {} }, {}, { streamOpenTimeoutMs: 20 });
    const error = await plane.openStream({}).catch((e: unknown) => e);
    expect((error as StreamRefusedError).code).toBe("timeout");
    expect(plane.openStreams).toBe(0);
  });

  test("a large write arrives intact through credits", async () => {
    let received: Promise<Uint8Array> | null = null;
    const { plane } = connectPair({}, {
      onStreamOpen: (_target, stream) => {
        received = readAllFromStream(stream);
      },
    }, { window: 8 * 1024 });
    const payload = new Uint8Array(1_000_000);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    const stream = await plane.openStream({});
    await stream.write(payload);
    stream.end();
    const bytes = await received!;
    expect(bytes.byteLength).toBe(payload.byteLength);
    expect(bytes.every((value, i) => value === i % 251)).toBe(true);
  });

  test("a stalled consumer blocks only its own sender", async () => {
    let stalled!: MuxStream;
    const { plane } = connectPair({}, {
      onStreamOpen: (target, stream) => {
        if ((target as { kind: string }).kind === "stall") {
          stalled = stream;
          return;
        }
        void readAllFromStream(stream).then(async (bytes) => {
          await stream.write(bytes);
          stream.end();
        });
      },
    }, { window: 1024 });
    const a = await plane.openStream({ kind: "stall" });
    let aDone = false;
    const aWrite = a.write(new Uint8Array(10 * 1024)).then(() => {
      aDone = true;
    });
    await settled();
    expect(aDone).toBe(false);

    const b = await plane.openStream({ kind: "echo" });
    await b.write(encoder.encode("still moving"));
    b.end();
    expect(decoder.decode(await readAllFromStream(b))).toBe("still moving");
    expect(aDone).toBe(false);

    // Draining the stalled consumer releases its sender.
    const drained = readAllFromStream(stalled);
    await aWrite;
    expect(aDone).toBe(true);
    a.end();
    expect((await drained).byteLength).toBe(10 * 1024);
  });

  test("a reset from the peer errors the readable and pending writes", async () => {
    const { plane } = connectPair({}, {
      onStreamOpen: (_target, stream) => {
        setTimeout(() => stream.reset("container died"), 5);
      },
    }, { window: 16 });
    const stream = await plane.openStream({});
    // Handlers attached before the reset lands, so nothing rejects unobserved.
    const [write, read, done] = await Promise.allSettled([
      stream.write(new Uint8Array(1024)),
      readAllFromStream(stream),
      stream.done,
    ]);
    expect(write.status === "rejected" && String(write.reason)).toMatch(/reset by peer: container died/);
    expect(read.status === "rejected" && String(read.reason)).toMatch(/container died/);
    expect(done.status === "rejected" && String(done.reason)).toMatch(/container died/);
    expect(plane.openStreams).toBe(0);
  });

  test("pipeToStream forwards a readable and half-closes", async () => {
    let received: Promise<Uint8Array> | null = null;
    const { plane } = connectPair({}, {
      onStreamOpen: (_target, stream) => {
        received = readAllFromStream(stream);
      },
    });
    const stream = await plane.openStream({});
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("part one, "));
        controller.enqueue(encoder.encode("part two"));
        controller.close();
      },
    });
    await pipeToStream(source, stream);
    expect(decoder.decode(await received!)).toBe("part one, part two");
  });
});

describe("review findings", () => {
  test("a writer blocked on credit settles when both sides half-close", async () => {
    let runnerSide!: MuxStream;
    const { plane } = connectPair({}, {
      onStreamOpen: (_target, stream) => {
        runnerSide = stream;
      },
    }, { window: 1 });
    const stream = await plane.openStream({});
    const write = stream.write(new Uint8Array(10)).then(() => "resolved", (e: unknown) => String(e));
    await settled();
    stream.end();
    runnerSide.end();
    await stream.done;
    await runnerSide.done;
    expect(await write).toMatch(/stream is closed/);
    expect(plane.openStreams).toBe(0);
  });

  test("a refused open tears down the acceptor's reads and writes", async () => {
    let read: Promise<unknown> = Promise.resolve();
    let write: Promise<unknown> = Promise.resolve();
    let acceptorDone: Promise<unknown> = Promise.resolve();
    const { plane, runner } = connectPair({}, {
      onStreamOpen: (_target, stream) => {
        read = readAllFromStream(stream).then(() => "resolved", (e: unknown) => String(e));
        write = stream.write(new Uint8Array(64)).then(() => "resolved", (e: unknown) => String(e));
        acceptorDone = stream.done.then(() => "resolved", (e: unknown) => String(e));
        throw new StreamRefusedError("refused", "no room");
      },
    }, { window: 8 });
    const error = await plane.openStream({}).catch((e: unknown) => e);
    expect((error as StreamRefusedError).code).toBe("refused");
    expect(await read).toMatch(/no room/);
    expect(await write).toMatch(/no room/);
    expect(await acceptorDone).toMatch(/no room/);
    expect(runner.openStreams).toBe(0);
    expect(plane.openStreams).toBe(0);
  });

  test("a throwing transport fails every call observably", async () => {
    const plane = new Mux("plane", {
      send: () => {
        throw new Error("socket is closed");
      },
    });
    const rpc = plane.rpc("x", {}).then(() => "resolved", (e: unknown) => e);
    const open = plane.openStream({}).then(() => "resolved", (e: unknown) => e);
    expect(((await rpc) as RpcError).code).toBe("closed");
    expect(((await open) as StreamRefusedError).code).toBe("closed");
    expect(plane.isClosed).toBe(true);
    expect(plane.openStreams).toBe(0);
  });

  test("a peer stream id with the wrong parity is refused and cannot shadow a local stream", async () => {
    const sent: string[] = [];
    const plane = new Mux("plane", { send: (m) => { if (typeof m === "string") sent.push(m); } }, { onStreamOpen: () => {} });
    plane.receive(JSON.stringify({ t: "stream.open", id: 2, target: {} }));
    expect(sent.some((m) => m.includes('"stream.refused"') && m.includes('"id":2'))).toBe(true);
    expect(plane.openStreams).toBe(0);
    const opening = plane.openStream({}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(sent.some((m) => m.includes('"stream.open"') && m.includes('"id":2'))).toBe(true);
    await opening;
  });

  test("a reset while opening rejects the opener with the reason", async () => {
    const { plane } = connectPair({}, {
      onStreamOpen: (_target, stream) => {
        stream.reset("setup aborted");
      },
    });
    const error = await plane.openStream({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StreamRefusedError);
    expect((error as StreamRefusedError).message).toBe("setup aborted");
    expect(plane.openStreams).toBe(0);
  });

  test("forged credit cannot widen the window", async () => {
    const { plane } = connectPair({}, { onStreamOpen: () => {} }, { window: 16 });
    const stream = await plane.openStream({});
    plane.receive(JSON.stringify({ t: "stream.credit", id: stream.id, bytes: 1_000_000 }));
    // The idle consumer pulls one chunk into its queue and credits it, so two
    // windows can flow; a write of four cannot finish unless the forgery counted.
    let finished = false;
    const write = stream.write(new Uint8Array(64)).then(() => {
      finished = true;
    }, () => {});
    await settled();
    expect(finished).toBe(false);
    stream.reset("test over");
    await write;
  });

  test("pipeToStream resets the destination when the source fails", async () => {
    let read: Promise<unknown> = Promise.resolve();
    const { plane, runner } = connectPair({}, {
      onStreamOpen: (_target, stream) => {
        read = readAllFromStream(stream).then(() => "resolved", (e: unknown) => String(e));
      },
    });
    const stream = await plane.openStream({});
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("disk gone"));
      },
    });
    await expect(pipeToStream(source, stream)).rejects.toThrow(/disk gone/);
    expect(await read).toMatch(/disk gone/);
    expect(plane.openStreams).toBe(0);
    expect(runner.openStreams).toBe(0);
  });
});

describe("link lifecycle", () => {
  test("close fails pending calls and streams", async () => {
    const { plane } = connectPair({}, {
      onRpc: () => new Promise(() => {}),
      onStreamOpen: () => {},
    });
    const call = plane.rpc("hang", {});
    const stream = await plane.openStream({});
    plane.close("socket dropped");
    const error = await call.catch((e: unknown) => e);
    expect((error as RpcError).code).toBe("closed");
    await expect(stream.done).rejects.toThrow(/socket dropped/);
    await expect(plane.rpc("after", {})).rejects.toThrow(/closed/);
    expect(plane.isClosed).toBe(true);
  });

  test("unknown text frames and stray binary frames are ignored", async () => {
    const unknown: string[] = [];
    const plane = new Mux("plane", { send: () => {} }, { onUnknownFrame: (text) => unknown.push(text) });
    plane.receive(JSON.stringify({ t: "future.frame", id: 1 }));
    plane.receive("garbage");
    plane.receive(new Uint8Array([1, 0, 0, 0, 99, 1, 2, 3]));
    plane.receive(new ArrayBuffer(2));
    expect(unknown).toEqual([JSON.stringify({ t: "future.frame", id: 1 }), "garbage"]);
    expect(plane.openStreams).toBe(0);
  });

  test("hello, welcome, heartbeat and event reach their handlers", async () => {
    const seen: string[] = [];
    const { plane, runner } = connectPair(
      {
        onHello: (frame) => seen.push(`hello:${frame.runnerId}`),
        onHeartbeat: (frame) => seen.push(`heartbeat:${frame.capacity.sandboxes}`),
        onEvent: (frame) => seen.push(`event:${frame.kind}`),
      },
      { onWelcome: (frame) => seen.push(`welcome:${frame.minProtocol}`) },
    );
    runner.send({
      t: "hello",
      runnerId: "r1",
      version: "0.1.0",
      protocol: 1,
      backend: "docker",
      platform: "darwin-arm64",
      capacity: { cpu: 8, memoryMb: 16_384, sandboxes: 0 },
      logins: [],
      imageDigest: null,
    });
    plane.send({
      t: "welcome",
      protocol: 1,
      minProtocol: 1,
      image: { ref: "ghcr.io/useagenthq/sandbox:test", digest: "sha256:0" },
      heartbeatSeconds: 15,
      release: "abc",
    });
    runner.send({ t: "heartbeat", capacity: { cpu: 8, memoryMb: 16_384, sandboxes: 2 }, logins: ["codex"], imageDigest: null });
    runner.send({ t: "event", sandboxId: "c1", kind: "container.exited", detail: { code: 137 } });
    await settled();
    expect(seen).toEqual(["hello:r1", "welcome:1", "heartbeat:2", "event:container.exited"]);
  });
});
