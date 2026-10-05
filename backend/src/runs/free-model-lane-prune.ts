import type { FreeModelRegistryStateRow } from "../db/schema";
import { loadCurrentFreeModelLane, publishFreeModelLane } from "./free-model-registry-repo";
import {
  freeModelLaneCache,
  OPENROUTER_CATALOG_TIMEOUT_MS,
  OPENROUTER_CATALOG_URL,
  type CatalogFetcher,
} from "./free-model-lane";
import { QUALIFIER_BOOT_DELAY_MS } from "./free-model-qualifier-worker";

/**
 * The advertised Free lane must never offer a model OpenRouter stopped serving:
 * OpenCode answers such a run with "Model not found" inside the sandbox. The
 * qualifier only re-derives the lane when it runs (and is off on a deployment
 * without a probe key), so this prune runs on its own clock either way. It only
 * removes: adding a model stays the qualifier's job, because only a probe proves
 * a model can drive an agent.
 */
export const LANE_PRUNE_INTERVAL_MS = 60 * 60_000;
const LANE_PRUNE_JITTER_MS = 5 * 60_000;

/** Every model id the public catalog lists, or null for a read that cannot be
 * trusted (an error, a malformed body, no free model at all). A partial or
 * failed read must never empty the lane. */
export async function fetchOpenRouterCatalogIds(fetcher: CatalogFetcher = fetch): Promise<Set<string> | null> {
  try {
    const response = await fetcher(OPENROUTER_CATALOG_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(OPENROUTER_CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = ((await response.json()) as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return null;
    const ids = new Set<string>();
    for (const entry of data) {
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === "string") ids.add(id);
    }
    return [...ids].some((id) => id.endsWith(":free")) ? ids : null;
  } catch {
    return null;
  }
}

/** The lane's OpenRouter models the catalog no longer lists. OpenCode Zen
 * models ("opencode/<id>:free") are not OpenRouter's to judge. */
export function vanishedFromCatalog(lane: readonly string[], catalogIds: ReadonlySet<string>): string[] {
  return lane.filter((id) => !id.startsWith("opencode/") && !catalogIds.has(id));
}

export interface FreeModelLanePruneDeps {
  readonly catalogIds?: () => Promise<Set<string> | null>;
  readonly loadLane?: () => Promise<FreeModelRegistryStateRow | null>;
  readonly publish?: typeof publishFreeModelLane;
  readonly adopt?: (lane: readonly string[]) => void;
}

export type FreeModelLanePruneResult =
  | { readonly outcome: "catalog_unavailable" | "unchanged" | "kept_last_model" }
  | { readonly outcome: "pruned"; readonly removed: readonly string[]; readonly generation: number };

export async function pruneVanishedFreeModels(deps: FreeModelLanePruneDeps = {}): Promise<FreeModelLanePruneResult> {
  const catalogIds = await (deps.catalogIds ?? fetchOpenRouterCatalogIds)();
  if (!catalogIds) return { outcome: "catalog_unavailable" };
  const state = await (deps.loadLane ?? loadCurrentFreeModelLane)();
  if (!state) return { outcome: "unchanged" };
  const removed = vanishedFromCatalog(state.currentModelIds, catalogIds);
  if (removed.length === 0) return { outcome: "unchanged" };
  const survivors = state.currentModelIds.filter((id) => !removed.includes(id));
  // ponytail: an empty lane is left as is rather than published empty; the
  // picker then shows models that fail, which beats showing none on a bad read.
  if (survivors.length === 0) return { outcome: "kept_last_model" };
  // The publish path locks the registry row and refuses a generation that moved
  // since this read, so a qualifier publish in between is never overwritten.
  const published = await (deps.publish ?? publishFreeModelLane)({
    modelIds: survivors,
    expectedGeneration: state.generation,
  });
  (deps.adopt ?? ((lane) => freeModelLaneCache.adoptRegistryLane(lane)))(published.state.currentModelIds);
  return { outcome: "pruned", removed, generation: published.state.generation };
}

/** Hourly, first run shortly after boot, jittered so replicas do not align. */
export function startFreeModelLanePruner(): void {
  const run = (): void => {
    void pruneVanishedFreeModels().then(
      (result) => {
        if (result.outcome === "pruned") {
          console.log(`[free-model-lane] removed ${result.removed.join(", ")} (gone from OpenRouter); generation ${result.generation}`);
        }
      },
      (error: unknown) => {
        console.warn("[free-model-lane] prune failed:", error instanceof Error ? error.message : "unknown");
      },
    );
  };
  setTimeout(run, QUALIFIER_BOOT_DELAY_MS + Math.floor(Math.random() * LANE_PRUNE_JITTER_MS)).unref();
  setInterval(run, LANE_PRUNE_INTERVAL_MS).unref();
}
