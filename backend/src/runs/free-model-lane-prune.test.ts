import { describe, expect, test } from "bun:test";
import type { FreeModelRegistryStateRow } from "../db/schema";
import type { publishFreeModelLane } from "./free-model-registry-repo";
import { fetchOpenRouterCatalogIds, pruneVanishedFreeModels, vanishedFromCatalog } from "./free-model-lane-prune";

const LANE = ["a/one:free", "b/gone:free", "opencode/zen:free", "c/two:free"];
const state = (ids = LANE, generation = 7) =>
  ({ generation, currentModelIds: ids }) as unknown as FreeModelRegistryStateRow;

function harness(catalog: Set<string> | null, ids = LANE) {
  const published: { modelIds: readonly string[]; expectedGeneration?: number }[] = [];
  const adopted: (readonly string[])[] = [];
  const publish = (async (input) => {
    published.push(input);
    return { outcome: "published", state: state([...input.modelIds], 8) };
  }) as typeof publishFreeModelLane;
  const run = () =>
    pruneVanishedFreeModels({
      catalogIds: async () => catalog,
      loadLane: async () => state(ids),
      publish,
      adopt: (lane) => adopted.push(lane),
    });
  return { run, published, adopted };
}

describe("free lane prune", () => {
  test("drops OpenRouter models the catalog no longer lists, keeps Zen, pins the generation", async () => {
    const h = harness(new Set(["a/one:free", "c/two:free", "x/new:free"]));
    expect(await h.run()).toEqual({ outcome: "pruned", removed: ["b/gone:free"], generation: 8 });
    expect(h.published).toEqual([{ modelIds: ["a/one:free", "opencode/zen:free", "c/two:free"], expectedGeneration: 7 }]);
    expect(h.adopted).toEqual([["a/one:free", "opencode/zen:free", "c/two:free"]]);
  });

  test("never adds a model the catalog lists but nobody probed", async () => {
    const h = harness(new Set([...LANE, "x/new:free"]));
    expect(await h.run()).toEqual({ outcome: "unchanged" });
    expect(h.published).toEqual([]);
  });

  test("an unusable catalog read changes nothing", async () => {
    const h = harness(null);
    expect(await h.run()).toEqual({ outcome: "catalog_unavailable" });
    expect(h.published).toEqual([]);
  });

  test("a read that would empty the lane leaves it as is", async () => {
    const h = harness(new Set(["unrelated/model:free"]), ["b/gone:free"]);
    expect(await h.run()).toEqual({ outcome: "kept_last_model" });
    expect(h.published).toEqual([]);
  });

  test("a publish refused for a moved generation propagates and adopts nothing", async () => {
    const adopted: (readonly string[])[] = [];
    const result = pruneVanishedFreeModels({
      catalogIds: async () => new Set(["a/one:free"]),
      loadLane: async () => state(["a/one:free", "b/gone:free"]),
      publish: (async () => {
        throw new Error("free_model_publish_generation_conflict");
      }) as typeof publishFreeModelLane,
      adopt: (lane) => adopted.push(lane),
    });
    await expect(result).rejects.toThrow("free_model_publish_generation_conflict");
    expect(adopted).toEqual([]);
  });

  test("Zen ids are never judged by the OpenRouter catalog", () => {
    expect(vanishedFromCatalog(["opencode/zen:free", "a/x:free"], new Set(["a/x:free"]))).toEqual([]);
  });
});

describe("catalog read", () => {
  const respond = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("returns every listed id when the read holds free models", async () => {
    const ids = await fetchOpenRouterCatalogIds(respond(200, { data: [{ id: "a/one:free" }, { id: "b/paid" }] }));
    expect([...ids!].sort()).toEqual(["a/one:free", "b/paid"]);
  });

  test("an error status, a malformed body, no free model or a thrown fetch is untrusted", async () => {
    expect(await fetchOpenRouterCatalogIds(respond(503, {}))).toBeNull();
    expect(await fetchOpenRouterCatalogIds(respond(200, { models: [] }))).toBeNull();
    expect(await fetchOpenRouterCatalogIds(respond(200, { data: [{ id: "b/paid" }] }))).toBeNull();
    expect(await fetchOpenRouterCatalogIds(async () => { throw new Error("timeout"); })).toBeNull();
  });
});
