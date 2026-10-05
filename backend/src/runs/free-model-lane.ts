/**
 * The Free model lane: zero-cost OpenRouter ":free" variants for OpenCode. The
 * advertised lane is the generation the qualifier last published to Postgres
 * (adopted at boot and every minute by the registry hydrator, and by the
 * qualifier itself when it publishes); until a generation is adopted the
 * curated seed serves. Policy reads stay synchronous from process memory.
 */

export const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const OPENROUTER_CATALOG_TIMEOUT_MS = 10_000;
const MIN_CONTEXT_LENGTH = 65_536;
const DISCOVERY_CAP = 100;

/** Curated fallback lane (verified tool-capable free models): the boot state
 * until the published generation is adopted. Listed in the order migration
 * 0066 published them, so a process that has adopted that generation and one
 * that has not advertise the same list. */
export const FREE_MODEL_LANE_SEED = [
  "minimax/minimax-m3:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
] as const;
const FREE_MODEL_LANE_SEED_SET = new Set<string>(FREE_MODEL_LANE_SEED);

/** Minimal fetch seam so tests inject a fixture catalog (never live network). */
export type CatalogFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface OpenRouterFreeModelCandidate {
  readonly id: string;
  readonly contextLength: number;
}

/** Public-catalog discovery only. Qualification is a separate full-agent run. */
export function discoverOpenRouterFreeModels(
  catalog: unknown,
  cap = DISCOVERY_CAP,
): OpenRouterFreeModelCandidate[] {
  const data =
    catalog && typeof catalog === "object" && !Array.isArray(catalog)
      ? (catalog as { data?: unknown }).data
      : null;
  if (!Array.isArray(data)) return [];
  const candidates: OpenRouterFreeModelCandidate[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as {
      id?: unknown;
      context_length?: unknown;
      supported_parameters?: unknown;
    };
    if (typeof entry.id !== "string" || !entry.id.endsWith(":free")) continue;
    if (
      typeof entry.context_length !== "number" ||
      entry.context_length < MIN_CONTEXT_LENGTH
    ) {
      continue;
    }
    if (
      !Array.isArray(entry.supported_parameters) ||
      !entry.supported_parameters.includes("tools")
    ) {
      continue;
    }
    candidates.push({ id: entry.id, contextLength: entry.context_length });
  }
  return candidates
    .toSorted((a, b) => b.contextLength - a.contextLength)
    .slice(0, cap);
}

export class FreeModelLaneCache {
  #lane: readonly string[] | null = null;
  #allowed = new Set<string>();

  /** The advertised lane: the adopted published generation, or the seed. */
  lane(): readonly string[] {
    return this.#lane ?? FREE_MODEL_LANE_SEED;
  }

  /** Acceptance for NEW work is exactly the advertised lane. A run that already
   * persisted a free model is judged by the persisted policy instead, so a
   * rotation never strands a stored selection. */
  isAllowed(model: string): boolean {
    return this.#lane ? this.#allowed.has(model) : FREE_MODEL_LANE_SEED_SET.has(model);
  }

  /** Adopt a published generation. An empty one is a real state (every model
   * retired) and is adopted as such. */
  adoptRegistryLane(lane: readonly string[]): void {
    const normalized = [...new Set(lane.map((model) => model.trim()).filter(Boolean))];
    this.#lane = normalized;
    this.#allowed = new Set(normalized);
  }

  /** Restore the cold boot state (seed lane). Test isolation seam. */
  reset(): void {
    this.#lane = null;
    this.#allowed.clear();
  }
}

/** The process-wide cache behind model policy and the /api/config manifest. */
export const freeModelLaneCache = new FreeModelLaneCache();

export function freeModelLane(): readonly string[] {
  return freeModelLaneCache.lane();
}

export function isAllowedFreeModel(model: string): boolean {
  return freeModelLaneCache.isAllowed(model);
}
