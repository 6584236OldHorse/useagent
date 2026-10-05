import type { EngineId } from "../db/schema";
import {
  type NativeCodexModel,
  nativeCodexModelCatalog,
} from "../provider-connections/codex-model-catalog";
import type { ProviderConnectionScope } from "../provider-connections/repo";

/**
 * Reasoning effort is an engine seam: Codex forwards the choice as the
 * app-server turn's effort (its `model_reasoning_effort` config), Claude Code
 * as the agent's effort option. OpenCode, Pi and Chat run their models without
 * a selector. The runtime lane validates the value against its own catalog and
 * falls back to the model's default, so this list is what the picker may offer,
 * never a promise about a provider's internals.
 */
const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface ReasoningEffortSupport {
  /** The levels the picker may offer, ascending; empty means no selector. */
  readonly efforts: readonly string[];
  /** The level the runtime uses when a run carries none. */
  readonly defaultEffort: string | null;
}

/** The support for one engine's model: the native Codex catalog's own list when
 *  it knows the model, the engine's policy set otherwise. */
export function reasoningEffortSupport(
  engine: EngineId,
  nativeModel?: Pick<NativeCodexModel, "supportedReasoningEfforts" | "defaultReasoningEffort">,
): ReasoningEffortSupport {
  switch (engine) {
    case "codex":
      return {
        efforts: nativeModel?.supportedReasoningEfforts.length
          ? nativeModel.supportedReasoningEfforts
          : CODEX_REASONING_EFFORTS,
        defaultEffort: nativeModel?.defaultReasoningEffort ?? "medium",
      };
    case "claude":
    case "claude-sdk":
      return { efforts: CLAUDE_REASONING_EFFORTS, defaultEffort: "high" };
    default:
      return { efforts: [], defaultEffort: null };
  }
}

export type ReasoningEffortResolution =
  | { readonly ok: true; readonly value: string | null }
  | {
      readonly ok: false;
      readonly error: "reasoning_effort_not_supported" | "reasoning_effort_invalid";
      readonly efforts: readonly string[];
    };

/** The effort a new run carries: the request's value when the engine supports
 *  it; otherwise the parent's, so a reply keeps the thread's choice for as long
 *  as the catalog still offers it; otherwise none (the runtime's default). */
export function resolveReasoningEffort(
  requested: unknown,
  support: ReasoningEffortSupport,
  parentEffort: string | null,
): ReasoningEffortResolution {
  if (requested === undefined || requested === null || requested === "") {
    const inherited = parentEffort !== null && support.efforts.includes(parentEffort);
    return { ok: true, value: inherited ? parentEffort : null };
  }
  const value = typeof requested === "string" ? requested.trim() : "";
  if (!support.efforts.includes(value)) {
    return {
      ok: false,
      error: support.efforts.length === 0
        ? "reasoning_effort_not_supported"
        : "reasoning_effort_invalid",
      efforts: support.efforts,
    };
  }
  return { ok: true, value };
}

/** The support for the run being created. Only a Codex run with a value to
 *  check consults this actor's native catalog (cached per actor). */
export async function reasoningEffortSupportForRun(
  engine: EngineId,
  model: string,
  scope: ProviderConnectionScope | null,
): Promise<ReasoningEffortSupport> {
  if (engine !== "codex" || !scope) return reasoningEffortSupport(engine);
  const catalog = await nativeCodexModelCatalog(scope).catch(() => null);
  return reasoningEffortSupport(engine, catalog?.models.find((entry) => entry.id === model));
}
