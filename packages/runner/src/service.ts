// The runner's side of the link: every RPC the control plane may call and
// every byte stream it may open, implemented over one LocalBackend. Nothing
// here executes on the host. Every call names a container this runner created
// (its label carries the runner id), or it is refused.

import {
  type LocalSandboxCreateParams,
  type LocalSandboxInfo,
  type MuxStream,
  RpcError,
  StreamRefusedError,
  type StreamTarget,
  pipeToStream,
} from "@useagent/runner-protocol";
import type { ContainerInfo, ContainerMount, LocalBackend } from "./backends/types";
import { BackendError } from "./backends/types";
import { SessionManager } from "./sessions";

export const RUNNER_LABEL = "useagent.runner";
export const AUTOSTOP_LABEL = "useagent.autostop-minutes";
export const SANDBOX_USER = "1000:1000";
export const SANDBOX_HOME = "/home/user";
export const SANDBOX_WORKDIR = "/home/user/work";

export interface ServiceOptions {
  readonly runnerId: string;
  readonly backend: LocalBackend;
  /** Mounts and env for the logins the plane asked for and this machine has. */
  readonly loginMounts: (logins: readonly string[]) => Promise<{ mounts: ContainerMount[]; env: Record<string, string> }>;
  readonly onSandboxStopped?: (sandboxId: string) => Promise<void> | void;
  /** Running sandboxes this machine will hold at once; create refuses beyond it. */
  readonly maxSandboxes?: number;
  readonly now?: () => number;
}

/** Session and command ids become path segments inside the container; nothing else is accepted. */
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(params: unknown, key: string): string {
  if (!isRecord(params) || typeof params[key] !== "string" || !params[key]) {
    throw new RpcError("invalid_params", `${key} is required`);
  }
  return params[key];
}

function plainId(params: unknown, key: string): string {
  const value = str(params, key);
  if (!PLAIN_ID.test(value) || value.includes("..")) throw new RpcError("invalid_params", `${key} must be a plain identifier`);
  return value;
}

function infoOf(container: ContainerInfo): LocalSandboxInfo {
  return {
    id: container.name,
    state: container.state,
    labels: container.labels,
    cpu: Number(container.labels["useagent.cpu"] ?? 0),
    memoryMb: Number(container.labels["useagent.memory-mb"] ?? 0),
    imageDigest: container.imageDigest,
    createdAt: container.createdAt,
  };
}

export class RunnerService {
  private readonly sessions: SessionManager;
  private readonly lastActivity = new Map<string, number>();
  /** Streams open per sandbox; a sandbox with one is in use whatever the clock says. */
  private readonly openStreams = new Map<string, number>();
  /** Open terminals by stream id, with the container-side tty each shell reported. */
  private readonly terminals = new Map<number, { terminal: Bun.Terminal; sandboxId: string; ttyFile: string }>();
  private readonly now: () => number;

  constructor(private readonly options: ServiceOptions) {
    this.sessions = new SessionManager(options.backend, { user: SANDBOX_USER, home: SANDBOX_HOME, workdir: SANDBOX_WORKDIR });
    this.now = options.now ?? Date.now;
  }

  get backend(): LocalBackend {
    return this.options.backend;
  }

  /** Containers this runner created, running or not. */
  async listOwned(): Promise<ContainerInfo[]> {
    return this.options.backend.list({ [RUNNER_LABEL]: this.options.runnerId });
  }

  /** The container behind a sandbox id, only when this runner made it. */
  async owned(sandboxId: string): Promise<ContainerInfo> {
    const info = await this.options.backend.inspect(sandboxId);
    if (!info || info.labels[RUNNER_LABEL] !== this.options.runnerId) {
      throw new RpcError("not_found", `sandbox ${sandboxId} is not one of this runner's`);
    }
    this.lastActivity.set(sandboxId, this.now());
    return info;
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.dispatch(method, params);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (error instanceof BackendError) {
        throw new RpcError(error.code === "not_found" ? "not_found" : "internal", error.message);
      }
      throw new RpcError("internal", error instanceof Error ? error.message : String(error));
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const backend = this.options.backend;
    switch (method) {
      case "sandbox.create":
        return this.create(params as LocalSandboxCreateParams);
      case "sandbox.get":
        return infoOf(await this.owned(str(params, "sandboxId")));
      case "sandbox.list":
        return (await this.listOwned()).map(infoOf);
      case "sandbox.start": {
        const info = await this.owned(str(params, "sandboxId"));
        if (info.state !== "running") await backend.start(info.name);
        return infoOf((await backend.inspect(info.name)) ?? info);
      }
      case "sandbox.delete": {
        const info = await this.owned(str(params, "sandboxId"));
        await backend.remove(info.name);
        this.lastActivity.delete(info.name);
        await this.options.onSandboxStopped?.(info.name);
        return null;
      }
      case "process.execute": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        const p = params as { command: string; cwd?: string; env?: Record<string, string>; timeoutSeconds?: number };
        const result = await backend.exec(id, ["sh", "-c", str(params, "command")], {
          user: SANDBOX_USER,
          cwd: p.cwd ?? SANDBOX_WORKDIR,
          env: { HOME: SANDBOX_HOME, ...p.env },
          timeoutMs: (p.timeoutSeconds ?? 600) * 1000,
        });
        return { exitCode: result.timedOut ? 124 : result.exitCode, result: `${result.stdout}${result.stderr}` };
      }
      case "session.create": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        await this.sessions.create(id, plainId(params, "sessionId"));
        return null;
      }
      case "session.delete": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        await this.sessions.delete(id, plainId(params, "sessionId"));
        return null;
      }
      case "session.get": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        return this.sessions.get(id, plainId(params, "sessionId"));
      }
      case "session.list": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        return { sessions: await this.sessions.list(id) };
      }
      case "session.command": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        return this.sessions.command(id, plainId(params, "sessionId"), plainId(params, "commandId"));
      }
      case "session.execute": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        const p = params as { runAsync?: boolean; timeoutSeconds?: number };
        return this.sessions.execute(id, plainId(params, "sessionId"), str(params, "command"), p.runAsync === true, p.timeoutSeconds);
      }
      case "session.logs": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        return this.sessions.logs(id, plainId(params, "sessionId"), plainId(params, "commandId"));
      }
      case "session.input": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        const data = isRecord(params) && typeof params.data === "string" ? params.data : "";
        await this.sessions.input(id, plainId(params, "sessionId"), plainId(params, "commandId"), data);
        return null;
      }
      case "fs.details": {
        const id = str(params, "sandboxId");
        await this.owned(id);
        const result = await backend.exec(id, ["stat", "-c", "%s", str(params, "path")], { user: SANDBOX_USER });
        if (result.exitCode !== 0) throw new RpcError("not_found", result.stderr.trim() || "file not found");
        return { size: Number.parseInt(result.stdout.trim(), 10) };
      }
      case "pty.resize": {
        const p = params as { streamId?: number; cols?: number; rows?: number };
        const open = typeof p.streamId === "number" ? this.terminals.get(p.streamId) : undefined;
        if (!open) throw new RpcError("not_found", "no terminal on that stream");
        if (!Number.isInteger(p.cols) || !Number.isInteger(p.rows) || !p.cols || !p.rows) throw new RpcError("invalid_params", "cols and rows are required");
        open.terminal.resize(p.cols, p.rows);
        // The host pty's new size does not reach the container's pty through the
        // engine's exec, so set it on the shell's tty from inside as well.
        await backend.exec(open.sandboxId, ["sh", "-c", 'pts=$(cat "$1") && stty -F "$pts" cols "$2" rows "$3"', "sh", open.ttyFile, String(p.cols), String(p.rows)], { user: SANDBOX_USER });
        return null;
      }
      default:
        throw new RpcError("unsupported", `unknown method ${method}`);
    }
  }

  private async create(params: LocalSandboxCreateParams): Promise<LocalSandboxInfo> {
    if (!isRecord(params) || !isRecord(params.image) || typeof params.image.ref !== "string" || typeof params.image.digest !== "string") {
      throw new RpcError("invalid_params", "image.ref and image.digest are required");
    }
    const backend = this.options.backend;
    const present = await backend.imageDigest(params.image.ref);
    if (present !== params.image.digest) {
      throw new RpcError("refused", `image ${params.image.ref} is not at digest ${params.image.digest} on this machine`);
    }
    const max = this.options.maxSandboxes;
    if (max !== undefined) {
      const running = (await this.listOwned()).filter((container) => container.state === "running").length;
      if (running >= max) throw new RpcError("refused", `this machine is at its limit of ${max} running sandbox${max === 1 ? "" : "es"}`);
    }
    const logins = await this.options.loginMounts(params.logins ?? []);
    const name = `useagent-${crypto.randomUUID().slice(0, 8)}`;
    await backend.create({
      name,
      image: backend.pinnedImage(params.image.ref, params.image.digest),
      env: { ...params.env, ...logins.env, HOME: SANDBOX_HOME },
      labels: {
        ...params.labels,
        [RUNNER_LABEL]: this.options.runnerId,
        [AUTOSTOP_LABEL]: String(params.autoStopMinutes ?? 0),
        "useagent.cpu": String(params.cpu),
        "useagent.memory-mb": String(params.memoryMb),
      },
      cpu: params.cpu,
      memoryMb: params.memoryMb,
      mounts: logins.mounts,
    });
    // Nothing half-made stays behind: a failure past this point removes the container.
    try {
      await backend.start(name);
      // The workspace exists before the plane's readiness probe looks for it.
      const workspace = await backend.exec(name, ["sh", "-c", `mkdir -p ${SANDBOX_WORKDIR}`], { user: SANDBOX_USER, env: { HOME: SANDBOX_HOME } });
      if (workspace.exitCode !== 0) throw new RpcError("internal", `workspace setup failed: ${workspace.stderr.trim() || `exit ${workspace.exitCode}`}`);
      const info = await backend.inspect(name);
      if (!info) throw new RpcError("internal", "container vanished after create");
      // An engine that boots a tag rather than a digest is checked on what actually booted.
      if (!backend.pinsByDigest && info.imageDigest !== params.image.digest) {
        throw new RpcError("refused", `sandbox ${name} booted ${info.imageDigest || "an unknown image"}, not ${params.image.digest}`);
      }
      this.lastActivity.set(name, this.now());
      return infoOf(info);
    } catch (error) {
      await backend.remove(name).catch(() => {});
      throw error;
    }
  }

  async stream(target: unknown, stream: MuxStream): Promise<void> {
    if (!isRecord(target) || typeof target.kind !== "string") throw new StreamRefusedError("invalid_params", "target.kind is required");
    const t = target as StreamTarget;
    const id = str(t, "sandboxId");
    const info = await this.owned(id).catch((error: RpcError) => {
      throw new StreamRefusedError(error.code, error.message);
    });
    if (info.state !== "running") throw new StreamRefusedError("refused", `sandbox ${id} is not running`);
    const backend = this.options.backend;
    this.openStreams.set(id, (this.openStreams.get(id) ?? 0) + 1);
    void stream.done.then(
      () => {},
      () => {},
    ).then(() => {
      this.openStreams.set(id, Math.max(0, (this.openStreams.get(id) ?? 1) - 1));
      this.lastActivity.set(id, this.now());
    });
    switch (t.kind) {
      case "port": {
        if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65_535) throw new StreamRefusedError("invalid_params", "port out of range");
        const connection = await backend.dial(id, t.port).catch((error: unknown) => {
          throw new StreamRefusedError("refused", error instanceof Error ? error.message : String(error));
        });
        void pipeToStream(connection.readable, stream).catch(() => stream.reset("upstream closed"));
        void this.pump(stream, connection.write, connection.end).catch(() => connection.close());
        void stream.done.catch(() => connection.close());
        return;
      }
      case "pty": {
        const terminal = new Bun.Terminal({
          cols: t.cols || 100,
          rows: t.rows || 30,
          data: (_terminal, data) => {
            void stream.write(data).catch(() => {});
          },
        });
        // The shell first records its tty so pty.resize can reach it from inside the container.
        const ttyFile = `/tmp/useagent/ptys/${crypto.randomUUID()}`;
        const proc = backend.spawnTerminal(id, ["sh", "-c", 'mkdir -p "$(dirname "$1")" && tty > "$1"; exec bash -l', "sh", ttyFile], terminal, {
          user: SANDBOX_USER,
          cwd: t.cwd ?? SANDBOX_WORKDIR,
          env: { HOME: SANDBOX_HOME, TERM: "xterm-256color" },
        });
        this.terminals.set(stream.id, { terminal, sandboxId: id, ttyFile });
        void this.pump(stream, async (bytes) => {
          terminal.write(bytes);
        }, () => proc.kill()).catch(() => proc.kill());
        void proc.exited.then(() => {
          this.terminals.delete(stream.id);
          terminal.close();
          stream.end();
        });
        void stream.done.catch(() => proc.kill()).finally(() => {
          this.terminals.delete(stream.id);
        });
        return;
      }
      case "file.read": {
        const handle = backend.spawn(id, ["cat", str(t, "path")], { user: SANDBOX_USER });
        handle.endStdin();
        const piped = pipeToStream(handle.stdout, stream, { end: false }).catch((error: unknown) => stream.reset(`read failed: ${error instanceof Error ? error.message : String(error)}`));
        void handle.exited.then(async (code) => {
          await piped;
          if (code === 0) stream.end();
          else stream.reset(`read failed: ${(await new Response(handle.stderr).text()).trim() || `exit ${code}`}`);
        });
        void stream.done.catch(() => handle.kill());
        return;
      }
      case "file.write": {
        const path = str(t, "path");
        const handle = backend.spawn(id, ["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], { user: SANDBOX_USER });
        void this.pump(stream, handle.writeStdin, handle.endStdin).catch(() => handle.kill());
        void handle.exited.then(async (code) => {
          if (code === 0) stream.end();
          else stream.reset(`write failed: ${(await new Response(handle.stderr).text()).trim() || `exit ${code}`}`);
        });
        void stream.done.catch(() => handle.kill());
        return;
      }
      case "logs.follow": {
        const ids = (() => {
          try {
            return [plainId(t, "sessionId"), plainId(t, "commandId")] as const;
          } catch (error) {
            throw new StreamRefusedError("invalid_params", error instanceof Error ? error.message : String(error));
          }
        })();
        const handle = backend.spawn(id, this.sessions.followArgv(ids[0], ids[1]), { user: SANDBOX_USER });
        handle.endStdin();
        const piped = pipeToStream(handle.stdout, stream, { end: false }).catch((error: unknown) => stream.reset(`follow failed: ${error instanceof Error ? error.message : String(error)}`));
        void handle.exited.then(async (code) => {
          await piped;
          if (code === 3) stream.reset("command not found");
          else stream.end();
        });
        void stream.done.catch(() => handle.kill());
        return;
      }
      default:
        throw new StreamRefusedError("unsupported", `unknown stream kind ${String((t as { kind: string }).kind)}`);
    }
  }

  /** Bytes from the plane into a sink, then the sink's end when the plane half-closes. */
  private async pump(stream: MuxStream, write: (bytes: Uint8Array) => Promise<void> | void, end: () => void): Promise<void> {
    try {
      for await (const chunk of stream.readable) await write(chunk);
    } finally {
      end();
    }
  }

  /** Stop containers idle past their auto-stop interval; called on a timer. */
  async stopIdle(): Promise<string[]> {
    const stopped: string[] = [];
    for (const container of await this.listOwned()) {
      if (container.state !== "running") continue;
      const minutes = Number(container.labels[AUTOSTOP_LABEL] ?? 0);
      if (!(minutes > 0)) continue;
      if ((this.openStreams.get(container.name) ?? 0) > 0) continue;
      const last = this.lastActivity.get(container.name) ?? this.now();
      if (!this.lastActivity.has(container.name)) this.lastActivity.set(container.name, last);
      if (this.now() - last < minutes * 60_000) continue;
      await this.options.backend.stop(container.name).catch(() => {});
      await this.options.onSandboxStopped?.(container.name);
      stopped.push(container.name);
    }
    return stopped;
  }

  /** Remove every container this runner made (uninstall, or a runner retired by the plane). */
  async removeAll(): Promise<number> {
    let removed = 0;
    for (const container of await this.listOwned()) {
      await this.options.backend.remove(container.name).catch(() => {});
      removed += 1;
    }
    return removed;
  }
}
