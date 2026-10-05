import { describe, expect, test } from "bun:test";
import type { LocalSandboxInfo } from "@useagent/runner-protocol";
import { SandboxNotFoundError, memorySandboxLabelStore } from "@useagent/sandbox-contract";
import { type FakeLink, fakeLink, fakeLinkDirectory } from "./fake-link";
import { localProviderConfig } from "./plugin";
import { LocalProvider, RunnerOfflineError } from "./provider";

const IMAGE = { ref: "ghcr.io/useagenthq/sandbox:test", digest: "sha256:" + "a".repeat(64) };
const ENV = { SANDBOX_IMAGE_REF: IMAGE.ref, SANDBOX_IMAGE_DIGEST: IMAGE.digest, SANDBOX_CPU: "2", SANDBOX_MEMORY_GIB: "4" };

function info(overrides: Partial<LocalSandboxInfo> = {}): LocalSandboxInfo {
  return { id: "c1", state: "running", labels: { "useagent.runner": "rn1" }, cpu: 2, memoryMb: 4096, imageDigest: IMAGE.digest, createdAt: "2026-09-08T00:00:00Z", ...overrides };
}

function runner(overrides: Partial<Parameters<typeof fakeLink>[0]> = {}): FakeLink {
  return fakeLink({
    id: "rn1",
    onCall: async (method, params) => {
      switch (method) {
        case "sandbox.create":
          return info({ labels: { ...(params as { labels: Record<string, string> }).labels, "useagent.runner": "rn1" } });
        case "sandbox.get":
          if ((params as { sandboxId: string }).sandboxId !== "c1") throw Object.assign(new Error("no"), { code: "not_found" });
          return info();
        case "sandbox.list":
          return [info(), info({ id: "c2", state: "stopped" })];
        case "sandbox.start":
          return info();
        case "sandbox.delete":
          return null;
        case "process.execute":
          return { exitCode: 0, result: `ran ${(params as { command: string }).command}` };
        case "session.execute":
          return { cmdId: "cmd-1", output: "out", exitCode: 0 };
        case "session.get":
          return { commands: [{ id: "cmd-1", exitCode: 3 }, { id: "cmd-2" }] };
        case "session.command":
          return { id: "cmd-1", exitCode: 3 };
        case "session.logs":
          return { output: "log body" };
        case "session.list":
          return { sessions: ["a", "b"] };
        case "fs.details":
          return { size: 42 };
        case "pty.resize":
          return null;
        default:
          return null;
      }
    },
    ...overrides,
  });
}

describe("local provider", () => {
  test("creates on the selected runner with the deployment image, resources, logins and labels", async () => {
    const link = runner();
    const labels = memorySandboxLabelStore();
    const provider = new LocalProvider(localProviderConfig(ENV, { runnerId: "rn1", logins: ["codex"] }), { links: fakeLinkDirectory([link]), labels });
    const handle = await provider.create({ envVars: { A: "1" }, labels: { "useagent.thread": "t1" }, autoStopInterval: 30 });
    expect(handle.id).toBe("local:rn1:c1");
    expect(handle.providerKind).toBe("local");
    expect(handle.cpu).toBe(2);
    expect(handle.memory).toBe(4);
    expect(handle.state).toBe("started");
    expect(link.calls[0]).toEqual({
      method: "sandbox.create",
      params: { image: IMAGE, env: { A: "1" }, labels: { "useagent.thread": "t1" }, cpu: 2, memoryMb: 4096, logins: ["codex"], autoStopMinutes: 30 },
    });
    expect((await labels.read(["local:rn1:c1"])).get("local:rn1:c1")).toEqual({ "useagent.thread": "t1" });
    expect(provider.connectionFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses to create without a runner, an image, or a connected runner", async () => {
    const directory = fakeLinkDirectory([runner({ online: false })]);
    await expect(new LocalProvider(localProviderConfig(ENV), { links: directory }).create()).rejects.toThrow(/no runner/);
    await expect(new LocalProvider(localProviderConfig({}, { runnerId: "rn1" }), { links: directory }).create()).rejects.toThrow(/SANDBOX_IMAGE_REF/);
    await expect(new LocalProvider(localProviderConfig(ENV, { runnerId: "rn1" }), { links: directory }).create()).rejects.toBeInstanceOf(RunnerOfflineError);
    await expect(new LocalProvider(localProviderConfig(ENV, { runnerId: "rn1" }), {}).create()).rejects.toThrow(/link directory/);
  });

  test("get resolves the runner from the id and merges the plane's labels", async () => {
    const link = runner();
    const labels = memorySandboxLabelStore();
    await labels.write("local:rn1:c1", { "useagent.run": "r9" });
    const provider = new LocalProvider(localProviderConfig(ENV), { links: fakeLinkDirectory([link]), labels });
    const handle = await provider.get("local:rn1:c1");
    expect(handle.labels).toEqual({ "useagent.runner": "rn1", "useagent.run": "r9" });
    await expect(provider.get("local:rn1:nope")).rejects.toBeInstanceOf(SandboxNotFoundError);
    await expect(provider.get("sb-other-provider")).rejects.toBeInstanceOf(SandboxNotFoundError);
    await expect(provider.get("local:rn2:c1")).rejects.toBeInstanceOf(RunnerOfflineError);
  });

  test("list walks every connected runner", async () => {
    const provider = new LocalProvider(localProviderConfig(ENV), { links: fakeLinkDirectory([runner(), runner({ id: "rn2", online: false })]) });
    const ids: string[] = [];
    for await (const handle of provider.list()) ids.push(`${handle.id}:${handle.state}`);
    expect(ids).toEqual(["local:rn1:c1:started", "local:rn1:c2:stopped"]);
  });

  test("start, delete and preview links go through the link", async () => {
    const link = runner();
    const labels = memorySandboxLabelStore();
    const provider = new LocalProvider(localProviderConfig(ENV), { links: fakeLinkDirectory([link]), labels });
    const handle = await provider.get("local:rn1:c1");
    await handle.start();
    const preview = await handle.getPreviewLink(37_733);
    expect(preview).toEqual({ url: "http://127.0.0.1:40001", token: "", headers: {} });
    expect(link.forwards).toEqual([{ sandboxId: "c1", port: 37_733 }]);
    await labels.write(handle.id, { x: "y" });
    await handle.delete();
    expect(handle.state).toBe("deleted");
    expect(link.released).toEqual(["c1"]);
    expect((await labels.read([handle.id])).size).toBe(0);
    expect(link.calls.map((c) => c.method)).toEqual(["sandbox.get", "sandbox.start", "sandbox.delete"]);
  });
});

describe("local process and file system", () => {
  test("maps every SandboxProcess call to its rpc", async () => {
    const link = runner();
    const provider = new LocalProvider(localProviderConfig(ENV), { links: fakeLinkDirectory([link]) });
    const { process } = await provider.get("local:rn1:c1");
    expect(await process.executeCommand("id", "/x", { A: "1" }, 5)).toEqual({ result: "ran id", exitCode: 0 });
    await process.createSession("s");
    expect(await process.executeSessionCommand("s", { command: "echo", runAsync: true }, 9)).toEqual({ cmdId: "cmd-1", output: "out", stdout: "out", stderr: "", exitCode: 0 });
    expect(await process.getSession("s")).toEqual({ sessionId: "s", commands: [{ id: "cmd-1", exitCode: 3 }, { id: "cmd-2" }] });
    expect(await process.getSessionCommand?.("s", "cmd-1")).toEqual({ id: "cmd-1", exitCode: 3 });
    expect(await process.getSessionCommandLogs("s", "cmd-1")).toEqual({ output: "log body", stdout: "log body", stderr: "" });
    await process.sendSessionCommandInput?.("s", "cmd-1", "hi\n");
    expect(await process.listSessions?.()).toEqual([{ sessionId: "a", commands: [] }, { sessionId: "b", commands: [] }]);
    await process.deleteSession("s");
    const methods = link.calls.map((c) => c.method);
    expect(methods).toEqual(["sandbox.get", "process.execute", "session.create", "session.execute", "session.get", "session.command", "session.logs", "session.input", "session.list", "session.delete"]);
    expect(link.calls[1]?.params).toEqual({ sandboxId: "c1", command: "id", cwd: "/x", env: { A: "1" }, timeoutSeconds: 5 });
    expect(link.calls[7]?.params).toEqual({ sandboxId: "c1", sessionId: "s", commandId: "cmd-1", data: "hi\n" });
  });

  test("files travel as streams and log following reads until the runner ends the stream", async () => {
    const encoder = new TextEncoder();
    const written: { target: unknown; bytes: Uint8Array[] }[] = [];
    const link = runner({
      onStream: async (target, far) => {
        const t = target as { kind: string };
        if (t.kind === "file.read") {
          await far.write(encoder.encode("file "));
          await far.write(encoder.encode("body"));
          far.end();
        } else if (t.kind === "file.write") {
          const entry = { target, bytes: [] as Uint8Array[] };
          written.push(entry);
          void (async () => {
            for await (const chunk of far.readable) entry.bytes.push(chunk);
            far.end();
          })();
        } else if (t.kind === "logs.follow") {
          await far.write(encoder.encode("line 1\n"));
          await far.write(encoder.encode("line 2\n"));
          far.end();
        }
      },
    });
    const provider = new LocalProvider(localProviderConfig(ENV), { links: fakeLinkDirectory([link]) });
    const { fs, process } = await provider.get("local:rn1:c1");
    expect((await fs.downloadFile("/home/user/a.txt")).toString("utf8")).toBe("file body");
    await fs.uploadFile(Buffer.from("upload me"), "/home/user/b.txt");
    expect(written[0]?.target).toEqual({ kind: "file.write", sandboxId: "c1", path: "/home/user/b.txt" });
    expect(Buffer.concat(written[0]!.bytes).toString("utf8")).toBe("upload me");
    expect(await fs.getFileDetails("/home/user/b.txt")).toEqual({ size: 42 });
    const lines: string[] = [];
    await process.followSessionCommandLogs?.("s", "cmd-1", (chunk) => lines.push(chunk), () => {});
    expect(lines.join("")).toBe("line 1\nline 2\n");
  });

  test("an upload the runner rejects fails the caller", async () => {
    const link = runner({
      onStream: async (_target, far) => {
        void (async () => {
          for await (const _chunk of far.readable) {
            /* drain */
          }
          far.reset("disk full");
        })();
      },
    });
    const provider = new LocalProvider(localProviderConfig(ENV), { links: fakeLinkDirectory([link]) });
    const { fs } = await provider.get("local:rn1:c1");
    await expect(fs.uploadFile(Buffer.from("x"), "/home/user/c.txt")).rejects.toThrow(/disk full/);
  });

  test("a pty is a stream with resize over rpc", async () => {
    const encoder = new TextEncoder();
    let far: Parameters<NonNullable<Parameters<typeof fakeLink>[0]["onStream"]>>[1] | null = null;
    const link = runner({
      onStream: async (target, stream) => {
        expect(target).toEqual({ kind: "pty", sandboxId: "c1", cols: 80, rows: 24, cwd: undefined });
        far = stream;
        void (async () => {
          for await (const chunk of stream.readable) await stream.write(encoder.encode(`echo:${new TextDecoder().decode(chunk)}`));
        })();
      },
    });
    const provider = new LocalProvider(localProviderConfig(ENV), { links: fakeLinkDirectory([link]) });
    const { process } = await provider.get("local:rn1:c1");
    const output: string[] = [];
    const pty = await process.createPty({ id: "t", cols: 80, rows: 24, onData: (data) => { output.push(new TextDecoder().decode(data)); } });
    await pty.waitForConnection();
    await pty.sendInput("ls\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output.join("")).toBe("echo:ls\n");
    await pty.resize(120, 40);
    expect(link.calls.at(-1)).toEqual({ method: "pty.resize", params: { streamId: expect.any(Number), cols: 120, rows: 40 } });
    far!.end();
    await pty.disconnect();
    expect(await pty.waitForTermination()).toEqual({});
  });
});
