// The real thing: sessions, files, a port dial and a terminal against a Docker
// container. Skipped when no daemon answers, so the unit suite stays green on
// a machine without Docker; CI's Linux runners have it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readAllFromStream } from "@useagent/runner-protocol";
import { DockerBackend } from "../src/backends/docker";
import { RUNNER_LABEL, RunnerService, SANDBOX_USER } from "../src/service";
import { connectPair, decoder, encoder } from "./pair";

const TEST_IMAGE = "useagent-runner-test:debian-1";
const DOCKERFILE = `FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends socat procps bash ca-certificates && rm -rf /var/lib/apt/lists/* \\
 && useradd -m -u 1000 user && mkdir -p /home/user/work && chown -R user:user /home/user
`;

const backend = new DockerBackend();
const dockerProblem = await backend.available();
const RUNNER_ID = `test-${crypto.randomUUID().slice(0, 8)}`;
let sandboxId = "";

async function until<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(dockerProblem !== null)("docker backend", () => {
  const service = new RunnerService({ runnerId: RUNNER_ID, backend, loginMounts: async () => ({ mounts: [], env: {} }) });
  const { plane } = connectPair({}, {
    onRpc: (method, params) => service.rpc(method, params),
    onStreamOpen: (target, stream) => service.stream(target, stream),
  });

  beforeAll(async () => {
    const build = Bun.spawn(["docker", "build", "-q", "-t", TEST_IMAGE, "-"], { stdin: new Blob([DOCKERFILE]), stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(build.stderr).text();
    if ((await build.exited) !== 0) throw new Error(`test image build failed: ${stderr}`);
    sandboxId = `useagent-test-${crypto.randomUUID().slice(0, 8)}`;
    await backend.create({
      name: sandboxId,
      image: TEST_IMAGE,
      env: { HOME: "/home/user" },
      labels: { [RUNNER_LABEL]: RUNNER_ID, "useagent.cpu": "1", "useagent.memory-mb": "512" },
      cpu: 1,
      memoryMb: 512,
      mounts: [],
    });
    await backend.start(sandboxId);
  }, 240_000);

  afterAll(async () => {
    if (sandboxId) await backend.remove(sandboxId).catch(() => {});
  });

  test("the container is ours, running, and commands run as the sandbox user", async () => {
    const info = (await service.rpc("sandbox.get", { sandboxId })) as { state: string; labels: Record<string, string> };
    expect(info.state).toBe("running");
    expect(info.labels[RUNNER_LABEL]).toBe(RUNNER_ID);
    const who = (await service.rpc("process.execute", { sandboxId, command: "id -u; pwd; echo $HOME" })) as { exitCode: number; result: string };
    expect(who.exitCode).toBe(0);
    expect(who.result).toBe("1000\n/home/user/work\n/home/user\n");
    const failed = (await service.rpc("process.execute", { sandboxId, command: "exit 3" })) as { exitCode: number };
    expect(failed.exitCode).toBe(3);
  });

  test("a synchronous session command returns its output and exit code", async () => {
    const result = (await service.rpc("session.execute", { sandboxId, sessionId: "s-sync", command: "echo out; echo err >&2; exit 5" })) as { output: string; exitCode: number };
    expect(result.output).toContain("out\n");
    expect(result.output).toContain("err\n");
    expect(result.exitCode).toBe(5);
  });

  test("a detached command survives, takes stdin through its FIFO, and reports its exit", async () => {
    const launched = (await service.rpc("session.execute", {
      sandboxId,
      sessionId: "s-async",
      command: "echo started; read line; echo got:$line; exit 7",
      runAsync: true,
    })) as { cmdId: string };
    await until(async () => ((await service.rpc("session.logs", { sandboxId, sessionId: "s-async", commandId: launched.cmdId })) as { output: string }).output.includes("started"));
    const running = (await service.rpc("session.command", { sandboxId, sessionId: "s-async", commandId: launched.cmdId })) as { exitCode?: number };
    expect(running.exitCode).toBeUndefined();
    await service.rpc("session.input", { sandboxId, sessionId: "s-async", commandId: launched.cmdId, data: "hello\n" });
    const finished = await until(async () => {
      const command = (await service.rpc("session.command", { sandboxId, sessionId: "s-async", commandId: launched.cmdId })) as { exitCode?: number };
      return command.exitCode !== undefined ? command : null;
    });
    expect(finished.exitCode).toBe(7);
    const logs = (await service.rpc("session.logs", { sandboxId, sessionId: "s-async", commandId: launched.cmdId })) as { output: string };
    expect(logs.output).toBe("started\ngot:hello\n");
    const session = (await service.rpc("session.get", { sandboxId, sessionId: "s-async" })) as { commands: { id: string; exitCode?: number }[] };
    expect(session.commands).toEqual([{ id: launched.cmdId, exitCode: 7 }]);
    expect(await service.rpc("session.list", { sandboxId })).toEqual({ sessions: ["s-async", "s-sync"] });
  });

  test("deleting a session kills its process group", async () => {
    const launched = (await service.rpc("session.execute", { sandboxId, sessionId: "s-kill", command: "sleep 300", runAsync: true })) as { cmdId: string };
    await until(async () => (await backend.exec(sandboxId, ["pgrep", "-f", "sleep 300"], { user: SANDBOX_USER })).exitCode === 0);
    await service.rpc("session.delete", { sandboxId, sessionId: "s-kill" });
    await until(async () => (await backend.exec(sandboxId, ["pgrep", "-f", "sleep 300"], { user: SANDBOX_USER })).exitCode !== 0);
    expect(launched.cmdId).toBeTruthy();
  });

  test("file write, details and read round-trip through streams", async () => {
    const body = encoder.encode("line one\nline two\n");
    const w = await plane.openStream({ kind: "file.write", sandboxId, path: "/home/user/work/notes/a.txt" });
    await w.write(body);
    w.end();
    await w.done;
    expect(await service.rpc("fs.details", { sandboxId, path: "/home/user/work/notes/a.txt" })).toEqual({ size: body.byteLength });
    const r = await plane.openStream({ kind: "file.read", sandboxId, path: "/home/user/work/notes/a.txt" });
    expect(decoder.decode(await readAllFromStream(r))).toBe("line one\nline two\n");
    r.end();
    const missing = await plane.openStream({ kind: "file.read", sandboxId, path: "/home/user/work/none" });
    await expect(readAllFromStream(missing)).rejects.toThrow(/read failed/);
  });

  test("a port inside the container is reachable through a stream", async () => {
    await service.rpc("session.execute", {
      sandboxId,
      sessionId: "s-port",
      command: "socat TCP-LISTEN:8080,reuseaddr,fork EXEC:'echo hello-from-port'",
      runAsync: true,
    });
    // The listener comes up asynchronously; a dial before that reads nothing.
    const text = await until(async () => {
      const stream = await plane.openStream({ kind: "port", sandboxId, port: 8080 });
      const bytes = await readAllFromStream(stream).catch(() => new Uint8Array());
      stream.end();
      return bytes.byteLength > 0 ? decoder.decode(bytes) : null;
    });
    expect(text).toBe("hello-from-port\n");
  }, 30_000);

  test("a terminal stream runs an interactive shell and resizes", async () => {
    const stream = await plane.openStream({ kind: "pty", sandboxId, cols: 80, rows: 24 });
    const output: string[] = [];
    const reading = (async () => {
      for await (const chunk of stream.readable) output.push(decoder.decode(chunk));
    })();
    await stream.write(encoder.encode("stty size; echo PTY_$(id -u)_OK\n"));
    await until(async () => output.join("").includes("PTY_1000_OK") || null).catch((error: unknown) => {
      throw new Error(`${String(error)}; terminal output so far: ${JSON.stringify(output.join(""))}`);
    });
    expect(output.join("")).toContain("24 80");
    await plane.rpc("pty.resize", { streamId: stream.id, cols: 120, rows: 40 });
    await stream.write(encoder.encode("stty size\n"));
    await until(async () => output.join("").includes("40 120") || null);
    await stream.write(encoder.encode("exit\n"));
    await reading;
    stream.end();
    await stream.done;
  }, 30_000);

  test("delete removes the container and later calls are refused", async () => {
    await service.rpc("sandbox.delete", { sandboxId });
    expect(await backend.inspect(sandboxId)).toBeNull();
    const error = await service.rpc("sandbox.get", { sandboxId }).catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("not_found");
    sandboxId = "";
  });
});
