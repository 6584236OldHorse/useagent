// What the runner needs from a container engine on the machine. Docker and
// Apple containers implement it through their command line tools; the service
// layer (sessions, PTYs, files, port dials) is written once against this.

import type { LocalSandboxState, RunnerBackendKind } from "@useagent/runner-protocol";

export interface ContainerMount {
  readonly hostPath: string;
  readonly containerPath: string;
  readonly readonly: boolean;
}

export interface ContainerSpec {
  readonly name: string;
  /** Image reference pinned by digest, e.g. ghcr.io/x/y@sha256:... */
  readonly image: string;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly cpu: number;
  readonly memoryMb: number;
  readonly mounts: readonly ContainerMount[];
}

export interface ContainerInfo {
  readonly id: string;
  readonly name: string;
  readonly state: LocalSandboxState;
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly imageDigest: string;
  /** Address reachable from the host, when the engine gives each container one. */
  readonly ip: string | null;
}

export interface ExecOptions {
  readonly user?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Bytes for the process's stdin; the pipe closes after them. */
  readonly stdin?: Uint8Array;
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** A running process with piped stdio, for streams that outlive one call. */
export interface ExecHandle {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  writeStdin(bytes: Uint8Array): Promise<void>;
  endStdin(): void;
  readonly exited: Promise<number>;
  kill(): void;
}

/** A byte pipe to a TCP port inside a container. */
export interface DialedConnection {
  readonly readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
  end(): void;
  close(): void;
  readonly closed: Promise<void>;
}

export interface TerminalProcess {
  readonly exited: Promise<number>;
  kill(): void;
}

export interface RegistryLogin {
  readonly registry: string;
  readonly username: string;
  readonly password: string;
}

export interface LocalBackend {
  readonly kind: RunnerBackendKind;
  /** Whether `pinnedImage` names the digest itself; otherwise the service checks the digest after boot. */
  readonly pinsByDigest: boolean;
  /** Null when the engine is usable, else why not. */
  available(): Promise<string | null>;
  /** Pull `ref`; with a login, the engine authenticates to that registry for this pull only. */
  pullImage(ref: string, onProgress?: (line: string) => void, login?: RegistryLogin): Promise<void>;
  /** The digest of a local image reference, or null when it is not present. */
  imageDigest(ref: string): Promise<string | null>;
  removeImage(ref: string): Promise<void>;
  /** The reference to create from once `ref` is present at `digest`. */
  pinnedImage(ref: string, digest: string): string;
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  inspect(id: string): Promise<ContainerInfo | null>;
  list(labels: Readonly<Record<string, string>>): Promise<ContainerInfo[]>;
  exec(id: string, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  /** Long-lived process with piped stdio (file transfer, log follow, port dials). */
  spawn(id: string, argv: readonly string[], options?: Omit<ExecOptions, "stdin" | "timeoutMs">): ExecHandle;
  /** Interactive process attached to a host pseudo-terminal. */
  spawnTerminal(id: string, argv: readonly string[], terminal: Bun.Terminal, options?: Omit<ExecOptions, "stdin" | "timeoutMs">): TerminalProcess;
  dial(id: string, port: number): Promise<DialedConnection>;
}

export class BackendError extends Error {
  constructor(
    readonly code: "not_found" | "unavailable" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}
