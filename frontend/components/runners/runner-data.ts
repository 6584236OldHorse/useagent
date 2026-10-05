import type { RunLocation } from "@useagent/agent-client/wire";

export const RUNNER_STATUSES = ["enrolled", "online", "offline", "revoked"] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

export const RUNNER_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
] as const;
export type RunnerPlatform = (typeof RUNNER_PLATFORMS)[number];

export interface Runner {
  readonly id: string;
  readonly name: string;
  readonly platform: RunnerPlatform;
  readonly backend: string | null;
  readonly version: string | null;
  readonly status: RunnerStatus;
  readonly lastSeenAt: string | null;
  readonly logins: string[];
  readonly imageDigest: string | null;
  readonly ownerUserId: string;
}

export interface RunnerPolicy {
  readonly allowLocalExecution: boolean;
  readonly allowLocalLogins: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === "string" ? value : undefined;
}

export function decodeRunner(value: unknown): Runner | null {
  const row = record(value);
  if (!row) return null;
  const backend = nullableString(row.backend);
  const version = nullableString(row.version);
  const lastSeenAt = nullableString(row.lastSeenAt);
  const imageDigest = nullableString(row.imageDigest);
  if (
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    !RUNNER_PLATFORMS.includes(row.platform as RunnerPlatform) ||
    !RUNNER_STATUSES.includes(row.status as RunnerStatus) ||
    backend === undefined ||
    version === undefined ||
    lastSeenAt === undefined ||
    imageDigest === undefined ||
    typeof row.ownerUserId !== "string" ||
    !Array.isArray(row.logins) ||
    !row.logins.every((login) => typeof login === "string")
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    platform: row.platform as RunnerPlatform,
    backend,
    version,
    status: row.status as RunnerStatus,
    lastSeenAt,
    logins: [...new Set(row.logins)],
    imageDigest,
    ownerUserId: row.ownerUserId,
  };
}

export function decodeRunners(value: unknown): Runner[] {
  return Array.isArray(value)
    ? value.map(decodeRunner).filter((runner): runner is Runner => runner !== null)
    : [];
}

export function decodeRunnerPolicy(value: unknown): RunnerPolicy | null {
  const policy = record(value);
  return policy &&
    typeof policy.allowLocalExecution === "boolean" &&
    typeof policy.allowLocalLogins === "boolean"
    ? {
        allowLocalExecution: policy.allowLocalExecution,
        allowLocalLogins: policy.allowLocalLogins,
      }
    : null;
}

export function localRunnerId(sandboxId: string | null): string | null {
  if (!sandboxId?.startsWith("local:")) return null;
  const rest = sandboxId.slice("local:".length);
  const separator = rest.indexOf(":");
  return separator > 0 && separator < rest.length - 1 ? rest.slice(0, separator) : null;
}

export function canRevokeRunner(
  runner: Runner,
  userId: string | null,
  canManagePolicy: boolean | null,
): boolean {
  return (
    runner.status !== "revoked" &&
    (runner.ownerUserId === userId || canManagePolicy === true)
  );
}

export function markRunnerRevoked(runners: readonly Runner[], id: string): Runner[] {
  return runners.map((runner) => (runner.id === id ? { ...runner, status: "revoked" } : runner));
}

/** How a sandbox provider kind reads to a person. The E2B-protocol plugin (id
 *  cube) reads as whatever the deployment points at, so callers that know the
 *  config's label pass it in `names`; this map is the fallback. */
export const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  daytona: "Daytona",
  cube: "Cube",
  box: "Box",
  local: "Local machine",
};

/** Whether a run executes on the person's own machine: a local sandbox id,
 *  the local provider (a released sandbox keeps its provider after its id is
 *  cleared), or Local asked for before any sandbox exists. Everything else is
 *  hosted; a thread that asked for nothing runs in the cloud. */
export function runOnMachine(
  sandboxId: string | null,
  sandboxProvider: unknown,
  runLocation: RunLocation | null | undefined = null,
): boolean {
  return (
    localRunnerId(sandboxId) !== null ||
    sandboxProvider === "local" ||
    (!sandboxId && runLocation === "local")
  );
}

/** Where a run executes, in the composer's two words: the machine's enrolled
 *  name for a run on the person's machine ("This Mac" until the runner list
 *  names it) and "Cloud" for anything hosted; the vendor never appears here. */
export function runnerLocationLabel(
  sandboxId: string | null,
  sandboxProvider: unknown,
  runners: readonly Runner[],
  runLocation: RunLocation | null | undefined = null,
): string {
  const runnerId = localRunnerId(sandboxId);
  if (runnerId) return runners.find((runner) => runner.id === runnerId)?.name ?? "This Mac";
  return runOnMachine(sandboxId, sandboxProvider, runLocation) ? "This Mac" : "Cloud";
}

/** The vendor behind a hosted sandbox, kept for a title only: the deployment's
 *  own label when the caller passes it in `names`, else the plugin's name. */
export function sandboxVendorLabel(
  sandboxProvider: unknown,
  names: Readonly<Record<string, string>> = PROVIDER_NAMES,
): string | null {
  return typeof sandboxProvider === "string" && sandboxProvider.trim()
    ? (names[sandboxProvider] ?? sandboxProvider)
    : null;
}

export function runnerLoginAvailable(
  login: string,
  policy: RunnerPolicy | null,
  runners: readonly Runner[],
  userId: string | null,
  runnerEnabled: boolean,
): boolean {
  return (
    runnerEnabled &&
    userId !== null &&
    policy?.allowLocalExecution === true &&
    policy?.allowLocalLogins === true &&
    runners.some(
      (runner) =>
        runner.ownerUserId === userId &&
        runner.status === "online" &&
        runner.logins.includes(login),
    )
  );
}

/** Whether this user's own machine is online and allowed to run their work; a
 *  new thread goes there only when the person chooses Local. */
export function runnerRunsUserWork(
  policy: RunnerPolicy | null,
  runners: readonly Runner[],
  userId: string | null,
  runnerEnabled: boolean,
): boolean {
  return (
    runnerEnabled &&
    userId !== null &&
    policy?.allowLocalExecution === true &&
    runners.some((runner) => runner.ownerUserId === userId && runner.status === "online")
  );
}
