import { createHash } from "node:crypto";
import { SandboxNotFoundError, type SandboxProvider, type SandboxProviderKind } from "@useagent/sandbox-contract";
import { parseLocalSandboxId } from "@useagent/runner-protocol";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runs } from "../db/schema";
import { listProviderConnections } from "../provider-connections/repo";
import { getTrustedProviderCredential } from "../provider-connections/service";
import { resolveGatewayComputerApiKeyConnection } from "../provider-gateway/api-key-credentials";
import {
  sandboxProviderFor,
  sandboxProviderApiKey,
  sandboxProviderApiKeyFor,
  sandboxProviderKind,
  sandboxProviderPorts,
  sandboxTemplate,
} from "./provider";
import { isSandboxProviderKind } from "./plugins";
import { enabledSandboxProviders, readSandboxPreference } from "./preference";
import { localPlugin, localProviderConfig } from "@useagent/sandbox-local";
import { getRunnerPolicy, localRunnersEnabled } from "../runners/policy";
import { activeRunnerSeam } from "../runners/directory";
import { withRunnerBridgeContext } from "../runners/bridge-context";
import { ExpectedSandboxMismatchError, parseExpectedSandboxBinding, type ExpectedSandboxBinding } from "./expected-binding";
export { ExpectedSandboxMismatchError } from "./expected-binding";

/**
 * Which computer a run's sandbox lives on. The server's env provider is the
 * default; when USER_COMPUTERS is on, a user's connected Daytona or Box key
 * (Settings > Infrastructure) runs that user's work on their own account.
 * The choice is recorded on the run so every later touch of that sandbox
 * (preview, files, recording, release) talks to the provider that made it.
 */

export type SandboxCredentialSource = "env" | "user";
export const COMPUTER_PROVIDER_KINDS = ["daytona", "box"] as const;
export type ComputerProviderKind = (typeof COMPUTER_PROVIDER_KINDS)[number];

export class PersonalSandboxConnectionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonalSandboxConnectionUnavailableError";
  }
}

export interface SandboxBinding {
  readonly kind: SandboxProviderKind;
  readonly provider: SandboxProvider;
  /** User bindings carry the connection's snapshot (null = provider base image). */
  readonly snapshot: string | null;
  readonly credential: SandboxCredentialSource;
  readonly userId: string | null;
  /** Version of the user connection used to build this provider instance. */
  readonly connectionUpdatedAt?: string;
  /** Engine logins the sandbox carries from the user's own machine; empty for every hosted provider. */
  readonly logins: readonly string[];
}

export interface SandboxBindingDeps {
  readonly expectedSandbox?: ExpectedSandboxBinding;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly connections?: typeof listProviderConnections;
  readonly credential?: typeof getTrustedProviderCredential;
  /** Restricted gateway resolver backed by the filtered API-key view. */
  readonly gatewayConnection?: typeof resolveGatewayComputerApiKeyConnection;
  /** Test seam: provider factories per kind (default: the plugin registry). */
  readonly providers?: Partial<Record<SandboxProviderKind, (apiKey: string) => SandboxProvider>>;
  readonly envProvider?: () => SandboxBinding | null;
  /** Test seam: the user's connected machine and the org's policy (default: this process's runner view). */
  readonly runners?: {
    readonly onlineForUser: (orgId: string, userId: string) => BoundRunner | null;
    readonly runner: (runnerId: string) => BoundRunner | null;
    readonly policy: (orgId: string) => Promise<{ allowLocalExecution: boolean; allowLocalLogins: boolean }>;
    readonly refresh?: () => Promise<void>;
  };
}

/** What a binding needs to know about a machine. */
export interface BoundRunner {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly enrolledAt: string;
  readonly logins: readonly string[];
}

function runnerSeam(deps: SandboxBindingDeps): NonNullable<SandboxBindingDeps["runners"]> {
  if (deps.runners) return deps.runners;
  const seam = activeRunnerSeam();
  return { onlineForUser: seam.onlineForUser, runner: seam.runner, policy: getRunnerPolicy, refresh: seam.refresh };
}

function localBinding(runner: BoundRunner, logins: readonly string[], deps: SandboxBindingDeps): SandboxBinding {
  const env = deps.env ?? process.env;
  const config = localProviderConfig(env, { runnerId: runner.id, logins });
  const build = deps.providers?.local ?? (() => localPlugin.createProvider(config, sandboxProviderPorts("local")));
  return {
    kind: "local",
    provider: build(""),
    snapshot: null,
    credential: "user",
    userId: runner.userId,
    connectionUpdatedAt: runner.enrolledAt,
    logins,
  };
}

/** The user's connected machine, when the deployment and the organisation allow local execution. */
async function localRunnerBinding(
  scope: { readonly orgId: string; readonly userId: string },
  deps: SandboxBindingDeps,
): Promise<SandboxBinding | null> {
  if (!localRunnersEnabled(deps.env)) return null;
  const seam = runnerSeam(deps);
  const runner = seam.onlineForUser(scope.orgId, scope.userId);
  if (!runner) return null;
  const policy = await seam.policy(scope.orgId);
  if (!policy.allowLocalExecution) return null;
  return localBinding(runner, policy.allowLocalLogins ? runner.logins : [], deps);
}

export class LocalExecutionDisabledError extends Error {
  readonly code = "local_execution_disabled" as const;

  constructor() {
    super("Local execution is switched off for this organisation; the sandbox on the machine is kept.");
    this.name = "LocalExecutionDisabledError";
  }
}

/**
 * The machine a recorded local sandbox lives on, connected or not; use fails
 * with "not connected" when it is away. The deployment and organisation
 * switches apply here too, so a retained sandbox cannot outlive them; the
 * record stays and nothing falls back to another provider.
 */
async function localRecordedBinding(recorded: RecordedSandbox, deps: SandboxBindingDeps): Promise<SandboxBinding> {
  const parsed = recorded.sandboxId ? parseLocalSandboxId(recorded.sandboxId) : null;
  const runner = parsed ? runnerSeam(deps).runner(parsed.runnerId) : null;
  if (!parsed || !runner) {
    throw new Error("this sandbox was created on a machine that is no longer enrolled");
  }
  if (!localRunnersEnabled(deps.env)) throw new LocalExecutionDisabledError();
  const policy = await runnerSeam(deps).policy(runner.orgId);
  if (!policy.allowLocalExecution) throw new LocalExecutionDisabledError();
  return localBinding(runner, policy.allowLocalLogins ? runner.logins : [], deps);
}

/** Captured provider configuration, not a fresh read of ambient credentials. */
export function sandboxBindingCredentialGeneration(binding: SandboxBinding): string {
  const fingerprint = binding.provider.connectionFingerprint;
  if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint) ||
    (binding.credential === "user" && (!binding.userId || !binding.connectionUpdatedAt))) {
    throw new ExpectedSandboxMismatchError();
  }
  return createHash("sha256").update(JSON.stringify([
    fingerprint, binding.kind, binding.credential, binding.userId,
    binding.connectionUpdatedAt ?? null,
  ])).digest("hex");
}

export function sandboxBindingExpectation(
  binding: SandboxBinding,
  orgId: string,
  sandboxId: string,
): ExpectedSandboxBinding {
  return parseExpectedSandboxBinding({
    version: 1, sandboxId, provider: binding.kind, credential: binding.credential,
    ownerOrgId: orgId, ownerUserId: binding.credential === "user" ? binding.userId : null,
    credentialGeneration: sandboxBindingCredentialGeneration(binding),
  })!;
}

export function assertExpectedSandboxBinding(
  expected: ExpectedSandboxBinding,
  binding: SandboxBinding,
  orgId: string,
  sandboxId: string,
): void {
  if (JSON.stringify(parseExpectedSandboxBinding(expected)) !==
    JSON.stringify(sandboxBindingExpectation(binding, orgId, sandboxId))) {
    throw new ExpectedSandboxMismatchError();
  }
}

export function userComputersEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = (env.USER_COMPUTERS ?? "").trim().toLowerCase();
  return value === "1" || value === "on" || value === "true";
}

function isComputerKind(value: unknown): value is ComputerProviderKind {
  return typeof value === "string" && (COMPUTER_PROVIDER_KINDS as readonly string[]).includes(value);
}

/** The server's own provider from env; null when no credential is configured. */
export function envSandboxBinding(env: Readonly<Record<string, string | undefined>> = process.env): SandboxBinding | null {
  const kind = sandboxProviderKind(env);
  const apiKey = sandboxProviderApiKey(env);
  if (apiKey === undefined) return null;
  return { kind, provider: sandboxProviderFor(kind, apiKey, env), snapshot: null, credential: "env", userId: null, logins: [] };
}

function requireEnvBinding(deps: SandboxBindingDeps): SandboxBinding {
  const binding = (deps.envProvider ?? (() => envSandboxBinding(deps.env)))();
  if (!binding) throw new Error("sandbox provider credentials are unavailable");
  return binding;
}

function requireRecordedEnvBinding(kind: SandboxProviderKind, deps: SandboxBindingDeps): SandboxBinding {
  const env = deps.env ?? process.env;
  const apiKey = sandboxProviderApiKeyFor(kind, env);
  if (apiKey === undefined) {
    throw new Error(`sandbox provider credentials are unavailable for recorded ${kind} sandbox`);
  }
  const build = deps.providers?.[kind] ?? ((key: string) => sandboxProviderFor(kind, key, env));
  return { kind, provider: build(apiKey), snapshot: null, credential: "env", userId: null, logins: [] };
}

async function userSandboxBinding(
  scope: { readonly orgId: string; readonly userId: string },
  onlyKind: ComputerProviderKind | null,
  deps: SandboxBindingDeps,
): Promise<SandboxBinding | null> {
  const env = deps.env ?? process.env;
  if (
    env.GATEWAY_DATABASE_URL?.trim() &&
    !deps.connections &&
    !deps.credential
  ) {
    const row = await (
      deps.gatewayConnection ?? resolveGatewayComputerApiKeyConnection
    )({
      ...scope,
      providers: onlyKind ? [onlyKind] : [...COMPUTER_PROVIDER_KINDS],
    });
    if (!row || !isComputerKind(row.provider)) return null;
    const kind = row.provider;
    const build =
      deps.providers?.[kind] ??
      ((key: string) => sandboxProviderFor(kind, key, env));
    return {
      kind,
      provider: build(row.value),
      snapshot: row.metadata.snapshotName?.trim() || null,
      credential: "user",
      userId: scope.userId,
      connectionUpdatedAt: row.updatedAt,
      logins: [],
    };
  }
  const connections = deps.connections ?? listProviderConnections;
  const credential = deps.credential ?? getTrustedProviderCredential;
  const candidates = (await connections(scope))
    .filter((row) => row.status === "connected" && row.authMethod === "api_key" && isComputerKind(row.provider))
    .filter((row) => onlyKind === null || row.provider === onlyKind)
    .toSorted((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const row = candidates[0];
  if (!row || !isComputerKind(row.provider)) return null;
  const opened = await credential({ ...scope, provider: row.provider, authMethod: "api_key" });
  if (!opened || opened.authMethod !== "api_key" || typeof opened.value !== "string") return null;
  const kind = row.provider;
  const build = deps.providers?.[kind] ?? ((key: string) => sandboxProviderFor(kind, key, env));
  return {
    kind: row.provider,
    provider: build(opened.value),
    snapshot: row.metadata.snapshotName?.trim() || null,
    credential: "user",
    userId: scope.userId,
    connectionUpdatedAt: row.updatedAt.toISOString(),
    logins: [],
  };
}

/** A new sandbox for this run: the user's own computer when allowed, else the server's. */
export async function resolveSandboxBindingForRun(
  scope: { readonly orgId?: string | null; readonly userId?: string | null },
  deps: SandboxBindingDeps = {},
): Promise<SandboxBinding> {
  if (scope.orgId && scope.userId) {
    const local = await localRunnerBinding({ orgId: scope.orgId, userId: scope.userId }, deps);
    if (local) return local;
  }
  if (userComputersEnabled(deps.env) && scope.orgId && scope.userId) {
    const user = await userSandboxBinding({ orgId: scope.orgId, userId: scope.userId }, null, deps);
    if (user) return user;
  }
  // The member's preferred hosted provider, when this deployment can run it;
  // anything else (unset, unknown, no credential here) is the server's default.
  if (scope.orgId && scope.userId) {
    const env = deps.env ?? process.env;
    const preferred = await readSandboxPreference({ orgId: scope.orgId, userId: scope.userId });
    if (preferred && preferred !== sandboxProviderKind(env) && enabledSandboxProviders(env).includes(preferred)) {
      return requireRecordedEnvBinding(preferred, deps);
    }
  }
  return requireEnvBinding(deps);
}

interface RecordedSandbox {
  readonly sandboxId?: string | null;
  readonly userId: string | null;
  readonly orgId: string | null;
  readonly sandboxProvider: SandboxProviderKind | null;
  readonly sandboxCredential: SandboxCredentialSource | null;
}

const recordedSandboxColumns = {
  sandboxId: runs.sandboxId,
  userId: runs.userId,
  orgId: runs.orgId,
  sandboxProvider: runs.sandboxProvider,
  sandboxCredential: runs.sandboxCredential,
};

/** A run's actor may differ from the owner of the retained personal sandbox. */
async function sandboxOwnerRecord(sandboxId: string, recorded: RecordedSandbox): Promise<RecordedSandbox> {
  const [owner] = await db
    .select(recordedSandboxColumns)
    .from(runs)
    .where(and(
      eq(runs.sandboxId, sandboxId),
      recorded.orgId === null ? isNull(runs.orgId) : eq(runs.orgId, recorded.orgId),
      recorded.sandboxProvider === null
        ? isNull(runs.sandboxProvider)
        : eq(runs.sandboxProvider, recorded.sandboxProvider),
      recorded.sandboxCredential === null
        ? isNull(runs.sandboxCredential)
        : eq(runs.sandboxCredential, recorded.sandboxCredential),
    ))
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .limit(1);
  return owner ?? recorded;
}

async function bindingForRecorded(recorded: RecordedSandbox | null, deps: SandboxBindingDeps): Promise<SandboxBinding> {
  if (recorded?.sandboxProvider === "local") return localRecordedBinding(recorded, deps);
  if (recorded?.sandboxCredential === "user") {
    if (!recorded.orgId || !recorded.userId || !isComputerKind(recorded.sandboxProvider)) {
      throw new Error(
        "this sandbox was created on a personal computer whose owner can no longer be resolved",
      );
    }
    const user = await userSandboxBinding({ orgId: recorded.orgId, userId: recorded.userId }, recorded.sandboxProvider, deps);
    if (!user) {
      throw new PersonalSandboxConnectionUnavailableError(
        `the ${recorded.sandboxProvider} connection that created this sandbox has been revoked`,
      );
    }
    return user;
  }
  if (recorded?.sandboxProvider !== null && recorded?.sandboxProvider !== undefined) {
    if (!isSandboxProviderKind(recorded.sandboxProvider)) {
      throw new Error(`recorded sandbox provider ${recorded.sandboxProvider} is unsupported`);
    }
    return requireRecordedEnvBinding(recorded.sandboxProvider, deps);
  }
  return requireEnvBinding(deps);
}

/** The provider that created the thread's current sandbox (org-scoped). */
export async function resolveSandboxBindingForThread(
  orgId: string,
  threadId: string,
  deps: SandboxBindingDeps = {},
): Promise<SandboxBinding> {
  const expected = parseExpectedSandboxBinding(deps.expectedSandbox);
  if (expected && (expected.ownerOrgId !== orgId || !threadId)) throw new ExpectedSandboxMismatchError();
  const [recorded] = await db
    .select(recordedSandboxColumns)
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.threadId, threadId), isNotNull(runs.sandboxId)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  if (expected && (recorded?.sandboxId !== expected.sandboxId ||
    recorded.sandboxProvider !== expected.provider || recorded.sandboxCredential !== expected.credential)) {
    throw new ExpectedSandboxMismatchError();
  }
  const binding = await bindingForRecorded(recorded?.sandboxId ? await sandboxOwnerRecord(recorded.sandboxId, recorded) : null, deps);
  if (expected) assertExpectedSandboxBinding(expected, binding, orgId, expected.sandboxId);
  return binding;
}

/** Reused by execution and recovery; never consults a default/fallback provider. */
export async function resolveExpectedSandbox(expected: ExpectedSandboxBinding, threadId: string) {
  const binding = await resolveSandboxBindingForThread(expected.ownerOrgId, threadId, { expectedSandbox: expected });
  const sandbox = await binding.provider.get(expected.sandboxId).catch((error: unknown) => {
    if (error instanceof SandboxNotFoundError) throw new ExpectedSandboxMismatchError();
    throw error;
  });
  if (sandbox.id !== expected.sandboxId) throw new ExpectedSandboxMismatchError();
  return sandbox;
}

/** A live turn owns the thread runtime; otherwise its newest accepted turn does. */
export async function getThreadExpectedSandbox(orgId: string, threadId: string, exec: Executor = db) {
  const [run] = await exec.select({ expectedSandbox: runs.expectedSandbox }).from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.threadId, threadId)))
    .orderBy(sql`(${runs.status} = 'running') DESC`, desc(runs.createdAt), desc(runs.id)).limit(1);
  const expected = parseExpectedSandboxBinding(run?.expectedSandbox);
  if (expected && expected.ownerOrgId !== orgId) throw new ExpectedSandboxMismatchError();
  return expected;
}

/** Run-bound tools share the execution fence instead of resolving by ID alone. */
export async function resolveRunSandbox(run: {
  readonly id?: string;
  readonly orgId: string | null;
  readonly userId?: string | null;
  readonly threadId: string;
  readonly sandboxId: string | null;
  readonly expectedSandbox?: ExpectedSandboxBinding | null;
}) {
  // A process without runner links reaches a local sandbox through the bridge,
  // with a capability for this run; the context is captured when the link is built.
  return withRunnerBridgeContext(
    { orgId: run.orgId ?? "", userId: run.userId ?? "", runId: run.id ?? "", threadId: run.threadId },
    async () => {
      if (run.sandboxId && parseLocalSandboxId(run.sandboxId)) await runnerSeam({}).refresh?.();
      const expected = parseExpectedSandboxBinding(run.expectedSandbox) ??
        (run.orgId ? await getThreadExpectedSandbox(run.orgId, run.threadId) : null);
      if (expected) {
        if (run.orgId !== expected.ownerOrgId || run.sandboxId !== expected.sandboxId) {
          throw new ExpectedSandboxMismatchError();
        }
        return await resolveExpectedSandbox(expected, run.threadId);
      }
      if (!run.sandboxId) throw new Error("run has no sandbox");
      return await (await resolveSandboxBindingForSandbox(run.sandboxId)).provider.get(run.sandboxId);
    },
  );
}

/** The provider that created a sandbox, by sandbox id (for callers that hold only the id). */
export async function resolveSandboxBindingForSandbox(sandboxId: string, deps: SandboxBindingDeps = {}): Promise<SandboxBinding> {
  const orgs = await db
    .select({ orgId: runs.orgId })
    .from(runs)
    .where(eq(runs.sandboxId, sandboxId))
    .groupBy(runs.orgId)
    .limit(2);
  if (orgs.length > 1) {
    throw new Error("sandbox owner cannot be resolved from an id shared by multiple organizations");
  }
  const orgId = orgs[0]?.orgId;
  if (orgId === undefined) return bindingForRecorded(null, deps);
  const [recorded] = await db
    .select(recordedSandboxColumns)
    .from(runs)
    .where(and(
      eq(runs.sandboxId, sandboxId),
      orgId === null ? isNull(runs.orgId) : eq(runs.orgId, orgId),
    ))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  return bindingForRecorded(recorded ? await sandboxOwnerRecord(sandboxId, recorded) : null, deps);
}

/** The snapshot a binding creates from: the user's own, or the server's template for the lane. */
export function bindingSnapshot(binding: SandboxBinding, templateEnv: string): string {
  if (binding.credential === "user") return binding.snapshot ?? "";
  return sandboxTemplate(templateEnv);
}

/** What `setRunSandbox` records next to the sandbox id. */
export function bindingRecord(binding: SandboxBinding): { kind: SandboxProviderKind; credential: SandboxCredentialSource } {
  return { kind: binding.kind, credential: binding.credential };
}
