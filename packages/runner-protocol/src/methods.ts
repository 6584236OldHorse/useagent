// What travels over the link, above the frames: the RPC methods the control
// plane calls on a runner and the byte-stream targets it opens. Both sides
// import these so a method's params and result have exactly one definition.
// Adding a method or a target is additive (see ./version.ts).

export type LocalSandboxState = "created" | "running" | "stopped" | "deleted";

export interface LocalSandboxInfo {
  /** The container id as the runner's backend names it. */
  readonly id: string;
  readonly state: LocalSandboxState;
  readonly labels: Readonly<Record<string, string>>;
  readonly cpu: number;
  readonly memoryMb: number;
  readonly imageDigest: string;
  readonly createdAt: string;
}

export interface LocalSandboxCreateParams {
  readonly image: { readonly ref: string; readonly digest: string };
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly cpu: number;
  readonly memoryMb: number;
  /** Engine CLIs whose login on the machine the sandbox may use, e.g. ["codex"]. */
  readonly logins: readonly string[];
  /** Minutes of idleness before the runner stops the sandbox; 0 keeps it running. */
  readonly autoStopMinutes: number;
}

export interface LocalExecuteParams {
  readonly sandboxId: string;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
}

export interface LocalExecuteResult {
  readonly exitCode?: number;
  readonly result: string;
}

export interface LocalSessionCommand {
  readonly id: string;
  readonly exitCode?: number;
}

export interface LocalSessionExecuteParams {
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly command: string;
  readonly runAsync?: boolean;
  readonly timeoutSeconds?: number;
}

export interface LocalSessionExecuteResult {
  readonly cmdId: string;
  readonly output?: string;
  readonly exitCode?: number;
}

/** Every RPC the control plane may call, with its params and result. */
export interface RunnerRpcCatalog {
  "sandbox.create": { params: LocalSandboxCreateParams; result: LocalSandboxInfo };
  "sandbox.get": { params: { sandboxId: string }; result: LocalSandboxInfo };
  "sandbox.list": { params: Record<never, never>; result: readonly LocalSandboxInfo[] };
  "sandbox.start": { params: { sandboxId: string }; result: LocalSandboxInfo };
  "sandbox.delete": { params: { sandboxId: string }; result: null };
  "process.execute": { params: LocalExecuteParams; result: LocalExecuteResult };
  "session.create": { params: { sandboxId: string; sessionId: string }; result: null };
  "session.delete": { params: { sandboxId: string; sessionId: string }; result: null };
  "session.get": { params: { sandboxId: string; sessionId: string }; result: { commands: readonly LocalSessionCommand[] } };
  "session.command": { params: { sandboxId: string; sessionId: string; commandId: string }; result: LocalSessionCommand };
  "session.execute": { params: LocalSessionExecuteParams; result: LocalSessionExecuteResult };
  "session.logs": { params: { sandboxId: string; sessionId: string; commandId: string }; result: { output: string } };
  /** Bytes for a detached command's stdin (Pi's RPC transport writes JSON lines this way). */
  "session.input": { params: { sandboxId: string; sessionId: string; commandId: string; data: string }; result: null };
  "session.list": { params: { sandboxId: string }; result: { sessions: readonly string[] } };
  "fs.details": { params: { sandboxId: string; path: string }; result: { size?: number } };
  "pty.resize": { params: { streamId: number; cols: number; rows: number }; result: null };
}

export type RunnerRpcMethod = keyof RunnerRpcCatalog;
export type RunnerRpcParams<M extends RunnerRpcMethod> = RunnerRpcCatalog[M]["params"];
export type RunnerRpcResult<M extends RunnerRpcMethod> = RunnerRpcCatalog[M]["result"];

/** Byte streams the control plane opens into a sandbox on the runner. */
export type StreamTarget =
  /** A TCP connection to a port inside the sandbox. */
  | { readonly kind: "port"; readonly sandboxId: string; readonly port: number }
  /** An interactive shell on a pseudo-terminal; `pty.resize` takes the stream id. */
  | { readonly kind: "pty"; readonly sandboxId: string; readonly cols: number; readonly rows: number; readonly cwd?: string }
  /** The file's bytes, runner to plane, then half-close. */
  | { readonly kind: "file.read"; readonly sandboxId: string; readonly path: string }
  /** The file's bytes, plane to runner; the runner half-closes when it has written them. */
  | { readonly kind: "file.write"; readonly sandboxId: string; readonly path: string }
  /** Live output of a session command, runner to plane, until the command exits. */
  | { readonly kind: "logs.follow"; readonly sandboxId: string; readonly sessionId: string; readonly commandId: string };

/** Error codes a runner answers with; the plane maps them to its own errors. */
export type RunnerRpcErrorCode =
  | "not_found"
  | "invalid_params"
  | "unsupported"
  | "refused"
  | "timeout"
  | "internal"
  /** A create named an image this machine does not hold and could not make present in time (the pull failed or is still downloading). */
  | "image_missing"
  /** A create named a missing image whose pull produced no output at all within the wait (on a Mac, usually the one-time keychain prompt). */
  | "image_pull_stalled";

const LOCAL_ID_PREFIX = "local:";

/** `local:<runnerId>:<containerId>`, the sandbox id the control plane records for a runner's sandbox. */
export function composeLocalSandboxId(runnerId: string, containerId: string): string {
  if (!runnerId || runnerId.includes(":")) throw new Error("runner id must be non-empty and contain no ':'");
  if (!containerId) throw new Error("container id must be non-empty");
  return `${LOCAL_ID_PREFIX}${runnerId}:${containerId}`;
}

export function parseLocalSandboxId(sandboxId: string): { runnerId: string; containerId: string } | null {
  if (!sandboxId.startsWith(LOCAL_ID_PREFIX)) return null;
  const rest = sandboxId.slice(LOCAL_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { runnerId: rest.slice(0, separator), containerId: rest.slice(separator + 1) };
}
