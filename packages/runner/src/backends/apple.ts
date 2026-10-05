// Apple containers through the `container` command line (macOS 26, Apple
// silicon). Every container is its own lightweight VM; a port dial goes
// through socat inside it, like Docker, so a port bound to the container's
// loopback is reachable and the tag cannot be re-resolved between the digest
// check and the boot without the service noticing (the digest is checked on
// the booted container because `container run` cannot name a digest).

import type { LocalSandboxState } from "@useagent/runner-protocol";
import { type CliFlags, cliDial, cliExec, cliSpawn, cliSpawnTerminal, runCli } from "./cli-backend";
import {
  BackendError,
  type ContainerInfo,
  type ContainerSpec,
  type DialedConnection,
  type ExecOptions,
  type LocalBackend,
  type RegistryLogin,
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
  /** `container run` takes only a tag, so the digest is checked on the booted container. */
  readonly pinsByDigest = false;

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

  async pullImage(ref: string, onProgress?: (line: string) => void, login?: RegistryLogin, signal?: AbortSignal): Promise<void> {
    // The container tool keeps logins in the keychain, and macOS asks the person
    // before its image service may read one; the answer sticks to that item. So
    // a login is written once and kept: rewriting it around every pull would ask
    // again each time, and removing it afterwards would throw the answer away.
    const fresh = login ? !(await this.hasLogin(login)) : false;
    if (login && fresh) await this.login(login);
    try {
      await this.pull(ref, onProgress, signal);
    } catch (error) {
      // A kept login can be stale (the runner was enrolled again): write it once more and retry.
      if (!login || fresh || signal?.aborted) throw error;
      await this.login(login);
      await this.pull(ref, onProgress, signal);
    }
  }

  private async hasLogin(login: RegistryLogin): Promise<boolean> {
    const result = await runCli(["container", "registry", "list"], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) return false;
    return result.stdout.split("\n").some((line) => {
      const [host, user] = line.trim().split(/\s+/);
      return host === login.registry && user === login.username;
    });
  }

  private async login(login: RegistryLogin): Promise<void> {
    const result = await runCli(["container", "registry", "login", login.registry, "--username", login.username, "--password-stdin"], {
      stdin: new TextEncoder().encode(login.password),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) throw new BackendError("internal", `container registry login ${login.registry} failed: ${result.stderr.trim()}`);
  }

  private async pull(ref: string, onProgress?: (line: string) => void, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new BackendError("internal", `container image pull ${ref} stopped`);
    const proc = Bun.spawn(["container", "image", "pull", ref], { stdout: "pipe", stderr: "pipe" });
    const abort = () => proc.kill();
    signal?.addEventListener("abort", abort, { once: true });
    let last = "";
    const relay = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        for (const line of decoder.decode(chunk, { stream: true }).split(/\r?\n/)) {
          if (line.trim()) {
            last = line.trim();
            onProgress?.(last);
          }
        }
      }
    };
    await Promise.all([relay(proc.stdout), relay(proc.stderr)]);
    const code = await proc.exited;
    signal?.removeEventListener("abort", abort);
    if (signal?.aborted) throw new BackendError("internal", `container image pull ${ref} stopped`);
    if (code !== 0) throw new BackendError("internal", `container image pull ${ref} failed${last ? `: ${last}` : ""}`);
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
    return cliDial(flags, id, port);
  }

  private failure(stderr: string, what: string): BackendError {
    return /not found|does not exist/i.test(stderr)
      ? new BackendError("not_found", stderr.trim())
      : new BackendError("internal", `${what} failed: ${stderr.trim()}`);
  }
}
