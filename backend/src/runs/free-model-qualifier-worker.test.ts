import { describe, expect, test } from "bun:test";
import type {
  FreeModelCandidateRow,
  FreeModelRegistryStateRow,
} from "../db/schema";
import type { ClaimedFreeModelCandidate } from "./free-model-registry-repo";
import {
  FREE_MODEL_QUALIFICATION_TIMEOUT_MS,
  type FreeModelQualificationResult,
} from "./free-model-qualification-driver";
import {
  desiredPublishedLane,
  discoverFreeModelCandidates,
  fetchOpenRouterFreeModelCandidates,
  openCodeZenSourceEnabled,
  freeModelQualifierEnabled,
  laneWideFailure,
  QUALIFIER_ADMISSION_WAIT_MS,
  respondToManualRefresh,
  runFreeModelQualifierTick,
  startFreeModelQualifierWorker,
  startFreeModelRegistryHydrator,
  type CatalogDiscoveryResult,
  type FreeModelQualifierRepository,
  QUALIFIER_BOOT_DELAY_MS,
  QUALIFIER_LEASE_MS,
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

function discovered(ids: readonly string[], sources: readonly ("openrouter" | "opencode")[] = ["openrouter"]) {
  return {
    ok: true as const,
    candidates: ids.map((id, index) => ({
      id,
      contextLength: 200_000 - index,
      provider: id.startsWith("opencode/") ? "opencode" as const : "openrouter" as const,
    })),
    sources,
  };
}

function discovery(...ids: string[]) {
  const sources = ids.some((id) => id.startsWith("opencode/"))
    ? ["openrouter", "opencode"] as const
    : ["openrouter"] as const;
  return async () => discovered(ids, sources);
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
      candidates: [{ id: "vendor/new:free", contextLength: 100_000, provider: "openrouter" }],
      sources: ["openrouter"],
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
      discovered([first.modelId]),
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
      return discovered([]);
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
        return discovered([]);
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
  test("an admission read that cannot get its lock ends the tick and frees the slot", async () => {
    const { repository } = fakeRepository({ state: registryState([]), candidates: [] });
    let reads = 0;
    let catalogCalls = 0;
    const worker = startFreeModelQualifierWorker({
      driver: null,
      repository,
      discover: async () => {
        catalogCalls += 1;
        return discovered([]);
      },
      admission: async () => {
        reads += 1;
        if (reads === 1) throw new Error("canceling statement due to lock timeout");
        return openAdmission();
      },
      nowMs: () => NOW,
      schedule: () => {},
    }, {});
    if (!worker) throw new Error("expected the worker");
    expect(await respondToManualRefresh(worker, { nowMs: NOW })).toEqual({
      status: 502,
      body: { refreshed: false, stale: true, reason: "admission_unavailable" },
    });
    expect(catalogCalls).toBe(0);
    // The slot is free: the next tick reads admission again and proceeds.
    const next = worker.tick();
    expect((await next.result).status).toBe("completed");
    expect(catalogCalls).toBe(1);
  });
  test("an admission read that never answers ends the tick on the tick's own clock", async () => {
    const { repository } = fakeRepository({ state: registryState([]), candidates: [] });
    const never = Promise.withResolvers<Awaited<ReturnType<typeof openAdmission>>>();
    let reads = 0;
    const worker = startFreeModelQualifierWorker({
      driver: null,
      repository,
      discover: discovery(),
      admission: () => {
        reads += 1;
        return reads === 1 ? never.promise : openAdmission();
      },
      nowMs: () => NOW,
      schedule: () => {},
    }, {});
    if (!worker) throw new Error("expected the worker");
    const started = Date.now();
    const first = worker.tick();
    // QUALIFIER_ADMISSION_WAIT_MS + 1 s is the bound; the test waits for it.
    expect((await first.result).status).toBe("skipped_admission_unavailable");
    expect(Date.now() - started).toBeLessThan(QUALIFIER_ADMISSION_WAIT_MS + 3_000);
    expect((await worker.tick().result).status).toBe("completed");
    never.resolve(await openAdmission());
  }, 15_000);
  test("OpenCode Zen joins discovery only where the deployment can run its models", async () => {
    const openrouterCatalog = { data: [{ id: "vendor/new:free", context_length: 100_000, supported_parameters: ["tools"] }] };
    const zenCatalog = { opencode: { models: { "big-pickle": { cost: { input: 0, output: 0 }, tool_call: true, limit: { context: 200_000 } } } } };
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      if (url.includes("openrouter")) return Response.json(openrouterCatalog);
      return Response.json(zenCatalog);
    };
    expect(openCodeZenSourceEnabled({})).toBe(false);
    expect(openCodeZenSourceEnabled({ OPENCODE_API_KEY: "zen" })).toBe(false);
    expect(openCodeZenSourceEnabled({ OPENCODE_API_KEY: "zen", PROVIDER_HEALTH_OPENCODE: "verified" })).toBe(true);

    const without = await discoverFreeModelCandidates(fetcher, {});
    expect(without.ok && without.candidates.map((c) => c.id)).toEqual(["vendor/new:free"]);
    expect(urls.filter((url) => url.includes("models.dev"))).toHaveLength(0);

    const enabled = { OPENCODE_API_KEY: "zen", PROVIDER_HEALTH_OPENCODE: "verified" };
    const both = await discoverFreeModelCandidates(fetcher, enabled);
    expect(both.ok && both.candidates.map((c) => `${c.provider}:${c.id}`)).toEqual([
      "opencode:opencode/big-pickle:free",
      "openrouter:vendor/new:free",
    ]);

    // Zen's catalog failing costs only this tick's Zen candidates.
    const zenDown = await discoverFreeModelCandidates(async (url: string) =>
      url.includes("openrouter") ? Response.json(openrouterCatalog) : new Response(null, { status: 503 }), enabled);
    expect(zenDown.ok && zenDown.candidates.map((c) => c.id)).toEqual(["vendor/new:free"]);
    // OpenRouter failing is a catalog failure as before.
    const routerDown = await discoverFreeModelCandidates(async () => new Response(null, { status: 503 }), enabled);
    expect(routerDown).toEqual({ ok: false, errorCode: "provider_capacity", httpStatus: 503 });
  });

  test("the published lane caps each source separately", () => {
    const qualified = (modelId: string, provider: string) => candidate(modelId, {
      provider,
      state: "qualified",
      everQualified: true,
      successStreak: 2,
    });
    const routerModels = Array.from({ length: 10 }, (_, i) => `vendor/model-${i}:free`);
    const rows = [
      ...routerModels.map((id) => qualified(id, "openrouter")),
      qualified("opencode/big-pickle:free", "opencode"),
    ];
    const catalog = discovered(rows.map((row) => row.modelId), ["openrouter", "opencode"]);
    const lane = desiredPublishedLane({ state: registryState(routerModels), candidates: rows }, catalog);
    expect(lane).toHaveLength(9);
    expect(lane.slice(0, 8)).toEqual(routerModels.slice(0, 8));
    expect(lane[8]).toBe("opencode/big-pickle:free");
  });
  test("a Zen model missing from a read Zen catalog leaves the lane and is never probed", async () => {
    const promo = candidate("opencode/promo:free", {
      provider: "opencode",
      state: "qualified",
      everQualified: true,
      successStreak: 2,
    });
    const router = candidate("vendor/x:free", { state: "qualified", everQualified: true, successStreak: 2 });
    const { repository, records, publishes } = fakeRepository({
      state: registryState([promo.modelId, router.modelId]),
      candidates: [promo, router],
      claims: [claim(promo)],
    });
    const probe = driver({ classification: "success", latencyMs: 5, httpStatus: 200, errorCode: null });
    const result = await runFreeModelQualifierTick({
      driver: probe.driver,
      repository,
      // The Zen catalog was read and no longer lists promo: repriced or retired.
      discover: async () => discovered([router.modelId], ["openrouter", "opencode"]),
      admission: openAdmission,
      nowMs: () => NOW,
    });
    expect(result.status).toBe("completed");
    expect(probe.requests).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ modelId: promo.modelId, outcome: "failure", errorCode: "policy_rejected" });
    expect(publishes.at(-1)?.modelIds).toEqual([router.modelId]);
  });

  test("a Zen model missing while the Zen catalog was not read keeps its place and its probe", async () => {
    const promo = candidate("opencode/promo:free", {
      provider: "opencode",
      state: "qualified",
      everQualified: true,
      successStreak: 2,
    });
    const { repository, records } = fakeRepository({
      state: registryState([promo.modelId]),
      candidates: [promo],
      claims: [claim(promo)],
    });
    const probe = driver({ classification: "success", latencyMs: 5, httpStatus: 200, errorCode: null });
    const result = await runFreeModelQualifierTick({
      driver: probe.driver,
      repository,
      discover: async () => discovered(["vendor/x:free"], ["openrouter"]),
      admission: openAdmission,
      nowMs: () => NOW,
    });
    expect(result.publishOutcome).toBe("unchanged");
    expect(probe.requests).toEqual([promo.modelId]);
    expect(records[0]).toMatchObject({ modelId: promo.modelId, outcome: "success" });
  });
  test("a Zen catalog with nothing free left is still a read, so every Zen model leaves the lane", async () => {
    const openrouterCatalog = { data: [{ id: "vendor/new:free", context_length: 100_000, supported_parameters: ["tools"] }] };
    const allPaid = { opencode: { models: { promo: { cost: { input: 1, output: 2 }, tool_call: true, limit: { context: 200_000 } } } } };
    const enabled = { OPENCODE_API_KEY: "zen", PROVIDER_HEALTH_OPENCODE: "verified" };
    const read = await discoverFreeModelCandidates(async (url: string) =>
      Response.json(url.includes("openrouter") ? openrouterCatalog : allPaid), enabled);
    expect(read).toEqual({
      ok: true,
      candidates: [{ id: "vendor/new:free", contextLength: 100_000, provider: "openrouter" }],
      sources: ["openrouter", "opencode"],
    });
    // A catalog with no Zen model list at all is not a read: Zen models keep their place.
    const unreadable = await discoverFreeModelCandidates(async (url: string) =>
      Response.json(url.includes("openrouter") ? openrouterCatalog : { other: {} }), enabled);
    expect(unreadable.ok && unreadable.sources).toEqual(["openrouter"]);
  });

  test("a probe batch ending in a system failure cannot keep a repriced Zen model advertised", async () => {
    const promo = candidate("opencode/promo:free", {
      provider: "opencode",
      state: "qualified",
      everQualified: true,
      successStreak: 2,
    });
    const router = candidate("vendor/x:free", { state: "qualified", everQualified: true, successStreak: 2 });
    const { repository, publishes } = fakeRepository({
      state: registryState([promo.modelId, router.modelId]),
      candidates: [promo, router],
      claims: [claim(router)],
    });
    const adopted: string[][] = [];
    const result = await runFreeModelQualifierTick({
      driver: driver({ classification: "system_failure", latencyMs: 5, httpStatus: 401, errorCode: "authentication_failed" }).driver,
      repository,
      discover: async () => discovered([router.modelId], ["openrouter", "opencode"]),
      admission: openAdmission,
      nowMs: () => NOW,
      adoptPublishedLane: (state) => adopted.push([...state.currentModelIds]),
    });
    expect(result.systemFailure).toBe(true);
    // The trim published before the probe; the failure then preserved the trimmed lane.
    expect(publishes.map((p) => p.systemFailure ? "preserved" : p.modelIds.join(","))).toEqual([router.modelId, "preserved"]);
    expect(adopted).toEqual([[router.modelId]]);
    expect((await repository.loadRegistry()).state?.currentModelIds).toEqual([router.modelId]);
  });
  test("the timing fits a real probe: a claim outlives the deadline and the boot tick waits for admission", () => {
    // Production's first probe hit the old three-minute deadline with a cold sandbox.
    expect(FREE_MODEL_QUALIFICATION_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
    expect(QUALIFIER_LEASE_MS).toBeGreaterThan(FREE_MODEL_QUALIFICATION_TIMEOUT_MS);
    // The promote reopens admission about seven seconds after boot.
    expect(QUALIFIER_BOOT_DELAY_MS).toBeGreaterThanOrEqual(30_000);
    let first = 0;
    startFreeModelQualifierWorker({
      driver: null,
      repository: fakeRepository({ state: registryState([]), candidates: [] }).repository,
      discover: discovery(),
      admission: openAdmission,
      schedule: (_run, firstMs) => { first = firstMs; },
    }, {});
    expect(first).toBe(QUALIFIER_BOOT_DELAY_MS);
  });
  test("one provider's outage or timeout keeps its model on retry without pausing the lane", async () => {
    expect(laneWideFailure("authentication_failed")).toBe(true);
    for (const code of ["rate_limited", "provider_capacity", "timeout", "transport_error", "policy_rejected", null] as const) {
      expect(laneWideFailure(code)).toBe(false);
    }
    const first = candidate("vendor/down:free");
    const second = candidate("vendor/fine:free");
    const fake = fakeRepository({
      state: registryState(["seed:free"]),
      candidates: [first, second],
      claims: [claim(first), claim(second)],
    });
    let calls = 0;
    const result = await runFreeModelQualifierTick({
      driver: {
        qualify: async () => {
          calls += 1;
          return calls === 1
            ? { classification: "system_failure", latencyMs: 25_000, httpStatus: 502, errorCode: "provider_capacity" }
            : { classification: "success", latencyMs: 5_000, httpStatus: 200, errorCode: null };
        },
      },
      repository: fake.repository,
      admission: openAdmission,
      discover: discovery(first.modelId, second.modelId),
      nowMs: () => NOW,
      maxProbes: 4,
    });
    expect(calls).toBe(2);
    expect(fake.records.map((r) => r.outcome)).toEqual(["system_failure", "success"]);
    // The lane was not paused: no preserved publish, the tick ended normally.
    expect(fake.publishes.some((p) => p.systemFailure)).toBe(false);
    expect(result).toMatchObject({ systemFailure: false, claimed: 2, recorded: 2 });
  });
});
