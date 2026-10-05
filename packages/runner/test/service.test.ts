import { describe, expect, test } from "bun:test";
import { RpcError, StreamRefusedError, readAllFromStream } from "@useagent/runner-protocol";
import { AUTOSTOP_LABEL, RUNNER_LABEL, RunnerService, SANDBOX_USER } from "../src/service";
import { FakeBackend, fakeHandle, pipe } from "./fake-backend";
import { connectPair, decoder, encoder, settled } from "./pair";

const IMAGE = { ref: "ghcr.io/useagenthq/sandbox:test", digest: "sha256:" + "a".repeat(64) };

function service(backend: FakeBackend, options: { now?: () => number; runnerId?: string; maxSandboxes?: number } = {}) {
  return new RunnerService({
    runnerId: options.runnerId ?? "rn1",
    backend,
    maxSandboxes: options.maxSandboxes,
    loginMounts: async (logins) => ({
      mounts: logins.map((name) => ({ hostPath: `/staged/${name}`, containerPath: `/run/useagent/logins/${name}`, readonly: false })),
      env: Object.fromEntries(logins.map((name) => [`USEAGENT_LOGIN_${name.toUpperCase()}`, `/run/useagent/logins/${name}/auth.json`])),
    }),
    now: options.now,
  });
}

function createParams(overrides: Record<string, unknown> = {}) {
  return { image: IMAGE, env: { A: "1" }, labels: { "useagent.thread": "t1" }, cpu: 2, memoryMb: 4096, logins: ["codex"], autoStopMinutes: 30, ...overrides };
}

describe("sandbox lifecycle", () => {
  test("create pulls nothing, labels the container with the runner, mounts logins and starts it", async () => {
    const backend = new FakeBackend();
    backend.images.set(IMAGE.ref, IMAGE.digest);
    const svc = service(backend);
    const info = (await svc.rpc("sandbox.create", createParams())) as { id: string; state: string; labels: Record<string, string> };
    expect(info.state).toBe("running");
    expect(info.labels[RUNNER_LABEL]).toBe("rn1");
    expect(info.labels["useagent.thread"]).toBe("t1");
    expect(info.labels[AUTOSTOP_LABEL]).toBe("30");
    const spec = backend.containers.get(info.id)!.spec;
    expect(spec.image).toBe(`${IMAGE.ref}@${IMAGE.digest}`);
    expect(spec.env).toEqual({ A: "1", USEAGENT_LOGIN_CODEX: "/run/useagent/logins/codex/auth.json", HOME: "/home/user" });
    expect(spec.mounts).toEqual([{ hostPath: "/staged/codex", containerPath: "/run/useagent/logins/codex", readonly: false }]);
    expect(spec.cpu).toBe(2);
    expect(backend.calls.some((c) => c.startsWith("exec") && c.includes("mkdir -p /home/user/work"))).toBe(true);
    expect(backend.calls.some((c) => c.startsWith("pull"))).toBe(false);
  });

  test("create refuses an image that is not present at the expected digest", async () => {
    const backend = new FakeBackend();
    backend.images.set(IMAGE.ref, "sha256:" + "b".repeat(64));
    const error = await service(backend).rpc("sandbox.create", createParams()).catch((e: unknown) => e);
    expect((error as RpcError).code).toBe("refused");
    expect(backend.containers.size).toBe(0);
  });

  test("a create that fails after the container exists removes it", async () => {
    const backend = new FakeBackend();
    backend.images.set(IMAGE.ref, IMAGE.digest);
    backend.start = async (id) => {
      backend.calls.push(`start ${id}`);
      throw new Error("out of memory");
    };
    await expect(service(backend).rpc("sandbox.create", createParams())).rejects.toThrow(/out of memory/);
    expect(backend.containers.size).toBe(0);
    expect(backend.calls.filter((c) => c.startsWith("remove")).length).toBe(1);
    const noWorkspace = new FakeBackend();
    noWorkspace.images.set(IMAGE.ref, IMAGE.digest);
    noWorkspace.execScript = (_id, argv) => (argv.join(" ").includes("mkdir") ? { exitCode: 1, stdout: "", stderr: "read-only file system", timedOut: false } : { exitCode: 0, stdout: "", stderr: "", timedOut: false });
    await expect(service(noWorkspace).rpc("sandbox.create", createParams())).rejects.toThrow(/workspace setup failed: read-only/);
    expect(noWorkspace.containers.size).toBe(0);
  });

  test("an engine that boots a tag is checked on what booted", async () => {
    const backend = new FakeBackend();
    backend.pinsByDigest = false;
    backend.images.set(IMAGE.ref, IMAGE.digest);
    backend.bootDigest = "sha256:" + "c".repeat(64);
    const error = await service(backend).rpc("sandbox.create", createParams()).catch((e: unknown) => e);
    expect((error as RpcError).code).toBe("refused");
    expect(String(error)).toMatch(/booted sha256:c+, not/);
    expect(backend.containers.size).toBe(0);
    backend.bootDigest = IMAGE.digest;
    expect(((await service(backend).rpc("sandbox.create", createParams())) as { state: string }).state).toBe("running");
  });

  test("create refuses beyond the machine's sandbox limit", async () => {
    const backend = new FakeBackend();
    backend.images.set(IMAGE.ref, IMAGE.digest);
    backend.seed("one", { [RUNNER_LABEL]: "rn1" });
    backend.seed("two", { [RUNNER_LABEL]: "rn1" });
    backend.seed("parked", { [RUNNER_LABEL]: "rn1" }, "stopped");
    backend.seed("theirs", { [RUNNER_LABEL]: "other" });
    const error = await service(backend, { maxSandboxes: 2 }).rpc("sandbox.create", createParams()).catch((e: unknown) => e);
    expect((error as RpcError).code).toBe("refused");
    expect(String(error)).toMatch(/limit of 2 running sandboxes/);
    expect(backend.calls.filter((c) => c.startsWith("create"))).toEqual([]);
    expect(((await service(backend, { maxSandboxes: 3 }).rpc("sandbox.create", createParams())) as { state: string }).state).toBe("running");
  });

  test("get, list, start and delete work only on this runner's containers", async () => {
    const backend = new FakeBackend();
    backend.seed("mine", { [RUNNER_LABEL]: "rn1" }, "stopped");
    backend.seed("theirs", { [RUNNER_LABEL]: "other" });
    backend.seed("unlabelled", {});
    const svc = service(backend);
    expect(((await svc.rpc("sandbox.list", {})) as { id: string }[]).map((s) => s.id)).toEqual(["mine"]);
    expect(((await svc.rpc("sandbox.start", { sandboxId: "mine" })) as { state: string }).state).toBe("running");
    for (const id of ["theirs", "unlabelled", "missing"]) {
      for (const method of ["sandbox.get", "sandbox.start", "sandbox.delete", "process.execute"]) {
        const error = await svc.rpc(method, { sandboxId: id, command: "id" }).catch((e: unknown) => e);
        expect((error as RpcError).code).toBe("not_found");
      }
    }
    expect(backend.calls.filter((c) => c.startsWith("exec"))).toEqual([]);
    await svc.rpc("sandbox.delete", { sandboxId: "mine" });
    expect(backend.containers.has("mine")).toBe(false);
    expect(backend.containers.has("theirs")).toBe(true);
  });

  test("bad params and unknown methods answer with codes", async () => {
    const svc = service(new FakeBackend());
    expect(((await svc.rpc("sandbox.get", {}).catch((e: unknown) => e)) as RpcError).code).toBe("invalid_params");
    expect(((await svc.rpc("sandbox.create", { image: {} }).catch((e: unknown) => e)) as RpcError).code).toBe("invalid_params");
    expect(((await svc.rpc("nope", {}).catch((e: unknown) => e)) as RpcError).code).toBe("unsupported");
    expect(((await svc.rpc("pty.resize", { streamId: 9, cols: 1, rows: 1 }).catch((e: unknown) => e)) as RpcError).code).toBe("not_found");
  });
});

describe("sessions", () => {
  test("session and command ids are plain identifiers, nowhere else in the filesystem", async () => {
    const backend = new FakeBackend();
    backend.seed("c1", { [RUNNER_LABEL]: "rn1" });
    const svc = service(backend);
    for (const bad of ["../../home/user", "a/b", "..", "", ".hidden/../x"]) {
      for (const method of ["session.get", "session.delete", "session.command"]) {
        const error = await svc.rpc(method, { sandboxId: "c1", sessionId: bad, commandId: "cmd" }).catch((e: unknown) => e);
        expect((error as RpcError).code).toBe("invalid_params");
      }
      const error = await svc.rpc("session.logs", { sandboxId: "c1", sessionId: "s", commandId: bad }).catch((e: unknown) => e);
      expect((error as RpcError).code).toBe("invalid_params");
    }
    expect(backend.calls.filter((c) => c.startsWith("exec"))).toEqual([]);
    const { plane } = connectPair({}, { onStreamOpen: (target, stream) => svc.stream(target, stream) });
    const refused = await plane.openStream({ kind: "logs.follow", sandboxId: "c1", sessionId: "s", commandId: "../../etc/passwd" }).catch((e: unknown) => e);
    expect((refused as StreamRefusedError).code).toBe("invalid_params");
  });

  test("a status read that did not complete is an error, never a running command", async () => {
    const backend = new FakeBackend();
    backend.seed("c1", { [RUNNER_LABEL]: "rn1" });
    backend.execScript = () => ({ exitCode: 137, stdout: "", stderr: "", timedOut: true });
    const svc = service(backend);
    for (const method of ["session.command", "session.get", "session.logs"]) {
      const error = await svc.rpc(method, { sandboxId: "c1", sessionId: "s", commandId: "cmd" }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcError);
      expect(String(error)).toMatch(/did not answer in time/);
    }
    backend.execScript = () => ({ exitCode: 2, stdout: "", stderr: "permission denied", timedOut: false });
    await expect(svc.rpc("session.command", { sandboxId: "c1", sessionId: "s", commandId: "cmd" })).rejects.toThrow(/status read failed: permission denied/);
  });

  test("a detached command fails to launch when its working directory is gone", async () => {
    const backend = new FakeBackend();
    backend.seed("c1", { [RUNNER_LABEL]: "rn1" });
    await service(backend).rpc("session.execute", { sandboxId: "c1", sessionId: "s", command: "sleep 1", runAsync: true });
    const launch = backend.calls.find((c) => c.includes("nohup setsid"))!;
    expect(launch).toContain("cd '/home/user/work' || exit 1; nohup setsid");
  });
});

describe("commands", () => {
  test("process.execute runs as the sandbox user in the workdir and maps timeouts", async () => {
    const backend = new FakeBackend();
    backend.seed("c1", { [RUNNER_LABEL]: "rn1" });
    let seen: unknown;
    backend.execScript = (_id, argv, options) => {
      seen = { argv, options };
      return { exitCode: 0, stdout: "out", stderr: "err", timedOut: true };
    };
    const result = await service(backend).rpc("process.execute", { sandboxId: "c1", command: "ls", timeoutSeconds: 5 });
    expect(result).toEqual({ exitCode: 124, result: "outerr" });
    expect(seen).toMatchObject({ argv: ["sh", "-c", "ls"], options: { user: SANDBOX_USER, cwd: "/home/user/work", timeoutMs: 5000 } });
  });

  test("fs.details parses stat", async () => {
    const backend = new FakeBackend();
    backend.seed("c1", { [RUNNER_LABEL]: "rn1" });
    backend.execScript = (_id, argv) => (argv[0] === "stat" ? { exitCode: 0, stdout: "1234\n", stderr: "", timedOut: false } : { exitCode: 1, stdout: "", stderr: "no", timedOut: false });
    expect(await service(backend).rpc("fs.details", { sandboxId: "c1", path: "/x" })).toEqual({ size: 1234 });
  });
});

describe("idle stop", () => {
  test("stops running containers past their auto-stop label", async () => {
    let now = 1_000_000;
    const backend = new FakeBackend();
    backend.seed("idle", { [RUNNER_LABEL]: "rn1", [AUTOSTOP_LABEL]: "10" });
    backend.seed("busy", { [RUNNER_LABEL]: "rn1", [AUTOSTOP_LABEL]: "10" });
    backend.seed("forever", { [RUNNER_LABEL]: "rn1", [AUTOSTOP_LABEL]: "0" });
    const svc = service(backend, { now: () => now });
    expect(await svc.stopIdle()).toEqual([]);
    now += 11 * 60_000;
    await svc.rpc("sandbox.get", { sandboxId: "busy" });
    expect(await svc.stopIdle()).toEqual(["idle"]);
    expect(backend.containers.get("idle")?.state).toBe("stopped");
    expect(backend.containers.get("busy")?.state).toBe("running");
    expect(backend.containers.get("forever")?.state).toBe("running");
  });

  test("a sandbox with an open stream is in use however long the clock says", async () => {
    let now = 1_000_000;
    const backend = new FakeBackend();
    backend.seed("served", { [RUNNER_LABEL]: "rn1", [AUTOSTOP_LABEL]: "10" });
    const fromContainer = pipe();
    backend.dialScript = () => ({ readable: fromContainer.readable, write: async () => {}, end: () => fromContainer.end(), close: () => {}, closed: Promise.resolve() });
    const svc = service(backend, { now: () => now });
    const { plane } = connectPair({}, { onStreamOpen: (target, stream) => svc.stream(target, stream) });
    const stream = await plane.openStream({ kind: "port", sandboxId: "served", port: 8080 });
    await stream.write(encoder.encode("traffic"));
    now += 60 * 60_000;
    expect(await svc.stopIdle()).toEqual([]);
    expect(backend.containers.get("served")?.state).toBe("running");
    stream.end();
    await stream.done;
    // The stream just ended: the idle clock starts now, not when the stream opened.
    expect(await svc.stopIdle()).toEqual([]);
    now += 11 * 60_000;
    expect(await svc.stopIdle()).toEqual(["served"]);
    // A stream refused before it opened never counted as use.
    await svc.rpc("sandbox.start", { sandboxId: "served" });
    for (const target of [
      { kind: "port", sandboxId: "served", port: 0 },
      { kind: "logs.follow", sandboxId: "served", sessionId: "../x", commandId: "c" },
      { kind: "nope", sandboxId: "served" },
    ]) {
      await expect(plane.openStream(target)).rejects.toBeInstanceOf(StreamRefusedError);
    }
    now += 11 * 60_000;
    expect(await svc.stopIdle()).toEqual(["served"]);
  });
});

describe("streams", () => {
  test("a port stream carries bytes both ways and closes with the connection", async () => {
    const backend = new FakeBackend();
    backend.seed("c1", { [RUNNER_LABEL]: "rn1" });
    const toContainer: Uint8Array[] = [];
    const fromContainer = pipe();
    let ended = false;
    backend.dialScript = () => ({
      readable: fromContainer.readable,
      write: async (bytes) => {
        toContainer.push(bytes);
      },
      end: () => {
        ended = true;
        fromContainer.write(encoder.encode("bye"));
        fromContainer.end();
      },
      close: () => {},
      closed: Promise.resolve(),
    });
    const svc = service(backend);
    const { plane } = connectPair({}, { onStreamOpen: (target, stream) => svc.stream(target, stream) });
    const stream = await plane.openStream({ kind: "port", sandboxId: "c1", port: 8080 });
    await stream.write(encoder.encode("GET / HTTP/1.0\r\n\r\n"));
    stream.end();
    expect(decoder.decode(await readAllFromStream(stream))).toBe("bye");
    expect(decoder.decode(toContainer[0])).toBe("GET / HTTP/1.0\r\n\r\n");
    expect(ended).toBe(true);
    await stream.done;
  });

  test("streams into a container that is not ours or not running are refused", async () => {
    const backend = new FakeBackend();
    backend.seed("stopped", { [RUNNER_LABEL]: "rn1" }, "stopped");
    backend.seed("theirs", { [RUNNER_LABEL]: "x" });
    const svc = service(backend);
    const { plane } = connectPair({}, { onStreamOpen: (target, stream) => svc.stream(target, stream) });
    const a = await plane.openStream({ kind: "port", sandboxId: "stopped", port: 1 }).catch((e: unknown) => e);
    expect((a as StreamRefusedError).code).toBe("refused");
    const b = await plane.openStream({ kind: "port", sandboxId: "theirs", port: 1 }).catch((e: unknown) => e);
    expect((b as StreamRefusedError).code).toBe("not_found");
    const c = await plane.openStream({ kind: "port", sandboxId: "theirs", port: 70_000 }).catch((e: unknown) => e);
    expect((c as StreamRefusedError).code).toBe("not_found");
    const d = await plane.openStream({ kind: "nope", sandboxId: "stopped" }).catch((e: unknown) => e);
    expect((d as StreamRefusedError).code).toBe("refused");
  });

  test("file.write streams into cat and acknowledges with a half-close; file.read streams cat out", async () => {
    const backend = new FakeBackend();
    backend.seed("c1", { [RUNNER_LABEL]: "rn1" });
    const written: Uint8Array[] = [];
    let writeHandle = fakeHandle();
    let readHandle = fakeHandle();
    backend.spawnScript = (_id, argv) => {
      if (argv[0] === "cat") {
        readHandle = fakeHandle();
        readHandle.out.write(encoder.encode("file body"));
        readHandle.finish(0);
        return readHandle;
      }
      writeHandle = fakeHandle();
      void (async () => {
        for await (const chunk of writeHandle.stdin.readable) written.push(chunk);
        writeHandle.finish(0);
      })();
      return writeHandle;
    };
    const svc = service(backend);
    const { plane } = connectPair({}, { onStreamOpen: (target, stream) => svc.stream(target, stream) });
    const w = await plane.openStream({ kind: "file.write", sandboxId: "c1", path: "/home/user/x.txt" });
    await w.write(encoder.encode("hello file"));
    w.end();
    await w.done;
    expect(decoder.decode(written[0])).toBe("hello file");
    const r = await plane.openStream({ kind: "file.read", sandboxId: "c1", path: "/home/user/x.txt" });
    expect(decoder.decode(await readAllFromStream(r))).toBe("file body");
    r.end();
    await settled();
  });
});
