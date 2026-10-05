// Apple containers through the `container` command line (macOS 26, Apple
// silicon). Every container is its own lightweight VM with its own address,
// so a port dial is a plain TCP connection from the host.

import type { LocalSandboxState } from "@useagent/runner-protocol";
import { type CliFlags, cliExec, cliSpawn, cliSpawnTerminal, runCli } from "./cli-backend";
import {
  BackendError,
  type ContainerInfo,
  type ContainerSpec,
  type DialedConnection,
  type ExecOptions,
  type LocalBackend,
} from "./types";

const flags: CliFlags = {
  tool: "container",
  execUser: (user) => ["-u", user],
  execCwd: (cwd) => ["-w", cwd],
  execEnv: (key, value) => ["-e", `${key}=${value}`],
};

interface AppleContainer {
  readonly configuration?: {
    readonly id?: string;
    readonly labels?: Record<string, string>;
    readonly image?: { readonly reference?: string; readonly descriptor?: { readonly digest?: string } };
  };
  readonly status?: {
    readonly state?: string;
    readonly startedDate?: string;
    readonly networks?: ReadonlyArray<{ readonly ipv4Address?: string }>;
  };
}

function stateOf(state: string | undefined): LocalSandboxState {
  if (state === "running") return "running";
  if (state === "stopping" || state === "stopped") return "stopped";
  return "created";
}

function infoFromInspect(container: AppleContainer): ContainerInfo {
  const id = container.configuration?.id ?? "";
  const address = container.status?.networks?.[0]?.ipv4Address ?? null;
  return {
    id,
    name: id,
    state: stateOf(container.status?.state),
    labels: container.configuration?.labels ?? {},
    createdAt: container.status?.startedDate ?? "",
    imageDigest: container.configuration?.image?.descriptor?.digest ?? container.configuration?.image?.reference ?? "",
    // "192.168.64.3/24" -> "192.168.64.3"
    ip: address ? address.split("/")[0] ?? null : null,
  };
}

export class AppleContainerBackend implements LocalBackend {
  readonly kind = "apple" as const;

  async available(): Promise<string | null> {
    if (process.platform !== "darwin" || process.arch !== "arm64") return "Apple containers need macOS on Apple silicon";
    const version = await runCli(["container", "--version"], { timeoutMs: 10_000 });
    if (version.exitCode !== 0) return "the container command line tool is not installed";
    const status = await runCli(["container", "system", "status"], { timeoutMs: 10_000 });
    if (status.exitCode !== 0 || /not running/i.test(status.stdout + status.stderr)) {
      const started = await runCli(["container", "system", "start"], { timeoutMs: 60_000 });
      if (started.exitCode !== 0) return `container system start failed: ${started.stderr.trim()}`;
    }
    return null;
  }

  async pullImage(ref: string, onProgress?: (line: string) => void): Promise<void> {
    const proc = Bun.spawn(["container", "image", "pull", ref], { stdout: "pipe", stderr: "pipe" });
    const relay = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        for (const line of decoder.decode(chunk, { stream: true }).split(/\r?\n/)) {
          if (line.trim()) onProgress?.(line.trim());
        }
      }
    };
    await Promise.all([relay(proc.stdout), relay(proc.stderr)]);
    if ((await proc.exited) !== 0) throw new BackendError("internal", `container image pull ${ref} failed`);
  }

  async imageDigest(ref: string): Promise<string | null> {
    const result = await runCli(["container", "image", "inspect", ref]);
    if (result.exitCode !== 0) return null;
    const match = /"digest"\s*:\s*"(sha256:[0-9a-f]{64})"/.exec(result.stdout) ?? /(sha256:[0-9a-f]{64})/.exec(result.stdout);
    return match?.[1] ?? null;
  }

  async removeImage(ref: string): Promise<void> {
    await runCli(["container", "image", "rm", ref]);
  }

  /** The tag as pulled; the digest was verified right before create. */
  pinnedImage(ref: string, _digest: string): string {
    return ref;
  }

  async create(spec: ContainerSpec): Promise<string> {
    const argv = ["container", "run", "-d", "--name", spec.name, "-c", String(spec.cpu), "-m", `${spec.memoryMb}M`];
    for (const [key, value] of Object.entries(spec.labels)) argv.push("-l", `${key}=${value}`);
    for (const [key, value] of Object.entries(spec.env)) argv.push("-e", `${key}=${value}`);
    for (const mount of spec.mounts) {
      argv.push("--mount", `type=bind,source=${mount.hostPath},target=${mount.containerPath}${mount.readonly ? ",readonly" : ""}`);
    }
    argv.push(spec.image, "sleep", "infinity");
    const result = await runCli(argv, { timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw new BackendError("internal", `container run failed: ${result.stderr.trim()}`);
    return spec.name;
  }

  async start(id: string): Promise<void> {
    const result = await runCli(["container", "start", id], { timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw this.failure(result.stderr, "container start");
  }

  async stop(id: string): Promise<void> {
    const result = await runCli(["container", "stop", "-t", "5", id], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw this.failure(result.stderr, "container stop");
  }

  /** Force covers a running container; a graceful stop first would wait out the full grace period. */
  async remove(id: string): Promise<void> {
    const result = await runCli(["container", "delete", "--force", id], { timeoutMs: 60_000 });
    if (result.exitCode !== 0 && !/not found|does not exist/i.test(result.stderr)) throw this.failure(result.stderr, "container delete");
  }

  async inspect(id: string): Promise<ContainerInfo | null> {
    const result = await runCli(["container", "inspect", id]);
    if (result.exitCode !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout) as AppleContainer[] | AppleContainer;
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      return first ? infoFromInspect(first) : null;
    } catch {
      return null;
    }
  }

  async list(labels: Readonly<Record<string, string>>): Promise<ContainerInfo[]> {
    const result = await runCli(["container", "list", "--all", "--format", "json"]);
    if (result.exitCode !== 0) return [];
    let parsed: AppleContainer[];
    try {
      parsed = JSON.parse(result.stdout) as AppleContainer[];
    } catch {
      return [];
    }
    return parsed
      .map(infoFromInspect)
      .filter((info) => Object.entries(labels).every(([key, value]) => info.labels[key] === value));
  }

  exec(id: string, argv: readonly string[], options?: ExecOptions) {
    return cliExec(flags, id, argv, options);
  }

  spawn(id: string, argv: readonly string[], options?: Omit<ExecOptions, "stdin" | "timeoutMs">) {
    return cliSpawn(flags, id, argv, options);
  }

  spawnTerminal(id: string, argv: readonly string[], terminal: Bun.Terminal, options?: Omit<ExecOptions, "stdin" | "timeoutMs">) {
    return cliSpawnTerminal(flags, id, argv, terminal, options);
  }

  async dial(id: string, port: number): Promise<DialedConnection> {
    const info = await this.inspect(id);
    if (!info) throw new BackendError("not_found", `container ${id} not found`);
    if (!info.ip) throw new BackendError("unavailable", `container ${id} has no address`);
    return connectTcp(info.ip, port);
  }

  private failure(stderr: string, what: string): BackendError {
    return /not found|does not exist/i.test(stderr)
      ? new BackendError("not_found", stderr.trim())
      : new BackendError("internal", `${what} failed: ${stderr.trim()}`);
  }
}

/** A TCP connection as a DialedConnection (also used by tests against any host). */
export async function connectTcp(hostname: string, port: number): Promise<DialedConnection> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
  let ended = false;
  const socket = await Bun.connect({
    hostname,
    port,
    socket: {
      data(_socket, data) {
        try {
          controller.enqueue(new Uint8Array(data));
        } catch {
          /* consumer gone */
        }
      },
      close() {
        if (!ended) {
          ended = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
        resolveClosed();
      },
      error(_socket, error) {
        ended = true;
        try {
          controller.error(error);
        } catch {
          /* already closed */
        }
        resolveClosed();
      },
    },
  });
  return {
    readable,
    async write(bytes) {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = socket.write(bytes.subarray(offset));
        if (written <= 0) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          continue;
        }
        offset += written;
      }
    },
    end() {
      socket.shutdown();
    },
    close() {
      socket.end();
    },
    closed,
  };
}
