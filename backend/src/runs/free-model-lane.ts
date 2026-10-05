/**
 * The Free model lane: zero-cost OpenRouter ":free" variants for OpenCode. The
 * advertised lane is the generation the qualifier last published to Postgres
 * (adopted at boot and every minute by the registry hydrator, and by the
 * qualifier itself when it publishes); until a generation is adopted the
 * curated seed serves. Policy reads stay synchronous from process memory.
 */

export const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";
/** The public catalog OpenCode maintains; its "opencode" provider is OpenCode Zen. */
export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";
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

export type FreeModelProvider = "openrouter" | "opencode";

export interface FreeModelCandidate {
  /** Our lane id: OpenRouter's slug as is, or "opencode/<zen id>:free". */
  readonly id: string;
  readonly contextLength: number;
  readonly provider: FreeModelProvider;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Public-catalog discovery only. Qualification is a separate full-agent run. */
export function discoverOpenRouterFreeModels(
  catalog: unknown,
  cap = DISCOVERY_CAP,
): FreeModelCandidate[] {
  const data = record(catalog)?.data;
  if (!Array.isArray(data)) return [];
  const candidates: FreeModelCandidate[] = [];
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
    candidates.push({ id: entry.id, contextLength: entry.context_length, provider: "openrouter" });
  }
  return candidates
    .toSorted((a, b) => b.contextLength - a.contextLength)
    .slice(0, cap);
}

/** The runtime adapter the provider gateway's Zen route speaks (chat
 * completions). A Zen model pinned to another adapter would call an endpoint
 * the gateway does not proxy, so it is not a candidate. */
const ZEN_GATEWAY_ADAPTER = "@ai-sdk/openai-compatible";

/** OpenCode Zen's free models from the models.dev catalog: zero cost both
 * ways, tool calls, a usable context, not retired, on the adapter the gateway
 * proxies. Zen ids are plain words; anything else cannot become a lane id. */
export function discoverOpenCodeZenFreeModels(
  catalog: unknown,
  cap = DISCOVERY_CAP,
): FreeModelCandidate[] {
  const models = record(record(record(catalog)?.opencode)?.models);
  if (!models) return [];
  const candidates: FreeModelCandidate[] = [];
  for (const [id, raw] of Object.entries(models)) {
    const entry = record(raw);
    const cost = record(entry?.cost);
    const context = record(entry?.limit)?.context;
    const adapter = record(entry?.provider)?.npm;
    if (!entry || !cost || cost.input !== 0 || cost.output !== 0) continue;
    if (entry.tool_call !== true || entry.status === "deprecated") continue;
    if (adapter !== undefined && adapter !== ZEN_GATEWAY_ADAPTER) continue;
    if (typeof context !== "number" || context < MIN_CONTEXT_LENGTH) continue;
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(id)) continue;
    candidates.push({ id: `opencode/${id}:free`, contextLength: context, provider: "opencode" });
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
