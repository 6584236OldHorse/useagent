// Docker through the `docker` command line (Docker Desktop, OrbStack, Podman's
// docker socket). Runs on every OS the runner ships for, so it is the backend
// the conformance suite exercises in CI.

import type { LocalSandboxState } from "@useagent/runner-protocol";
import { type CliFlags, cliDial, cliExec, cliSpawn, cliSpawnTerminal, firstJsonObject, runCli } from "./cli-backend";
import {
  BackendError,
  type ContainerInfo,
  type ContainerSpec,
  type DialedConnection,
  type ExecOptions,
  type LocalBackend,
} from "./types";

const flags: CliFlags = {
  tool: "docker",
  execUser: (user) => ["-u", user],
  execCwd: (cwd) => ["-w", cwd],
  execEnv: (key, value) => ["-e", `${key}=${value}`],
};

function stateOf(raw: unknown): LocalSandboxState {
  const state = (raw as { Status?: string } | undefined)?.Status ?? "";
  if (state === "running") return "running";
  if (state === "created") return "created";
  if (state === "removing" || state === "dead") return "deleted";
  return "stopped";
}

function infoFromInspect(object: Record<string, unknown>): ContainerInfo {
  const config = (object.Config ?? {}) as { Labels?: Record<string, string> };
  const network = (object.NetworkSettings ?? {}) as { IPAddress?: string; Networks?: Record<string, { IPAddress?: string }> };
  const ip = network.IPAddress || Object.values(network.Networks ?? {})[0]?.IPAddress || null;
  return {
    id: String(object.Id ?? ""),
    name: String(object.Name ?? "").replace(/^\//, ""),
    state: stateOf(object.State),
    labels: config.Labels ?? {},
    createdAt: String(object.Created ?? ""),
    imageDigest: String(object.Image ?? ""),
    ip: ip || null,
  };
}

export class DockerBackend implements LocalBackend {
  readonly kind = "docker" as const;
  readonly pinsByDigest = true;

  async available(): Promise<string | null> {
    const probe = await runCli(["docker", "info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 });
    if (probe.exitCode !== 0) return `docker is not available: ${probe.stderr.trim() || "no daemon"}`;
    return null;
  }

  async pullImage(ref: string, onProgress?: (line: string) => void): Promise<void> {
    const proc = Bun.spawn(["docker", "pull", ref], { stdout: "pipe", stderr: "pipe" });
    const relay = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        for (const line of decoder.decode(chunk, { stream: true }).split("\n")) {
          if (line.trim()) onProgress?.(line.trim());
        }
      }
    };
    await Promise.all([relay(proc.stdout), relay(proc.stderr)]);
    if ((await proc.exited) !== 0) throw new BackendError("internal", `docker pull ${ref} failed`);
  }

  async imageDigest(ref: string): Promise<string | null> {
    const result = await runCli(["docker", "image", "inspect", "--format", "{{index .RepoDigests 0}}", ref]);
    if (result.exitCode !== 0) return null;
    const match = /@(sha256:[0-9a-f]{64})/.exec(result.stdout.trim());
    return match?.[1] ?? null;
  }

  async removeImage(ref: string): Promise<void> {
    await runCli(["docker", "image", "rm", "-f", ref]);
  }

  /** `repo@sha256:...` so a tag that moved after the pull cannot change what boots. */
  pinnedImage(ref: string, digest: string): string {
    const repo = ref.replace(/@sha256:[0-9a-f]{64}$/, "").replace(/:[^/:]+$/, "");
    return `${repo}@${digest}`;
  }

  async create(spec: ContainerSpec): Promise<string> {
    const argv = ["docker", "create", "--name", spec.name, "--init", "--cpus", String(spec.cpu), "--memory", `${spec.memoryMb}m`];
    for (const [key, value] of Object.entries(spec.labels)) argv.push("--label", `${key}=${value}`);
    for (const [key, value] of Object.entries(spec.env)) argv.push("-e", `${key}=${value}`);
    for (const mount of spec.mounts) {
      argv.push("--mount", `type=bind,source=${mount.hostPath},target=${mount.containerPath}${mount.readonly ? ",readonly" : ""}`);
    }
    argv.push(spec.image, "sleep", "infinity");
    const result = await runCli(argv, { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new BackendError("internal", `docker create failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }

  async start(id: string): Promise<void> {
    const result = await runCli(["docker", "start", id], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw this.failure(result.stderr, "docker start");
  }

  async stop(id: string): Promise<void> {
    const result = await runCli(["docker", "stop", "-t", "10", id], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw this.failure(result.stderr, "docker stop");
  }

  async remove(id: string): Promise<void> {
    const result = await runCli(["docker", "rm", "-f", "-v", id], { timeoutMs: 60_000 });
    if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) throw this.failure(result.stderr, "docker rm");
  }

  async inspect(id: string): Promise<ContainerInfo | null> {
    const result = await runCli(["docker", "inspect", "--type", "container", id]);
    if (result.exitCode !== 0) return null;
    const object = firstJsonObject(result.stdout);
    return object ? infoFromInspect(object) : null;
  }

  async list(labels: Readonly<Record<string, string>>): Promise<ContainerInfo[]> {
    const argv = ["docker", "ps", "-a", "-q"];
    for (const [key, value] of Object.entries(labels)) argv.push("--filter", `label=${key}=${value}`);
    const ids = (await runCli(argv)).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    if (ids.length === 0) return [];
    const result = await runCli(["docker", "inspect", "--type", "container", ...ids]);
    if (result.exitCode !== 0) return [];
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>[];
    return parsed.map(infoFromInspect);
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
    return /No such container/i.test(stderr)
      ? new BackendError("not_found", stderr.trim())
      : new BackendError("internal", `${what} failed: ${stderr.trim()}`);
  }
}
