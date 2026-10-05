import { afterEach, describe, expect, test } from "bun:test";
import {
  discoverOpenCodeZenFreeModels,
  discoverOpenRouterFreeModels,
  FREE_MODEL_LANE_SEED,
  FreeModelLaneCache,
  freeModelLaneCache,
} from "./free-model-lane";
import {
  allowedModelsForEngine,
  isModelAllowedForEngine,
  isPersistedModelAllowedForEngine,
} from "./model-policy";
import { engineModelsForReadyEngines } from "./engine-readiness";

function entry(id: string, contextLength: number, params: string[] = ["tools", "temperature"]) {
  return { id, context_length: contextLength, supported_parameters: params };
}

const FRESH_MODEL = "vendor/newly-qualified:free";

describe("discoverOpenRouterFreeModels (catalog filter)", () => {
  test("keeps tool-capable free ids with usable context, largest first, and nothing else", () => {
    expect(discoverOpenRouterFreeModels({
      data: [
        entry("vendor/new-agent:free", 200_000),
        entry("vendor/bigger-agent:free", 1_000_000),
        entry("vendor/no-tools:free", 200_000, ["temperature"]),
        entry("vendor/paid", 200_000),
        entry("vendor/tiny-context:free", 32_000),
        entry("opencode/big-pickle:free", 500_000), // a Zen lane id shape, never OpenRouter's
        { id: "vendor/string-context:free", context_length: "big", supported_parameters: ["tools"] },
        { context_length: 100_000, supported_parameters: ["tools"] },
        null,
        "garbage",
      ],
    })).toEqual([
      { id: "vendor/bigger-agent:free", contextLength: 1_000_000, provider: "openrouter" },
      { id: "vendor/new-agent:free", contextLength: 200_000, provider: "openrouter" },
    ]);
  });

  test("returns [] for empty or malformed payloads", () => {
    expect(discoverOpenRouterFreeModels({ data: [] })).toEqual([]);
    expect(discoverOpenRouterFreeModels({})).toEqual([]);
    expect(discoverOpenRouterFreeModels({ data: "nope" })).toEqual([]);
    expect(discoverOpenRouterFreeModels([])).toEqual([]);
    expect(discoverOpenRouterFreeModels(null)).toEqual([]);
    expect(discoverOpenRouterFreeModels("html error page")).toEqual([]);
  });

  test("caps discovery", () => {
    const many = Array.from({ length: 120 }, (_, index) => entry(`vendor/model-${index}:free`, 2_000_000 - index));
    expect(discoverOpenRouterFreeModels({ data: many })).toHaveLength(100);
    expect(discoverOpenRouterFreeModels({ data: many }, 3)).toHaveLength(3);
  });
});

describe("discoverOpenCodeZenFreeModels (models.dev catalog)", () => {
  const zen = (id: string, overrides: Record<string, unknown> = {}) => [id, {
    cost: { input: 0, output: 0 },
    tool_call: true,
    limit: { context: 262_144, output: 32_768 },
    ...overrides,
  }] as const;

  test("keeps free, tool-capable, current Zen models under our lane id, largest context first", () => {
    const catalog = {
      opencode: {
        models: Object.fromEntries([
          zen("big-pickle", { limit: { context: 200_000, output: 32_768 } }),
          zen("nemotron-3-ultra-free", { limit: { context: 1_000_000, output: 32_768 } }),
          zen("glm-5-free", { status: "deprecated" }),
          zen("claude-sonnet-5", { cost: { input: 2, output: 10 } }),
          zen("cheap-input", { cost: { input: 0, output: 0.5 } }),
          zen("no-tools-free", { tool_call: false }),
          zen("tiny-free", { limit: { context: 32_000, output: 4_096 } }),
          zen("weird id/free", {}),
          zen("responses-api-free", { provider: { npm: "@ai-sdk/openai" } }),
          zen("explicit-compatible-free", { provider: { npm: "@ai-sdk/openai-compatible" }, limit: { context: 150_000, output: 8_192 } }),
          ["missing-cost", { tool_call: true, limit: { context: 262_144 } }],
        ]),
      },
      openrouter: { models: Object.fromEntries([zen("router-free")]) },
    };
    expect(discoverOpenCodeZenFreeModels(catalog)).toEqual([
      { id: "opencode/nemotron-3-ultra-free:free", contextLength: 1_000_000, provider: "opencode" },
      { id: "opencode/big-pickle:free", contextLength: 200_000, provider: "opencode" },
      { id: "opencode/explicit-compatible-free:free", contextLength: 150_000, provider: "opencode" },
    ]);
  });

  test("returns [] for empty or malformed payloads", () => {
    expect(discoverOpenCodeZenFreeModels({})).toEqual([]);
    expect(discoverOpenCodeZenFreeModels({ opencode: {} })).toEqual([]);
    expect(discoverOpenCodeZenFreeModels({ opencode: { models: [] } })).toEqual([]);
    expect(discoverOpenCodeZenFreeModels(null)).toEqual([]);
    expect(discoverOpenCodeZenFreeModels("html error page")).toEqual([]);
  });
});

describe("FreeModelLaneCache", () => {
  test("boots on the curated seed and swaps to the published generation", () => {
    const cache = new FreeModelLaneCache();
    expect(cache.lane()).toEqual([...FREE_MODEL_LANE_SEED]);
    expect(cache.isAllowed(FREE_MODEL_LANE_SEED[0])).toBe(true);
    expect(cache.isAllowed(FRESH_MODEL)).toBe(false);

    cache.adoptRegistryLane([` ${FRESH_MODEL} `, FRESH_MODEL, ""]);
    expect(cache.lane()).toEqual([FRESH_MODEL]);
    expect(cache.isAllowed(FRESH_MODEL)).toBe(true);
    // New work is judged by the published lane alone.
    expect(cache.isAllowed(FREE_MODEL_LANE_SEED[0])).toBe(false);
  });

  test("an empty generation is adopted as such, and reset restores the seed", () => {
    const cache = new FreeModelLaneCache();
    cache.adoptRegistryLane([]);
    expect(cache.lane()).toEqual([]);
    expect(cache.isAllowed(FREE_MODEL_LANE_SEED[0])).toBe(false);
    cache.reset();
    expect(cache.lane()).toEqual([...FREE_MODEL_LANE_SEED]);
    expect(cache.isAllowed(FREE_MODEL_LANE_SEED[0])).toBe(true);
  });
});

describe("published lane -> policy and manifest integration", () => {
  afterEach(() => {
    freeModelLaneCache.reset();
  });

  test("an adopted generation is accepted by policy and advertised by the manifest", () => {
    freeModelLaneCache.adoptRegistryLane([FRESH_MODEL]);

    expect(allowedModelsForEngine("opencode", {})).toContain(FRESH_MODEL);
    expect(isModelAllowedForEngine("opencode", FRESH_MODEL)).toBe(true);
    // A rotation removes a seed model from new work but never strands a run
    // that already stored it.
    expect(allowedModelsForEngine("opencode", {})).not.toContain(FREE_MODEL_LANE_SEED[0]);
    expect(isModelAllowedForEngine("opencode", FREE_MODEL_LANE_SEED[0])).toBe(false);
    expect(isPersistedModelAllowedForEngine("opencode", FREE_MODEL_LANE_SEED[0])).toBe(true);
    // The lane stays OpenCode-only.
    expect(isModelAllowedForEngine("pi", FRESH_MODEL)).toBe(false);

    const models = engineModelsForReadyEngines({
      NODE_ENV: "production",
      USEAGENT_DEV_MODE: "false",
      GATEWAY_PUBLIC_URL: "https://gateway.example.test",
      PROVIDER_GATEWAY_SECRET: "free-lane-test-provider-gateway-secret-0123456789",
      ENGINE_READINESS_OPENCODE: "verified",
      PROVIDER_HEALTH_ANTHROPIC: "verified",
      PROVIDER_HEALTH_OPENAI: "verified",
      PROVIDER_HEALTH_OPENROUTER: "verified",
    });
    expect(models.opencode).toContain(FRESH_MODEL);
  });
});
