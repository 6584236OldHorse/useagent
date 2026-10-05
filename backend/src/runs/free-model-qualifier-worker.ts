import type { Db } from "../db/client";
import { db } from "../db/client";
import { awaitWithSignal } from "../util/abortable-operation";
import type {
  FreeModelProbeErrorCode,
  FreeModelRegistryStateRow,
} from "../db/schema";
import { getRunAdmissionWithin, type RunAdmissionState } from "../commands/admission";
import {
  claimDueFreeModelCandidates,
  loadCurrentFreeModelLane,
  loadFreeModelRegistry,
  publishFreeModelLane,
  recordFreeModelProbeResult,
  upsertDiscoveredFreeModelCandidates,
  type ClaimedFreeModelCandidate,
  type FreeModelRegistrySnapshot,
  type PublishFreeModelLaneResult,
} from "./free-model-registry-repo";
import {
  discoverOpenCodeZenFreeModels,
  discoverOpenRouterFreeModels,
  freeModelLaneCache,
  MODELS_DEV_CATALOG_URL,
  OPENROUTER_CATALOG_TIMEOUT_MS,
  OPENROUTER_CATALOG_URL,
  type CatalogFetcher,
  type FreeModelCandidate,
  type FreeModelProvider,
} from "./free-model-lane";
import { providerProven } from "./engine-readiness";
import { providerCredentialName } from "../provider-gateway/provider";
import {
  FREE_MODEL_QUALIFICATION_TIMEOUT_MS,
  type FreeModelQualificationDriver,
  type FreeModelQualificationResult,
} from "./free-model-qualification-driver";

/** A claim outlives the probe's deadline, else a slow probe's record is refused. */
export const QUALIFIER_LEASE_MS = FREE_MODEL_QUALIFICATION_TIMEOUT_MS + 5 * 60_000;
/** How long a tick waits for the admission lock: a deployment's exclusive hold
 * past this ends the tick as "admission unavailable" instead of parking it. */
export const QUALIFIER_ADMISSION_WAIT_MS = 5_000;
const QUALIFIER_INTERVAL_MIN = 15;
const QUALIFIER_MAX_PROBES_PER_TICK = 4;
/** The promote reopens admission a few seconds after the backend boots; a tick
 * inside that window only logs "admission closed". */
export const QUALIFIER_BOOT_DELAY_MS = 30_000;
/** Manual (picker) refresh cool-down. Process-global: the catalog and the
 * probe budget are deployment-wide, so one refresh serves every org. */
const MANUAL_REFRESH_COOLDOWN_MS = 30_000;
/** How long the refresh request waits for the tick's catalog phase: the
 * catalog timeout plus a margin. A tick held behind the admission lock (a
 * deployment in progress) answers "pending" instead of holding the request. */
export const MANUAL_REFRESH_WAIT_MS = 15_000;
const PENDING_SUCCESS_RETRY_MS = 10 * 60_000;
const QUALIFIED_SUCCESS_RETRY_MS = 6 * 60 * 60_000;
const SYSTEM_FAILURE_RETRY_MS = 30 * 60_000;
const MODEL_FAILURE_BASE_RETRY_MS = 30 * 60_000;
const MODEL_FAILURE_MAX_RETRY_MS = 24 * 60 * 60_000;
/** The advertised lane holds up to this many models per source, so a second
 * source is never crowded out by the first one's earlier qualifications. */
const PUBLISHED_LANE_CAP_PER_PROVIDER = 8;

/** On by default; FREE_MODEL_QUALIFIER=off is the kill switch (the lane then
 * stays at its last published generation). */
export function freeModelQualifierEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.FREE_MODEL_QUALIFIER !== "off";
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export interface FreeModelQualifierRepository {
  readonly upsertDiscovered: (
    candidates: readonly { modelId: string; provider: string; source: string }[],
  ) => Promise<number>;
  readonly claimDue: (limit: number, leaseMs: number) => Promise<ClaimedFreeModelCandidate[]>;
  readonly recordResult: (input: {
    modelId: string;
    claimToken: string;
    outcome: "success" | "failure" | "system_failure";
    nextProbeAt: Date;
    httpStatus: number | null;
    latencyMs: number | null;
    errorCode: FreeModelProbeErrorCode | null;
  }) => Promise<boolean>;
  readonly loadRegistry: () => Promise<FreeModelRegistrySnapshot>;
  readonly publish: (input: {
    modelIds: readonly string[];
    systemFailure?: boolean;
    allowEmpty?: boolean;
    expectedGeneration?: number;
  }) => Promise<PublishFreeModelLaneResult>;
}

function productionRepository(database: Db = db): FreeModelQualifierRepository {
  return {
    upsertDiscovered: (candidates) => upsertDiscoveredFreeModelCandidates(candidates, database),
    claimDue: (limit, leaseMs) =>
      claimDueFreeModelCandidates({ limit, leaseMs }, database),
    recordResult: (input) => recordFreeModelProbeResult(input, database),
    loadRegistry: () => loadFreeModelRegistry(undefined, database),
    publish: (input) => publishFreeModelLane(input, database),
  };
}

export interface CatalogDiscoverySuccess {
  readonly ok: true;
  readonly candidates: readonly FreeModelCandidate[];
  /** The catalogs this discovery read. A model of a read source that is not
   * among the candidates is no longer free there (repriced or retired). */
  readonly sources: readonly FreeModelProvider[];
}

export interface CatalogDiscoveryFailure {
  readonly ok: false;
  readonly errorCode: FreeModelProbeErrorCode;
  readonly httpStatus: number | null;
}

export type CatalogDiscoveryResult = CatalogDiscoverySuccess | CatalogDiscoveryFailure;

async function fetchCatalogCandidates(
  fetcher: CatalogFetcher,
  url: string,
  source: FreeModelProvider,
  discover: (catalog: unknown) => FreeModelCandidate[] | null,
): Promise<CatalogDiscoveryResult> {
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(OPENROUTER_CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errorCode: FreeModelProbeErrorCode = response.status === 401
        ? "authentication_failed"
        : response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "provider_capacity"
            : "invalid_response";
      return { ok: false, errorCode, httpStatus: response.status };
    }
    const candidates = discover(await response.json());
    // OpenRouter always lists free slugs, so an empty result is a bad read.
    // Zen's discovery says null for a bad read and [] for "nothing free now".
    if (candidates === null || (source === "openrouter" && candidates.length === 0)) {
      return { ok: false, errorCode: "invalid_response", httpStatus: response.status };
    }
    return { ok: true, candidates, sources: [source] };
  } catch {
    return { ok: false, errorCode: "transport_error", httpStatus: null };
  }
}

export function fetchOpenRouterFreeModelCandidates(
  fetcher: CatalogFetcher = fetch,
): Promise<CatalogDiscoveryResult> {
  return fetchCatalogCandidates(fetcher, OPENROUTER_CATALOG_URL, "openrouter", discoverOpenRouterFreeModels);
}

export function fetchOpenCodeZenFreeModelCandidates(
  fetcher: CatalogFetcher = fetch,
): Promise<CatalogDiscoveryResult> {
  return fetchCatalogCandidates(fetcher, MODELS_DEV_CATALOG_URL, "opencode", discoverOpenCodeZenFreeModels);
}

/** OpenCode Zen is a source only where the deployment can run its models:
 * the house key is set and the provider carries release evidence. Probing
 * without either would only record system failures. */
export function openCodeZenSourceEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(env[providerCredentialName("opencode")]?.trim()) && providerProven("opencode", env);
}

/** OpenRouter is the lane's required source; OpenCode Zen joins when enabled,
 * and its catalog being unreachable costs only this tick's Zen candidates. */
export async function discoverFreeModelCandidates(
  fetcher: CatalogFetcher = fetch,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CatalogDiscoveryResult> {
  const openrouter = await fetchOpenRouterFreeModelCandidates(fetcher);
  if (!openrouter.ok || !openCodeZenSourceEnabled(env)) return openrouter;
  const zen = await fetchOpenCodeZenFreeModelCandidates(fetcher);
  if (!zen.ok) {
    console.warn(
      `[free-model-qualifier] OpenCode Zen catalog unavailable (${zen.errorCode}); OpenRouter candidates only this tick`,
    );
    return openrouter;
  }
  return {
    ok: true,
    candidates: [...openrouter.candidates, ...zen.candidates]
      .toSorted((a, b) => b.contextLength - a.contextLength),
    sources: ["openrouter", "opencode"],
  };
}

/** OpenRouter's ":free" slugs are free by construction upstream, so a slug
 * missing from one catalog read is a partial read, not a price change. OpenCode
 * Zen carries our own marker, so a Zen model absent from a read Zen catalog is
 * not free any more and must not be probed, published, or served on the house
 * key. */
export function stillFreeAtSource(
  modelId: string,
  provider: string,
  discovery: CatalogDiscoverySuccess,
): boolean {
  if (provider !== "opencode" || !discovery.sources.includes("opencode")) return true;
  return discovery.candidates.some((candidate) => candidate.id === modelId);
}

export function nextProbeAtForResult(
  claim: ClaimedFreeModelCandidate,
  result: FreeModelQualificationResult,
  nowMs: number,
): Date {
  if (result.classification === "success") {
    const qualifiesNow = claim.successStreak + 1 >= 2;
    return new Date(
      nowMs + (qualifiesNow ? QUALIFIED_SUCCESS_RETRY_MS : PENDING_SUCCESS_RETRY_MS),
    );
  }
  if (result.classification === "system_failure") {
    return new Date(nowMs + SYSTEM_FAILURE_RETRY_MS);
  }
  const exponent = Math.min(claim.failureStreak, 10);
  return new Date(
    nowMs + Math.min(
      MODEL_FAILURE_MAX_RETRY_MS,
      MODEL_FAILURE_BASE_RETRY_MS * 2 ** exponent,
    ),
  );
}

/** Failures every probe would share until an operator acts. */
export function laneWideFailure(errorCode: FreeModelProbeErrorCode | null): boolean {
  return errorCode === "authentication_failed" || errorCode === "rate_limited";
}

function sameLane(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((model, index) => model === right[index]);
}

/** Keep surviving current order, then append newly qualified catalog entries,
 * up to the cap for each source. */
export function desiredPublishedLane(
  registry: FreeModelRegistrySnapshot,
  discovery: CatalogDiscoverySuccess,
): string[] {
  const catalog = discovery.candidates;
  const qualifiedProvider = new Map(
    registry.candidates
      .filter((candidate) =>
        candidate.state === "qualified" &&
        candidate.everQualified &&
        stillFreeAtSource(candidate.modelId, candidate.provider, discovery))
      .map((candidate) => [candidate.modelId, candidate.provider]),
  );
  const perProvider = new Map<string, number>();
  const desired: string[] = [];
  const admit = (modelId: string): void => {
    const provider = qualifiedProvider.get(modelId);
    if (provider === undefined || desired.includes(modelId)) return;
    const count = perProvider.get(provider) ?? 0;
    if (count >= PUBLISHED_LANE_CAP_PER_PROVIDER) return;
    perProvider.set(provider, count + 1);
    desired.push(modelId);
  };
  for (const modelId of registry.state?.currentModelIds ?? []) admit(modelId);
  for (const candidate of catalog) admit(candidate.id);
  return desired;
}

export interface FreeModelQualifierTickDeps {
  /** Null: no organization owns probe runs yet, so the tick discovers and
   * republishes but never probes. */
  readonly driver: FreeModelQualificationDriver | null;
  readonly repository?: FreeModelQualifierRepository;
  readonly discover?: () => Promise<CatalogDiscoveryResult>;
  /** Fires once the catalog phase settled, before any probe starts. */
  readonly onDiscovered?: (result: CatalogDiscoveryResult) => void;
  readonly admission?: () => Promise<RunAdmissionState>;
  readonly nowMs?: () => number;
  readonly maxProbes?: number;
  readonly leaseMs?: number;
  readonly adoptPublishedLane?: (state: FreeModelRegistryStateRow) => void;
}

export interface FreeModelQualifierTickResult {
  readonly status:
    | "skipped_admission_closed"
    | "skipped_admission_unavailable"
    | "catalog_failure"
    | "completed";
  readonly discovered: number;
  readonly claimed: number;
  readonly recorded: number;
  readonly systemFailure: boolean;
  readonly publishOutcome: PublishFreeModelLaneResult["outcome"] | "unchanged";
}

export async function runFreeModelQualifierTick(
  deps: FreeModelQualifierTickDeps,
): Promise<FreeModelQualifierTickResult> {
  const repository = deps.repository ?? productionRepository();
  const admission = deps.admission ?? (() => getRunAdmissionWithin(QUALIFIER_ADMISSION_WAIT_MS));
  const nowMs = deps.nowMs ?? Date.now;
  const driver = deps.driver;
  const maxProbes = driver ? deps.maxProbes ?? QUALIFIER_MAX_PROBES_PER_TICK : 0;
  const leaseMs = deps.leaseMs ?? QUALIFIER_LEASE_MS;
  // A read that cannot answer in time (a held lock, an exhausted connection
  // pool) answers "unknown", never "open". The deadline is the tick's own: it
  // runs from the call, whatever the read is waiting on underneath.
  const admissionOpen = async (): Promise<boolean | null> => {
    try {
      const state = await awaitWithSignal(
        admission,
        AbortSignal.timeout(QUALIFIER_ADMISSION_WAIT_MS + 1_000),
      );
      return state.open;
    } catch {
      return null;
    }
  };
  const open = await admissionOpen();
  if (!open) {
    return {
      status: open === null ? "skipped_admission_unavailable" : "skipped_admission_closed",
      discovered: 0,
      claimed: 0,
      recorded: 0,
      systemFailure: false,
      publishOutcome: "unchanged",
    };
  }

  const discovery = await (deps.discover ?? discoverFreeModelCandidates)();
  deps.onDiscovered?.(discovery);
  if (!discovery.ok) {
    const published = await repository.publish({ modelIds: [], systemFailure: true });
    return {
      status: "catalog_failure",
      discovered: 0,
      claimed: 0,
      recorded: 0,
      systemFailure: true,
      publishOutcome: published.outcome,
    };
  }

  const discovered = await repository.upsertDiscovered(
    discovery.candidates.map((candidate) => ({
      modelId: candidate.id,
      provider: candidate.provider,
      source: candidate.provider === "opencode" ? "models_dev_catalog" : "openrouter_catalog",
    })),
  );
  // A Zen model the catalog no longer calls free leaves the lane before any
  // probe runs, so a probe batch that ends in a system failure (which preserves
  // the lane) cannot keep it advertised. Nothing else moves here: the rest of
  // the lane is re-derived only at the end of a successful tick, as before.
  if (discovery.sources.includes("opencode")) {
    const before = await repository.loadRegistry();
    const current = before.state?.currentModelIds ?? [];
    const providerOf = new Map(before.candidates.map((row) => [row.modelId, row.provider]));
    const repriced = current.filter((modelId) =>
      !stillFreeAtSource(modelId, providerOf.get(modelId) ?? "openrouter", discovery));
    if (repriced.length > 0) {
      const survivors = desiredPublishedLane(before, discovery).filter((modelId) => current.includes(modelId));
      const published = await repository.publish({
        modelIds: survivors,
        allowEmpty: true,
        ...(before.state ? { expectedGeneration: before.state.generation } : {}),
      });
      deps.adoptPublishedLane?.(published.state);
    }
  }
  let claimed = 0;
  let recorded = 0;
  let systemFailure = false;
  for (let index = 0; index < maxProbes; index += 1) {
    if (!driver) break;
    if (!(await admissionOpen())) break;
    const [claim] = await repository.claimDue(1, leaseMs);
    if (!claim) break;
    claimed += 1;
    let result: FreeModelQualificationResult;
    if (!stillFreeAtSource(claim.modelId, claim.provider, discovery)) {
      // No run: a probe would spend the house key on a model that is paid now.
      result = { classification: "model_failure", latencyMs: 0, httpStatus: null, errorCode: "policy_rejected" };
    } else try {
      result = await driver.qualify({
        modelId: claim.modelId,
        claimToken: claim.claimToken,
      });
    } catch {
      result = {
        classification: "system_failure",
        latencyMs: 0,
        httpStatus: null,
        errorCode: "transport_error",
      };
    }
    const persisted = await repository.recordResult({
      modelId: claim.modelId,
      claimToken: claim.claimToken,
      outcome: result.classification === "success"
        ? "success"
        : result.classification === "model_failure"
          ? "failure"
          : "system_failure",
      nextProbeAt: nextProbeAtForResult(claim, result, nowMs()),
      httpStatus: result.httpStatus,
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
    });
    if (persisted) recorded += 1;
    // Only a failure that would hit every probe pauses the lane: the account
    // rejected or throttled. One provider's outage or a slow answer keeps its
    // own model on the system-failure retry and the batch moves on.
    if (result.classification === "system_failure" && laneWideFailure(result.errorCode)) {
      systemFailure = true;
      break;
    }
  }

  if (systemFailure) {
    const published = await repository.publish({ modelIds: [], systemFailure: true });
    return {
      status: "completed",
      discovered,
      claimed,
      recorded,
      systemFailure,
      publishOutcome: published.outcome,
    };
  }

  const registry = await repository.loadRegistry();
  const desired = desiredPublishedLane(registry, discovery);
  if (sameLane(registry.state?.currentModelIds ?? [], desired)) {
    return {
      status: "completed",
      discovered,
      claimed,
      recorded,
      systemFailure: false,
      publishOutcome: "unchanged",
    };
  }
  const published = await repository.publish({
    modelIds: desired,
    allowEmpty: true,
    ...(registry.state ? { expectedGeneration: registry.state.generation } : {}),
  });
  deps.adoptPublishedLane?.(published.state);
  return {
    status: "completed",
    discovered,
    claimed,
    recorded,
    systemFailure: false,
    publishOutcome: published.outcome,
  };
}

export async function hydrateFreeModelLaneFromRegistry(): Promise<boolean> {
  const state = await loadCurrentFreeModelLane();
  if (!state) return false;
  freeModelLaneCache.adoptRegistryLane(state.currentModelIds);
  return true;
}

export interface FreeModelRegistryHydratorDeps {
  readonly hydrate?: () => Promise<boolean>;
  readonly schedule?: (
    run: () => void,
    intervalMs: number,
  ) => { unref?: () => void };
}

/** Every backend replica refreshes the DB-published generation independently;
 * the qualifying worker may run elsewhere. Postgres remains catalog truth. */
export function startFreeModelRegistryHydrator(
  deps: FreeModelRegistryHydratorDeps = {},
): void {
  const hydrate = deps.hydrate ?? hydrateFreeModelLaneFromRegistry;
  const schedule = deps.schedule ?? ((run, intervalMs) => setInterval(run, intervalMs));
  const run = (): void => {
    void hydrate().catch((error) => {
      console.warn(
        "[free-model-registry] refresh failed:",
        error instanceof Error ? error.message : "unknown",
      );
    });
  };
  const timer = schedule(run, 60_000);
  timer.unref?.();
}

export interface FreeModelQualifierTick {
  readonly result: Promise<FreeModelQualifierTickResult>;
  /** Settles once this tick's catalog phase finished; null when the tick ended
   * before reaching it (deployment admission closed, or it failed). */
  readonly discovery: Promise<CatalogDiscoveryResult | null>;
}

export type FreeModelRefreshAttempt =
  | { readonly admitted: true; readonly tick: FreeModelQualifierTick }
  | { readonly admitted: false; readonly retryAfterMs: number };

export interface FreeModelQualifier {
  /** Run a tick now, or join the one already running. */
  readonly tick: () => FreeModelQualifierTick;
  /** The picker's "Refresh free models": a tick behind the manual cool-down. */
  readonly refresh: (nowMs?: number) => FreeModelRefreshAttempt;
}

export interface FreeModelQualifierWorkerDeps
  extends Omit<FreeModelQualifierTickDeps, "maxProbes" | "leaseMs" | "onDiscovered"> {
  readonly schedule?: (run: () => void, firstMs: number, everyMs: number) => void;
}

/** Null when the kill switch is set; the manual refresh then reports it. */
export function startFreeModelQualifierWorker(
  deps: FreeModelQualifierWorkerDeps,
  env: Readonly<Record<string, string | undefined>> = process.env,
): FreeModelQualifier | null {
  if (!freeModelQualifierEnabled(env)) return null;
  const intervalMin = boundedInteger(
    env.FREE_MODEL_QUALIFIER_INTERVAL_MIN,
    QUALIFIER_INTERVAL_MIN,
    5,
    1_440,
  );
  const maxProbes = boundedInteger(
    env.FREE_MODEL_QUALIFIER_MAX_PROBES_PER_TICK,
    QUALIFIER_MAX_PROBES_PER_TICK,
    1,
    4,
  );
  const { schedule: scheduleDep, ...tickDeps } = deps;
  let active: FreeModelQualifierTick | null = null;
  let refreshedAt = 0;
  const tick = (): FreeModelQualifierTick => {
    if (active) return active;
    const discovered = Promise.withResolvers<CatalogDiscoveryResult | null>();
    // The slot clears before anyone awaiting the result resumes, so the next
    // tick() after an awaited result starts fresh instead of joining a stale one.
    const result = runFreeModelQualifierTick({
      ...tickDeps,
      maxProbes,
      leaseMs: QUALIFIER_LEASE_MS,
      onDiscovered: discovered.resolve,
    }).finally(() => {
      discovered.resolve(null);
      active = null;
    });
    const current: FreeModelQualifierTick = { result, discovery: discovered.promise };
    active = current;
    void result.then(
      (outcome) => {
        console.log(
          `[free-model-qualifier] status=${outcome.status} discovered=${outcome.discovered} ` +
            `claimed=${outcome.claimed} recorded=${outcome.recorded} publish=${outcome.publishOutcome}`,
        );
      },
      (error: unknown) => {
        console.warn(
          "[free-model-qualifier] tick failed:",
          error instanceof Error ? error.message : "unknown",
        );
      },
    );
    return current;
  };
  const refresh = (nowMs = Date.now()): FreeModelRefreshAttempt => {
    const sinceRefresh = nowMs - refreshedAt;
    if (refreshedAt > 0 && sinceRefresh < MANUAL_REFRESH_COOLDOWN_MS) {
      return { admitted: false, retryAfterMs: MANUAL_REFRESH_COOLDOWN_MS - sinceRefresh };
    }
    refreshedAt = nowMs;
    return { admitted: true, tick: tick() };
  };
  const schedule = scheduleDep ?? ((run, firstMs, everyMs) => {
    setTimeout(run, firstMs).unref();
    setInterval(run, everyMs).unref();
  });
  schedule(() => void tick(), QUALIFIER_BOOT_DELAY_MS, intervalMin * 60_000);
  return { tick, refresh };
}

export interface ManualRefreshResponse {
  readonly status: 200 | 202 | 429 | 502 | 503;
  readonly body: Record<string, unknown>;
}

/**
 * The manual refresh route's decision without HTTP. Bounded: the request never
 * outlives waitMs even when the tick is still waiting on the admission lock;
 * the tick itself keeps running and publishes on its own.
 */
export async function respondToManualRefresh(
  qualifier: FreeModelQualifier | null,
  options: { readonly nowMs?: number; readonly waitMs?: number } = {},
): Promise<ManualRefreshResponse> {
  if (!qualifier) return { status: 503, body: { error: "qualifier_off" } };
  const attempt = qualifier.refresh(options.nowMs);
  if (!attempt.admitted) {
    return { status: 429, body: { error: "rate_limited", retry_after_ms: attempt.retryAfterMs } };
  }
  let discovery: CatalogDiscoveryResult | null;
  try {
    discovery = await awaitWithSignal(
      () => attempt.tick.discovery,
      AbortSignal.timeout(options.waitMs ?? MANUAL_REFRESH_WAIT_MS),
    );
  } catch {
    return { status: 202, body: { refreshed: false, stale: true, reason: "pending" } };
  }
  if (!discovery) {
    const outcome = await attempt.tick.result.catch(() => null);
    const reason = outcome?.status === "skipped_admission_closed"
      ? "admission_closed"
      : outcome?.status === "skipped_admission_unavailable"
        ? "admission_unavailable"
        : "tick_failed";
    return { status: 502, body: { refreshed: false, stale: true, reason } };
  }
  if (!discovery.ok) {
    return { status: 502, body: { refreshed: false, stale: true, reason: discovery.errorCode } };
  }
  return {
    status: 200,
    body: { refreshed: true, stale: false, discovered: discovery.candidates.length },
  };
}
