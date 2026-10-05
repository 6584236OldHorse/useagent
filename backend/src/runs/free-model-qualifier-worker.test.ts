import { describe, expect, test } from "bun:test";
import type {
  FreeModelCandidateRow,
  FreeModelRegistryStateRow,
} from "../db/schema";
import type { ClaimedFreeModelCandidate } from "./free-model-registry-repo";
import type { FreeModelQualificationResult } from "./free-model-qualification-driver";
import {
  desiredPublishedLane,
  fetchOpenRouterFreeModelCandidates,
  freeModelQualifierEnabled,
  respondToManualRefresh,
  runFreeModelQualifierTick,
  startFreeModelQualifierWorker,
  startFreeModelRegistryHydrator,
  type CatalogDiscoveryResult,
  type FreeModelQualifierRepository,
} from "./free-model-qualifier-worker";

const NOW = 1_800_000_000_000;

function candidate(
  modelId: string,
  overrides: Partial<FreeModelCandidateRow> = {},
): FreeModelCandidateRow {
  const now = new Date(NOW);
  return {
    modelId,
    provider: "openrouter",
    source: "test",
    state: "pending",
    advertised: false,
    everQualified: false,
    successStreak: 0,
    failureStreak: 0,
    attemptCount: 0,
    nextProbeAt: now,
    claimToken: null,
    claimExpiresAt: null,
    lastClaimedAt: null,
    lastProbeAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    qualifiedAt: null,
    lastOutcome: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function registryState(currentModelIds: string[]): FreeModelRegistryStateRow {
  const now = new Date(NOW);
  return {
    lane: "opencode_free",
    generation: 1,
    currentModelIds,
    lastGoodModelIds: currentModelIds,
    lastPublishOutcome: "published",
    lastPublishAt: now,
    probeBudgetDay: "2027-01-15",
    dailyProbeBudget: 24,
    probesClaimedToday: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function claim(row: FreeModelCandidateRow): ClaimedFreeModelCandidate {
  return {
    modelId: row.modelId,
    provider: row.provider,
    state: row.state,
    successStreak: row.successStreak,
    failureStreak: row.failureStreak,
    everQualified: row.everQualified,
    claimToken: crypto.randomUUID(),
    claimExpiresAt: new Date(NOW + 60_000),
  };
}

function fakeRepository(input: {
  state: FreeModelRegistryStateRow;
  candidates: FreeModelCandidateRow[];
  claims?: ClaimedFreeModelCandidate[];
}) {
  const claims = [...(input.claims ?? [])];
  const records: Parameters<FreeModelQualifierRepository["recordResult"]>[0][] = [];
  const publishes: Parameters<FreeModelQualifierRepository["publish"]>[0][] = [];
  const repository: FreeModelQualifierRepository = {
    upsertDiscovered: async (discovered) => discovered.length,
    claimDue: async () => claims.splice(0, 1),
    recordResult: async (result) => {
      records.push(result);
      const row = input.candidates.find((item) => item.modelId === result.modelId);
      if (row && result.outcome === "success") {
        row.successStreak += 1;
        row.failureStreak = 0;
        if (row.successStreak >= 2) {
          row.state = "qualified";
          row.everQualified = true;
        }
      } else if (row && result.outcome === "failure") {
        row.failureStreak += 1;
        row.successStreak = 0;
        if (row.failureStreak >= 2) row.state = "disqualified";
      }
      return true;
    },
    loadRegistry: async () => ({ state: input.state, candidates: input.candidates }),
    publish: async (publishInput) => {
      publishes.push(publishInput);
      if (publishInput.systemFailure) {
        return {
          outcome: "preserved_system_failure" as const,
          state: { ...input.state, lastPublishOutcome: "preserved_system_failure" as const },
        };
      }
      if (publishInput.modelIds.length === 0 && !publishInput.allowEmpty) {
        return {
          outcome: "preserved_empty" as const,
          state: { ...input.state, lastPublishOutcome: "preserved_empty" as const },
        };
      }
      input.state = {
        ...input.state,
        generation: input.state.generation + 1,
        currentModelIds: [...publishInput.modelIds],
        lastGoodModelIds: publishInput.modelIds.length > 0
          ? [...publishInput.modelIds]
          : input.state.lastGoodModelIds,
      };
      return { outcome: "published" as const, state: input.state };
    },
  };
  return { repository, records, publishes };
}

function discovery(...ids: string[]) {
  return async () => ({
    ok: true as const,
    candidates: ids.map((id, index) => ({ id, contextLength: 200_000 - index })),
  });
}

function driver(result: FreeModelQualificationResult) {
  const requests: string[] = [];
  return {
    requests,
    driver: {
      qualify: async ({ modelId }: { modelId: string }) => {
        requests.push(modelId);
        return result;
      },
    },
  };
}

const openAdmission = async () => ({
  open: true,
  operationId: "test",
  actor: "test",
  reason: "test",
  changedAt: new Date(NOW).toISOString(),
});

describe("free-model qualifier worker", () => {
  test("the qualifier is on by default with one kill switch", () => {
    expect(freeModelQualifierEnabled({})).toBe(true);
    expect(freeModelQualifierEnabled({ FREE_MODEL_QUALIFIER: "on" })).toBe(true);
    expect(freeModelQualifierEnabled({ FREE_MODEL_QUALIFIER: "off" })).toBe(false);
    expect(freeModelQualifierEnabled({ FREE_MODEL_QUALIFIER_ENABLED: "0" })).toBe(true);
    expect(startFreeModelQualifierWorker(
      { driver: null, schedule: () => {} },
      { FREE_MODEL_QUALIFIER: "off" },
    )).toBeNull();
  });

  test("registry hydration schedules on every replica", () => {
    let scheduled: (() => void) | null = null;
    let intervalMs = 0;
    let unrefCalled = false;
    const deps = {
      hydrate: async () => true,
      schedule: (run: () => void, interval: number) => {
        scheduled = run;
        intervalMs = interval;
        return { unref: () => { unrefCalled = true; } };
      },
    };
    startFreeModelRegistryHydrator(deps);
    expect(scheduled).not.toBeNull();
    expect(intervalMs).toBe(60_000);
    expect(unrefCalled).toBe(true);
  });

  test("catalog fetch classifies provider failures without reading response bodies", async () => {
    await expect(fetchOpenRouterFreeModelCandidates(async () =>
      new Response("secret upstream body", { status: 503 })
    )).resolves.toEqual({
      ok: false,
      errorCode: "provider_capacity",
      httpStatus: 503,
    });
    await expect(fetchOpenRouterFreeModelCandidates(async () =>
      new Response(JSON.stringify({
        data: [{
          id: "vendor/new:free",
          context_length: 100_000,
          supported_parameters: ["tools"],
        }],
      }), { status: 200 })
    )).resolves.toEqual({
      ok: true,
      candidates: [{ id: "vendor/new:free", contextLength: 100_000 }],
    });
  });

  test("does no catalog or agent work while deployment admission is closed", async () => {
    const seed = candidate("seed:free", { state: "qualified", everQualified: true });
    const fake = fakeRepository({ state: registryState([seed.modelId]), candidates: [seed] });
    let discovered = false;
    const agent = driver({
      classification: "success",
      latencyMs: 10,
      httpStatus: 200,
      errorCode: null,
    });
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: async () => ({
        open: false,
        operationId: "deploy",
        actor: "release",
        reason: "deployment",
        changedAt: new Date().toISOString(),
      }),
      discover: async () => {
        discovered = true;
        return { ok: false, errorCode: "unknown", httpStatus: null };
      },
    });
    expect(result.status).toBe("skipped_admission_closed");
    expect(discovered).toBe(false);
    expect(agent.requests).toEqual([]);
    expect(fake.publishes).toEqual([]);
  });

  test("promotes a repeatably successful discovered model and publishes atomically", async () => {
    const seed = candidate("seed:free", {
      state: "qualified",
      everQualified: true,
      advertised: true,
      successStreak: 2,
    });
    const fresh = candidate("vendor/fresh:free", { successStreak: 1 });
    const fake = fakeRepository({
      state: registryState([seed.modelId]),
      candidates: [seed, fresh],
      claims: [claim(fresh)],
    });
    const agent = driver({
      classification: "success",
      latencyMs: 12,
      httpStatus: 200,
      errorCode: null,
    });
    const adopted: string[][] = [];
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: openAdmission,
      discover: discovery(seed.modelId, fresh.modelId),
      nowMs: () => NOW,
      adoptPublishedLane: (state) => adopted.push(state.currentModelIds),
    });
    expect(result).toMatchObject({
      status: "completed",
      claimed: 1,
      recorded: 1,
      publishOutcome: "published",
    });
    expect(agent.requests).toEqual([fresh.modelId]);
    expect(fake.records[0]).toMatchObject({ outcome: "success", errorCode: null });
    expect(fake.publishes).toEqual([{
      modelIds: [seed.modelId, fresh.modelId],
      allowEmpty: true,
      expectedGeneration: 1,
    }]);
    expect(adopted).toEqual([[seed.modelId, fresh.modelId]]);
  });

  test("one partial catalog response cannot evict a currently qualified model", () => {
    const first = candidate("vendor/current-a:free", {
      state: "qualified",
      everQualified: true,
    });
    const temporarilyMissing = candidate("vendor/current-b:free", {
      state: "qualified",
      everQualified: true,
    });
    expect(desiredPublishedLane(
      {
        state: registryState([first.modelId, temporarilyMissing.modelId]),
        candidates: [first, temporarilyMissing],
      },
      [{ id: first.modelId, contextLength: 100_000 }],
    )).toEqual([first.modelId, temporarilyMissing.modelId]);
  });

  test("account-wide failure stops the batch and preserves last-good", async () => {
    const first = candidate("vendor/first:free");
    const second = candidate("vendor/second:free");
    const fake = fakeRepository({
      state: registryState(["seed:free"]),
      candidates: [first, second],
      claims: [claim(first), claim(second)],
    });
    const agent = driver({
      classification: "system_failure",
      latencyMs: 20,
      httpStatus: 401,
      errorCode: "authentication_failed",
    });
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: openAdmission,
      discover: discovery(first.modelId, second.modelId),
      nowMs: () => NOW,
      maxProbes: 4,
    });
    expect(agent.requests).toEqual([first.modelId]);
    expect(fake.records[0]).toMatchObject({ outcome: "system_failure" });
    expect(fake.publishes).toEqual([{ modelIds: [], systemFailure: true }]);
    expect(result).toMatchObject({
      systemFailure: true,
      claimed: 1,
      publishOutcome: "preserved_system_failure",
    });
  });

  test("second model failure removes the quarantined final model from the current lane", async () => {
    const failing = candidate("vendor/failing:free", {
      state: "qualified",
      everQualified: true,
      advertised: true,
      failureStreak: 1,
    });
    const fake = fakeRepository({
      state: registryState([failing.modelId]),
      candidates: [failing],
      claims: [claim(failing)],
    });
    const agent = driver({
      classification: "model_failure",
      latencyMs: 30,
      httpStatus: 403,
      errorCode: "hosted_app_restricted",
    });
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: openAdmission,
      discover: discovery(failing.modelId),
      nowMs: () => NOW,
    });
    expect(failing.state).toBe("disqualified");
    expect(fake.records[0]?.nextProbeAt.getTime()).toBe(NOW + 60 * 60_000);
    expect(fake.publishes).toEqual([{
      modelIds: [],
      allowEmpty: true,
      expectedGeneration: 1,
    }]);
    expect(result.publishOutcome).toBe("published");
    await expect(fake.repository.loadRegistry()).resolves.toMatchObject({
      state: {
        currentModelIds: [],
        lastGoodModelIds: [failing.modelId],
      },
    });
  });

  test("catalog-wide failure never starts an agent and preserves the lane", async () => {
    const fake = fakeRepository({ state: registryState(["seed:free"]), candidates: [] });
    const agent = driver({
      classification: "success",
      latencyMs: 1,
      httpStatus: 200,
      errorCode: null,
    });
    const result = await runFreeModelQualifierTick({
      driver: agent.driver,
      repository: fake.repository,
      admission: openAdmission,
      discover: async () => ({
        ok: false,
        errorCode: "provider_capacity",
        httpStatus: 503,
      }),
    });
    expect(agent.requests).toEqual([]);
    expect(fake.publishes).toEqual([{ modelIds: [], systemFailure: true }]);
    expect(result.status).toBe("catalog_failure");
  });
  test("without an organization for probe runs the tick discovers and republishes but never probes", async () => {
    const stale = candidate("vendor/stale:free", {
      state: "qualified",
      everQualified: true,
      successStreak: 2,
    });
    const state = registryState(["vendor/stale:free", "vendor/gone:free"]);
    const { repository, records, publishes } = fakeRepository({
      state,
      candidates: [stale, candidate("vendor/pending:free")],
      claims: [claim(candidate("vendor/pending:free"))],
    });
    const result = await runFreeModelQualifierTick({
      driver: null,
      repository,
      discover: discovery("vendor/stale:free", "vendor/pending:free"),
      admission: openAdmission,
      nowMs: () => NOW,
    });
    expect(result.status).toBe("completed");
    expect(result.discovered).toBe(2);
    expect(result.claimed).toBe(0);
    expect(records).toHaveLength(0);
    // The lane still drops a model whose candidate row is no longer qualified.
    expect(publishes).toHaveLength(1);
    expect(publishes[0]?.modelIds).toEqual(["vendor/stale:free"]);
  });

  test("the discovery phase settles before the first probe starts", async () => {
    const pending = candidate("vendor/pending:free");
    const { repository } = fakeRepository({
      state: registryState([]),
      candidates: [pending],
      claims: [claim(pending)],
    });
    const gate = Promise.withResolvers<void>();
    let probed = false;
    const worker = startFreeModelQualifierWorker({
      driver: {
        qualify: async () => {
          probed = true;
          await gate.promise;
          return { classification: "success", latencyMs: 5, httpStatus: 200, errorCode: null };
        },
      },
      repository,
      discover: discovery("vendor/pending:free"),
      admission: openAdmission,
      nowMs: () => NOW,
      schedule: () => {},
    }, {});
    if (!worker) throw new Error("expected the worker");
    const tick = worker.tick();
    const discovered = await tick.discovery;
    expect(discovered?.ok).toBe(true);
    expect(discovered && discovered.ok ? discovered.candidates.map((c) => c.id) : []).toEqual([
      "vendor/pending:free",
    ]);
    // Joining while the probe runs returns the same tick.
    expect(worker.tick()).toBe(tick);
    gate.resolve();
    const result = await tick.result;
    expect(probed).toBe(true);
    expect(result.claimed).toBe(1);
    // A later call starts a fresh tick.
    expect(worker.tick()).not.toBe(tick);
  });

  test("the manual refresh runs a tick behind a process-wide cool-down", async () => {
    const { repository } = fakeRepository({ state: registryState([]), candidates: [] });
    let discoveries = 0;
    const discover = async (): Promise<CatalogDiscoveryResult> => {
      discoveries += 1;
      return { ok: true, candidates: [] };
    };
    const worker = startFreeModelQualifierWorker({
      driver: null,
      repository,
      discover,
      admission: openAdmission,
      nowMs: () => NOW,
      schedule: () => {},
    }, {});
    if (!worker) throw new Error("expected the worker");
    const first = worker.refresh(NOW);
    expect(first.admitted).toBe(true);
    if (!first.admitted) return;
    await first.tick.result;
    expect(discoveries).toBe(1);

    const repeat = worker.refresh(NOW + 5_000);
    expect(repeat.admitted).toBe(false);
    if (repeat.admitted) return;
    expect(repeat.retryAfterMs).toBe(25_000);
    expect(discoveries).toBe(1);

    const later = worker.refresh(NOW + 30_000);
    expect(later.admitted).toBe(true);
    if (!later.admitted) return;
    await later.tick.result;
    expect(discoveries).toBe(2);
  });

  test("a tick that ends before discovery settles the discovery promise with null", async () => {
    const { repository } = fakeRepository({ state: registryState([]), candidates: [] });
    const worker = startFreeModelQualifierWorker({
      driver: null,
      repository,
      discover: discovery(),
      admission: async () => ({ ...(await openAdmission()), open: false }),
      nowMs: () => NOW,
      schedule: () => {},
    }, {});
    if (!worker) throw new Error("expected the worker");
    const tick = worker.tick();
    expect(await tick.discovery).toBeNull();
    expect((await tick.result).status).toBe("skipped_admission_closed");
  });
  test("the manual refresh answer is bounded and honest in every state", async () => {
    expect(await respondToManualRefresh(null)).toEqual({
      status: 503,
      body: { error: "qualifier_off" },
    });

    const { repository } = fakeRepository({ state: registryState([]), candidates: [] });
    const working = startFreeModelQualifierWorker({
      driver: null,
      repository,
      discover: discovery("vendor/new:free"),
      admission: openAdmission,
      nowMs: () => NOW,
      schedule: () => {},
    }, {});
    if (!working) throw new Error("expected the worker");
    expect(await respondToManualRefresh(working, { nowMs: NOW })).toEqual({
      status: 200,
      body: { refreshed: true, stale: false, discovered: 1 },
    });
    expect(await respondToManualRefresh(working, { nowMs: NOW + 1_000 })).toEqual({
      status: 429,
      body: { error: "rate_limited", retry_after_ms: 29_000 },
    });

    const failing = startFreeModelQualifierWorker({
      driver: null,
      repository,
      discover: async () => ({ ok: false, errorCode: "rate_limited", httpStatus: 429 }),
      admission: openAdmission,
      nowMs: () => NOW,
      schedule: () => {},
    }, {});
    if (!failing) throw new Error("expected the worker");
    expect(await respondToManualRefresh(failing, { nowMs: NOW })).toEqual({
      status: 502,
      body: { refreshed: false, stale: true, reason: "rate_limited" },
    });

    const closed = startFreeModelQualifierWorker({
      driver: null,
      repository,
      discover: discovery(),
      admission: async () => ({ ...(await openAdmission()), open: false }),
      nowMs: () => NOW,
      schedule: () => {},
    }, {});
    if (!closed) throw new Error("expected the worker");
    expect(await respondToManualRefresh(closed, { nowMs: NOW })).toEqual({
      status: 502,
      body: { refreshed: false, stale: true, reason: "admission_closed" },
    });

    // The admission read is blocked (a deployment holds the lock): the request
    // still answers within its wait, and the tick keeps running behind it.
    const gate = Promise.withResolvers<void>();
    let catalogCalls = 0;
    const blocked = startFreeModelQualifierWorker({
      driver: null,
      repository,
      discover: async () => {
        catalogCalls += 1;
        return { ok: true, candidates: [] };
      },
      admission: async () => {
        await gate.promise;
        return openAdmission();
      },
      nowMs: () => NOW,
      schedule: () => {},
    }, {});
    if (!blocked) throw new Error("expected the worker");
    expect(await respondToManualRefresh(blocked, { nowMs: NOW, waitMs: 20 })).toEqual({
      status: 202,
      body: { refreshed: false, stale: true, reason: "pending" },
    });
    expect(catalogCalls).toBe(0);
    gate.resolve();
    await blocked.tick().result;
    expect(catalogCalls).toBe(1);
  });
});
