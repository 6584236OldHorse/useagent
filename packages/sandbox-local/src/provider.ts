// A developer's own machine as a sandbox provider. The control plane never
// reaches the machine; the machine's runner holds one outbound link, and this
// provider is an RPC client over it. Every SandboxProvider method maps to one
// call or one byte stream in @useagent/runner-protocol.

import { createHash } from "node:crypto";
import {
  type LocalSandboxCreateParams,
  type LocalSandboxInfo,
  type LocalSessionCommand,
  type LocalSessionExecuteResult,
  type RunnerRpcMethod,
  type RunnerRpcParams,
  type RunnerRpcResult,
  type StreamTarget,
  composeLocalSandboxId,
  parseLocalSandboxId,
} from "@useagent/runner-protocol";
import {
  type SandboxCreateOptions,
  type SandboxFileSystem,
  type SandboxHandle,
  type SandboxLabelStore,
  type SandboxLink,
  type SandboxLinkDirectory,
  type SandboxLinkStream,
  SandboxNotFoundError,
  type SandboxPreviewLink,
  type SandboxProcess,
  type SandboxProvider,
  type SandboxProviderPorts,
  type SandboxPtyHandle,
  type SandboxSession,
} from "@useagent/sandbox-contract";

export const LOCAL_HOME = "/home/user";
export const LOCAL_WORKDIR = "/home/user/work";

export interface LocalImage {
  readonly ref: string;
  readonly digest: string;
}

export interface LocalProviderConfig {
  /** The native image every local sandbox boots; null until the deployment names one. */
  readonly image: LocalImage | null;
  /** The runner new sandboxes are created on; null for a provider that only resolves ids. */
  readonly runnerId: string | null;
  /** Logins on the machine the sandbox may borrow (already filtered by policy). */
  readonly logins: readonly string[];
  readonly cpu: number;
  readonly memoryGib: number;
}

export class RunnerOfflineError extends Error {
  constructor(runnerId: string) {
    super(`the machine behind runner ${runnerId} is not connected`);
    this.name = "RunnerOfflineError";
  }
}

/** The machine could not make the deployment's sandbox image present for a create; the message leads with what the person should do. */
export class SandboxImageUnavailableError extends Error {
  constructor(
    readonly code: "image_missing" | "image_pull_stalled",
    detail: string,
  ) {
    super(code === "image_pull_stalled" ? `Check the desktop app on the machine: ${detail}` : `Update the desktop app to get the new sandbox image: ${detail}`);
    this.name = "SandboxImageUnavailableError";
  }
}

function rpcCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

/** Extra wait beyond a command's own timeout, for the runner to collect output and answer. */
const ANSWER_GRACE_MS = 5000;
const DEFAULT_COMMAND_SECONDS = 600;
const CREATE_TIMEOUT_MS = 600_000;
const START_TIMEOUT_MS = 180_000;
const DELETE_TIMEOUT_MS = 120_000;

async function call<M extends RunnerRpcMethod>(
  link: SandboxLink,
  method: M,
  params: RunnerRpcParams<M>,
  timeoutMs?: number,
): Promise<RunnerRpcResult<M>> {
  return (await link.call(method, params, timeoutMs === undefined ? undefined : { timeoutMs })) as RunnerRpcResult<M>;
}

function commandTimeoutMs(timeoutSeconds: number | undefined): number {
  return (timeoutSeconds ?? DEFAULT_COMMAND_SECONDS) * 1000 + ANSWER_GRACE_MS;
}

async function readAll(stream: SandboxLinkStream): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream.readable) parts.push(chunk);
  return Buffer.concat(parts);
}

function ptyHandle(stream: SandboxLinkStream, link: SandboxLink, onData: (data: Uint8Array) => void | Promise<void>): SandboxPtyHandle {
  const termination = stream.done.then(
    () => ({}),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  );
  void (async () => {
    try {
      for await (const chunk of stream.readable) await onData(chunk);
    } catch {
      /* the stream's done carries the reason */
    }
  })();
  const encoder = new TextEncoder();
  return {
    async waitForConnection() {},
    waitForTermination: () => termination,
    async sendInput(data) {
      await stream.write(typeof data === "string" ? encoder.encode(data) : data);
    },
    resize(cols, rows) {
      return call(link, "pty.resize", { streamId: stream.id, cols, rows });
    },
    async disconnect() {
      stream.end();
    },
    async kill() {
      stream.reset("killed");
    },
  };
}

class LocalProcess implements SandboxProcess {
  constructor(
    private readonly link: SandboxLink,
    private readonly containerId: string,
  ) {}

  async executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeoutSeconds?: number) {
    const result = await call(
      this.link,
      "process.execute",
      { sandboxId: this.containerId, command, cwd, env, timeoutSeconds },
      commandTimeoutMs(timeoutSeconds),
    );
    return { result: result.result, exitCode: result.exitCode };
  }

  createSession(sessionId: string) {
    return call(this.link, "session.create", { sandboxId: this.containerId, sessionId });
  }

  deleteSession(sessionId: string) {
    return call(this.link, "session.delete", { sandboxId: this.containerId, sessionId });
  }

  async getSession(sessionId: string): Promise<SandboxSession> {
    const session = await call(this.link, "session.get", { sandboxId: this.containerId, sessionId });
    return { sessionId, commands: session.commands.map((c: LocalSessionCommand) => ({ id: c.id, ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}) })) };
  }

  async getSessionCommand(sessionId: string, commandId: string) {
    const command = await call(this.link, "session.command", { sandboxId: this.containerId, sessionId, commandId });
    return { id: command.id, ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}) };
  }

  async executeSessionCommand(
    sessionId: string,
    request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
    timeoutSeconds?: number,
  ) {
    const result: LocalSessionExecuteResult = await call(
      this.link,
      "session.execute",
      { sandboxId: this.containerId, sessionId, command: request.command, runAsync: request.runAsync, timeoutSeconds },
      request.runAsync ? undefined : commandTimeoutMs(timeoutSeconds),
    );
    return { cmdId: result.cmdId, output: result.output, stdout: result.output, stderr: "", exitCode: result.exitCode };
  }

  async getSessionCommandLogs(sessionId: string, commandId: string) {
    const logs = await call(this.link, "session.logs", { sandboxId: this.containerId, sessionId, commandId });
    return { output: logs.output, stdout: logs.output, stderr: "" };
  }

  async followSessionCommandLogs(sessionId: string, commandId: string, onStdout: (chunk: string) => void) {
    const stream = await this.link.openStream({ kind: "logs.follow", sandboxId: this.containerId, sessionId, commandId } satisfies StreamTarget);
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream.readable) onStdout(decoder.decode(chunk, { stream: true }));
    } finally {
      stream.end();
    }
    // A failure the runner reports after its last byte still fails the caller.
    await stream.done;
  }

  sendSessionCommandInput(sessionId: string, commandId: string, data: string) {
    return call(this.link, "session.input", { sandboxId: this.containerId, sessionId, commandId, data }).then(() => {});
  }

  async listSessions() {
    const { sessions } = await call(this.link, "session.list", { sandboxId: this.containerId });
    return sessions.map((sessionId) => ({ sessionId, commands: [] }));
  }

  async createPty(options: { id: string; cols: number; rows: number; cwd?: string; onData: (data: Uint8Array) => void | Promise<void> }) {
    const stream = await this.link.openStream({ kind: "pty", sandboxId: this.containerId, cols: options.cols, rows: options.rows, cwd: options.cwd } satisfies StreamTarget);
    return ptyHandle(stream, this.link, options.onData);
  }
}

class LocalFileSystem implements SandboxFileSystem {
  constructor(
    private readonly link: SandboxLink,
    private readonly containerId: string,
  ) {}

  getFileDetails(path: string) {
    return call(this.link, "fs.details", { sandboxId: this.containerId, path });
  }

  async downloadFile(path: string): Promise<Buffer> {
    const stream = await this.link.openStream({ kind: "file.read", sandboxId: this.containerId, path } satisfies StreamTarget);
    const bytes = await readAll(stream);
    stream.end();
    // The bytes count only once the stream settled; a reset after the last byte fails the download.
    await stream.done;
    return bytes;
  }

  async uploadFile(file: Buffer, remotePath: string): Promise<void> {
    const stream = await this.link.openStream({ kind: "file.write", sandboxId: this.containerId, path: remotePath } satisfies StreamTarget);
    await stream.write(new Uint8Array(file.buffer, file.byteOffset, file.byteLength));
    stream.end();
    // The runner half-closes once the bytes are on disk; a failure arrives as a reset.
    await stream.done;
  }
}

function stateOf(info: LocalSandboxInfo): string {
  return info.state === "running" ? "started" : "stopped";
}

class LocalHandle implements SandboxHandle {
  readonly id: string;
  readonly providerKind = "local" as const;
  readonly cpu: number;
  readonly memory: number;
  state: string;
  labels: Record<string, string>;
  readonly process: SandboxProcess;
  readonly fs: SandboxFileSystem;

  constructor(
    private readonly link: SandboxLink,
    private readonly containerId: string,
    info: LocalSandboxInfo,
    private readonly labelStore: SandboxLabelStore | undefined,
  ) {
    this.id = composeLocalSandboxId(link.id, containerId);
    this.cpu = info.cpu;
    this.memory = info.memoryMb / 1024;
    this.state = stateOf(info);
    this.labels = { ...info.labels };
    this.process = new LocalProcess(link, containerId);
    this.fs = new LocalFileSystem(link, containerId);
  }

  async start(): Promise<void> {
    const info = await call(this.link, "sandbox.start", { sandboxId: this.containerId }, START_TIMEOUT_MS);
    this.state = stateOf(info);
  }

  async delete(): Promise<void> {
    await call(this.link, "sandbox.delete", { sandboxId: this.containerId }, DELETE_TIMEOUT_MS);
    await this.link.release(this.containerId);
    await this.labelStore?.remove(this.id);
    this.state = "deleted";
  }

  async getPreviewLink(port: number): Promise<SandboxPreviewLink> {
    const address = await this.link.forward(this.containerId, port);
    return { url: `http://${address.host}:${address.port}`, token: "", headers: {} };
  }
}

export class LocalProvider implements SandboxProvider {
  readonly connectionFingerprint: string;

  constructor(
    private readonly config: LocalProviderConfig,
    private readonly ports: SandboxProviderPorts,
  ) {
    const link = config.runnerId ? (ports.links?.get(config.runnerId) ?? null) : null;
    this.connectionFingerprint = createHash("sha256")
      .update(JSON.stringify(["local", config.runnerId ?? "", link?.fingerprint ?? ""]))
      .digest("hex");
  }

  private get directory(): SandboxLinkDirectory {
    if (!this.ports.links) throw new Error("the local sandbox provider needs the control plane's link directory");
    return this.ports.links;
  }

  private onlineLink(runnerId: string): SandboxLink {
    const link = this.directory.get(runnerId);
    if (!link || !link.online) throw new RunnerOfflineError(runnerId);
    return link;
  }

  async create(options: SandboxCreateOptions = {}): Promise<SandboxHandle> {
    if (!this.config.runnerId) throw new Error("no runner selected for this run");
    if (!this.config.image) throw new Error("SANDBOX_IMAGE_REF and SANDBOX_IMAGE_DIGEST name no image for local sandboxes");
    const link = this.onlineLink(this.config.runnerId);
    // The name this machine pulled under (the plane's, when the plane served the
    // image) is the name it can find locally; the digest is the deployment's.
    const params: LocalSandboxCreateParams = {
      image: link.image?.digest === this.config.image.digest ? { ref: link.image.ref, digest: link.image.digest } : this.config.image,
      env: options.envVars ?? {},
      labels: options.labels ?? {},
      cpu: this.config.cpu,
      memoryMb: this.config.memoryGib * 1024,
      logins: this.config.logins,
      autoStopMinutes: options.autoStopInterval ?? 0,
    };
    let info: LocalSandboxInfo;
    try {
      info = await call(link, "sandbox.create", params, CREATE_TIMEOUT_MS);
    } catch (error) {
      const code = rpcCode(error);
      const message = error instanceof Error ? error.message : String(error);
      if (code === "image_missing" || code === "image_pull_stalled") throw new SandboxImageUnavailableError(code, message);
      // A runner from before on-demand pulls refuses a missing digest outright; the person's action is the same.
      if (code === "refused" && /is not at digest .* on this machine/.test(message)) throw new SandboxImageUnavailableError("image_missing", message);
      throw error;
    }
    const handle = new LocalHandle(link, info.id, info, this.ports.labels);
    if (options.labels) await this.ports.labels?.write(handle.id, options.labels);
    return handle;
  }

  async get(sandboxId: string): Promise<SandboxHandle> {
    const parsed = parseLocalSandboxId(sandboxId);
    if (!parsed) throw new SandboxNotFoundError(new Error(`${sandboxId} is not a local sandbox id`));
    const link = this.onlineLink(parsed.runnerId);
    let info: LocalSandboxInfo;
    try {
      info = await call(link, "sandbox.get", { sandboxId: parsed.containerId });
    } catch (error) {
      if (rpcCode(error) === "not_found") throw new SandboxNotFoundError(error);
      throw error;
    }
    const handle = new LocalHandle(link, parsed.containerId, info, this.ports.labels);
    const stored = (await this.ports.labels?.read([handle.id]))?.get(handle.id);
    if (stored) handle.labels = { ...handle.labels, ...stored };
    return handle;
  }

  /**
   * Inventory is only complete when every machine it covers answered: a
   * provider bound to one runner lists that runner and fails while it is away;
   * an unbound provider fails if any enrolled machine is away, so a caller that
   * treats absence as deletion never sees a partial list.
   */
  async *list(): AsyncIterable<SandboxHandle> {
    const links = this.config.runnerId ? [this.onlineLink(this.config.runnerId)] : this.directory.list();
    for (const link of links) {
      if (!link.online) throw new RunnerOfflineError(link.id);
      const infos = await call(link, "sandbox.list", {});
      for (const info of infos) yield new LocalHandle(link, info.id, info, this.ports.labels);
    }
  }
}
