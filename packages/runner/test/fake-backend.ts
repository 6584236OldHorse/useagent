// An in-memory LocalBackend for service tests: containers are records, exec
// answers from a script table, dial and spawn hand back in-memory pipes.

import type {
  ContainerInfo,
  ContainerSpec,
  DialedConnection,
  ExecHandle,
  ExecOptions,
  ExecResult,
  LocalBackend,
  TerminalProcess,
} from "../src/backends/types";
import { BackendError, type RegistryLogin } from "../src/backends/types";

export interface FakeContainer {
  readonly spec: ContainerSpec;
  state: "created" | "running" | "stopped";
}

export interface Pipe {
  readonly readable: ReadableStream<Uint8Array>;
  write(bytes: Uint8Array): void;
  end(): void;
}

export function pipe(): Pipe {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    readable,
    write(bytes) {
      if (!ended) controller.enqueue(bytes);
    },
    end() {
      if (ended) return;
      ended = true;
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export class FakeBackend implements LocalBackend {
  readonly kind = "docker" as const;
  pinsByDigest = true;
  /** What inspect reports as the booted image's digest when set (an engine that boots a tag). */
  bootDigest: string | null = null;
  readonly containers = new Map<string, FakeContainer>();
  readonly calls: string[] = [];
  images = new Map<string, string>();
  /** exec answers by the first argv element that matches. */
  execScript: (id: string, argv: readonly string[], options?: ExecOptions) => ExecResult = () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  dialScript: (id: string, port: number) => DialedConnection = () => {
    throw new BackendError("unavailable", "no dial script");
  };
  spawnScript: (id: string, argv: readonly string[]) => ExecHandle = () => {
    throw new BackendError("unavailable", "no spawn script");
  };

  async available() {
    return null;
  }
  async pullImage(ref: string, _onProgress?: (line: string) => void, login?: RegistryLogin) {
    if (this.pullFails) throw new Error(this.pullFails);
    this.calls.push(`pull ${ref}${login ? ` as ${login.username}@${login.registry}` : ""}`);
    if (login) this.passwords.push(login.password);
    const digest = this.pullYields.get(ref);
    if (digest) this.images.set(ref, digest);
  }
  pullFails: string | null = null;
  /** What a pull of each reference leaves on disk. */
  readonly pullYields = new Map<string, string>();
  /** Passwords presented with pulls, kept out of `calls` so a test can check nothing leaks. */
  readonly passwords: string[] = [];
  async imageDigest(ref: string) {
    return this.images.get(ref) ?? null;
  }
  async removeImage(ref: string) {
    this.images.delete(ref);
  }
  pinnedImage(ref: string, digest: string) {
    return `${ref}@${digest}`;
  }
  async create(spec: ContainerSpec) {
    this.calls.push(`create ${spec.name}`);
    this.containers.set(spec.name, { spec, state: "created" });
    return spec.name;
  }
  async start(id: string) {
    const c = this.require(id);
    c.state = "running";
    this.calls.push(`start ${id}`);
  }
  async stop(id: string) {
    const c = this.require(id);
    c.state = "stopped";
    this.calls.push(`stop ${id}`);
  }
  async remove(id: string) {
    this.containers.delete(id);
    this.calls.push(`remove ${id}`);
  }
  async inspect(id: string): Promise<ContainerInfo | null> {
    const c = this.containers.get(id);
    return c ? this.info(c) : null;
  }
  async list(labels: Readonly<Record<string, string>>) {
    return [...this.containers.values()]
      .map((c) => this.info(c))
      .filter((info) => Object.entries(labels).every(([k, v]) => info.labels[k] === v));
  }
  async exec(id: string, argv: readonly string[], options?: ExecOptions) {
    this.require(id);
    this.calls.push(`exec ${id} ${argv.join(" ")}`);
    return this.execScript(id, argv, options);
  }
  spawn(id: string, argv: readonly string[]) {
    return this.spawnScript(id, argv);
  }
  spawnTerminal(): TerminalProcess {
    return { exited: new Promise(() => {}), kill() {} };
  }
  async dial(id: string, port: number) {
    this.require(id);
    return this.dialScript(id, port);
  }

  seed(name: string, labels: Record<string, string>, state: FakeContainer["state"] = "running") {
    this.containers.set(name, {
      spec: { name, image: "img@sha256:0", env: {}, labels, cpu: 1, memoryMb: 512, mounts: [] },
      state,
    });
  }

  private require(id: string): FakeContainer {
    const c = this.containers.get(id);
    if (!c) throw new BackendError("not_found", `no container ${id}`);
    return c;
  }

  private info(c: FakeContainer): ContainerInfo {
    return {
      id: c.spec.name,
      name: c.spec.name,
      state: c.state,
      labels: c.spec.labels,
      createdAt: "2026-09-08T00:00:00Z",
      imageDigest: this.bootDigest ?? c.spec.image,
      ip: "10.0.0.2",
    };
  }
}

/** An ExecHandle over in-memory pipes: `stdin` collects what the service writes, `out` feeds its stdout. */
export function fakeHandle(exitCode = 0): ExecHandle & { stdin: Pipe; out: Pipe; finish(code?: number): void } {
  const stdin = pipe();
  const stdout = pipe();
  const stderr = pipe();
  const { promise: exited, resolve } = Promise.withResolvers<number>();
  return {
    stdin,
    out: stdout,
    stdout: stdout.readable,
    stderr: stderr.readable,
    async writeStdin(bytes: Uint8Array) {
      stdin.write(bytes);
    },
    endStdin() {
      stdin.end();
    },
    exited,
    kill() {
      resolve(137);
    },
    finish(code = exitCode) {
      stdout.end();
      stderr.end();
      resolve(code);
    },
  };
}
