#!/usr/bin/env bun
// The runner binary. Parse the command line, pick a container backend, connect
// to the control plane, and stay up until the plane ends the link for good or
// the process is told to stop.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { selectBackend } from "./backends/detect";
import { machineCapacity } from "./capacity";
import { EXIT, RUNNER_VERSION, USAGE, parseArgs, runnerIdFromToken, type RunCommand } from "./cli";
import { ensureImage } from "./image";
import { LinkClient, type LinkStop } from "./link";
import { LoginStore } from "./logins";
import { RunnerService } from "./service";
import { emitStatus } from "./status";

const IDLE_SWEEP_MS = 60_000;

function exitCodeFor(stop: LinkStop): number {
  switch (stop.reason) {
    case "token_rejected":
      return EXIT.tokenRejected;
    case "plane_too_old":
      return EXIT.planeTooOld;
    case "runner_too_old":
      return EXIT.runnerTooOld;
    case "stopped":
      return EXIT.ok;
  }
}

async function run(command: RunCommand): Promise<number> {
  const token = process.env.USEAGENT_RUNNER_TOKEN?.trim() ?? "";
  const runnerId = runnerIdFromToken(token);
  if (!runnerId) {
    emitStatus({ state: "error", detail: "USEAGENT_RUNNER_TOKEN is missing or not a runner token" });
    return EXIT.tokenRejected;
  }
  emitStatus({ state: "starting", detail: `useagent-runner ${RUNNER_VERSION} as ${runnerId}` });
  const chosen = await selectBackend(command.backend);
  if ("problem" in chosen) {
    emitStatus({ state: "error", detail: chosen.problem });
    return EXIT.noBackend;
  }
  const backend = chosen.backend;
  await mkdir(command.dataDir, { recursive: true, mode: 0o700 });
  const logins = new LoginStore(join(command.dataDir, "logins"));
  const service = new RunnerService({
    runnerId,
    backend,
    loginMounts: (requested) => logins.mounts(requested.filter((name) => command.shareLogins.includes(name))),
    onSandboxStopped: () => logins.syncBack().then(() => {}),
    maxSandboxes: command.maxSandboxes,
  });
  let available: string[] = await logins.available().then((names) => names.filter((n) => command.shareLogins.includes(n)));
  let imageDigest: string | null = null;
  let sandboxes = 0;
  const refreshCounts = async () => {
    sandboxes = (await service.listOwned()).filter((c) => c.state === "running").length;
  };
  await refreshCounts();

  const link = new LinkClient({
    planeUrl: command.planeUrl,
    token,
    runnerId,
    version: RUNNER_VERSION,
    backend: backend.kind,
    platform: `${process.platform}-${process.arch}`,
    capacity: () => machineCapacity(sandboxes, command.maxSandboxes),
    logins: () => available,
    imageDigest: () => imageDigest,
    rpc: async (method, params) => {
      const result = await service.rpc(method, params);
      if (method === "sandbox.create" || method === "sandbox.delete" || method === "sandbox.start") await refreshCounts();
      return result;
    },
    stream: (target, stream) => service.stream(target, stream),
    onWelcome: async (frame) => {
      emitStatus({ state: "pulling", detail: frame.image.ref, progress: 0 });
      try {
        imageDigest = await ensureImage(backend, frame.image, (progress, detail) => emitStatus({ state: "pulling", detail, progress }));
      } catch (error) {
        emitStatus({ state: "error", detail: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    onState: (state, detail) => {
      emitStatus({ state: state === "connecting" ? "starting" : state, detail });
    },
  });

  const sweep = setInterval(() => {
    void service.stopIdle().then(refreshCounts).catch(() => {});
    void logins.available().then((names) => {
      available = names.filter((n) => command.shareLogins.includes(n));
    });
  }, IDLE_SWEEP_MS);
  const stop = () => link.stop("signal");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const outcome = await link.run();
    if (outcome.reason !== "stopped") emitStatus({ state: "error", detail: outcome.detail });
    else emitStatus({ state: "offline", detail: outcome.detail });
    return exitCodeFor(outcome);
  } finally {
    clearInterval(sweep);
    await logins.syncBack().catch(() => {});
  }
}

async function uninstall(backendChoice: Parameters<typeof selectBackend>[0], dataDir: string): Promise<number> {
  const chosen = await selectBackend(backendChoice);
  if ("problem" in chosen) {
    emitStatus({ state: "error", detail: chosen.problem });
    return EXIT.noBackend;
  }
  // Only this runner's sandboxes go; another runner on the same machine keeps its own.
  const runnerId = runnerIdFromToken(process.env.USEAGENT_RUNNER_TOKEN?.trim() ?? "");
  let removed = 0;
  if (runnerId) {
    for (const container of await chosen.backend.list({ "useagent.runner": runnerId })) {
      await chosen.backend.remove(container.name).catch(() => {});
      removed += 1;
    }
  } else {
    emitStatus({ state: "starting", detail: "USEAGENT_RUNNER_TOKEN is not set, so no sandboxes are removed; only the data directory goes" });
  }
  const { rm } = await import("node:fs/promises");
  await rm(dataDir, { recursive: true, force: true });
  emitStatus({ state: "offline", detail: `removed ${removed} sandbox${removed === 1 ? "" : "es"} and ${dataDir}` });
  return EXIT.ok;
}

async function main(): Promise<number> {
  let command: ReturnType<typeof parseArgs>;
  try {
    command = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return EXIT.usage;
  }
  switch (command.command) {
    case "version":
      process.stdout.write(`${RUNNER_VERSION}\n`);
      return EXIT.ok;
    case "help":
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    case "uninstall":
      return uninstall(command.backend, command.dataDir);
    case "run":
      return run(command);
  }
}

if (import.meta.main) {
  process.exit(await main());
}
