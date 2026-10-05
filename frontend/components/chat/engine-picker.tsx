"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ENGINES,
  type EngineId,
  isFreeModel,
  modelLabel,
  normalizeEngine,
  selectableModelsForEngine,
} from "@/components/chat/types";
import { invalidateCapabilityCatalog, useCapabilityCatalog } from "@/hooks/use-capability-catalog";
import {
  type CapabilityCatalog,
  type CapabilityCatalogModel,
  type CapabilityEngineRuntime,
  type CapabilityModelCatalogStatus,
  parseCapabilityCatalog,
} from "@/lib/capability-catalog";
import { useLocalLoginOffers } from "@/components/runners/local-login-availability";

export type EngineModelCatalog = Partial<Record<EngineId, readonly string[]>>;
export type EngineModelDetails = Partial<Record<EngineId, readonly CapabilityCatalogModel[]>>;
export type EngineModelCatalogStatuses = Partial<Record<EngineId, CapabilityModelCatalogStatus>>;
export interface EngineReadinessStatus {
  readonly ready: boolean;
  readonly reason: "enabled" | "disabled" | "provider_unhealthy" | "gateway_unconfigured" | "not_proven";
  readonly provider?: "anthropic" | "openai" | "openrouter" | "cerebras";
  readonly providerHealth?: string;
  readonly message?: string;
}
export type EngineReadinessCatalog = Partial<Record<EngineId, EngineReadinessStatus>>;

interface EngineCatalogConfig {
  engines: EngineId[];
  models: EngineModelCatalog;
  readiness: EngineReadinessCatalog;
  runtimes: Partial<Record<EngineId, CapabilityEngineRuntime>>;
  modelDetails: EngineModelDetails;
  modelCatalogStatuses: EngineModelCatalogStatuses;
}

export function unavailableModelOptions(
  engine: EngineId,
  details: readonly CapabilityCatalogModel[],
) {
  return details
    .filter((entry) => !entry.dispatchable)
    .map((entry) => ({
      value: entry.id,
      label: entry.displayName ?? modelLabel(entry.id, engine),
      disabled: true,
      description: entry.degradationReason === "model_not_allowed"
        ? "Discovered for this account; blocked by deployment policy"
        : entry.degradationReason === "model_not_available"
          ? "Allowed by deployment policy; unavailable for this account"
          : "Currently unavailable",
    }));
}

export function reconcileSelectedModel(
  selected: string,
  options: readonly { readonly value: string }[],
  loaded: boolean,
): { readonly replacement: string | null; readonly blocked: boolean } {
  if (!loaded || options.some((option) => option.value === selected)) {
    return { replacement: null, blocked: false };
  }
  return {
    replacement: options[0]?.value ?? null,
    blocked: options.length === 0,
  };
}

export function modelCatalogNotice(
  status: CapabilityModelCatalogStatus | undefined,
): string | null {
  if (!status?.stale) return null;
  if (status.error === "native_catalog_refreshing") {
    return "Refreshing availability for this account…";
  }
  return "Model availability could not refresh. Showing the last known catalog.";
}

const ENGINE_RUNTIME_CAPTIONS: Partial<Record<EngineId, string>> = {
  opencode: "any model · cloud",
  claude: "Anthropic agent · cloud",
  codex: "OpenAI agent · cloud",
  pi: "native Pi harness · cloud",
  chat: "Chat only: answers from context, no computer or tools",
};

/** The engines the new-thread picker offers: every engine the server manifest
 *  configured, in catalog order. Chat is a first-class choice; it simply has no
 *  computer, which its caption says. */
export function pickerEngineOptions(
  enabledEngines: readonly EngineId[],
): readonly { id: EngineId; label: string }[] {
  return ENGINES.filter((e) => enabledEngines.includes(e.id));
}

export function engineRuntimeCaption(
  engine: EngineId,
  runtime: CapabilityEngineRuntime | undefined,
  readiness: EngineReadinessStatus | undefined,
  localLoginOffered = false,
  machineRunsWork = false,
): string {
  const caption = runtime ? ENGINE_RUNTIME_CAPTIONS[engine] ?? "Runtime unavailable" : "Runtime unavailable";
  // The user's own machine takes new threads when it is online; the caption says so.
  const label = runtime && machineRunsWork ? caption.replace(/ · cloud$/, " · local") : caption;
  if (localLoginOffered) {
    return `${ENGINES.find((candidate) => candidate.id === engine)?.label ?? "Engine"} · machine login available`;
  }
  return `${label}${readiness?.ready === false ? " · needs attention" : ""}`;
}

export function engineConfigFromCapabilityCatalog(catalog: CapabilityCatalog): EngineCatalogConfig {
  const configured = catalog.engines.filter((engine) => engine.configured);
  return {
    engines: configured.map((engine) => engine.id),
    models: Object.fromEntries(
      configured.map((engine) => [
        engine.id,
        engine.models
          .filter((model) => model.dispatchable)
          .sort((left, right) => Number(right.default) - Number(left.default))
          .map((model) => model.id),
      ]),
    ),
    modelDetails: Object.fromEntries(
      configured.map((engine) => [
        engine.id,
        engine.models.toSorted((left, right) => Number(right.default) - Number(left.default)),
      ]),
    ),
    modelCatalogStatuses: Object.fromEntries(
      configured.flatMap((engine) =>
        engine.modelCatalog ? [[engine.id, engine.modelCatalog] as const] : []
      ),
    ),
    readiness: Object.fromEntries(
      configured.map((engine) => [
        engine.id,
        {
          ready: engine.ready,
          reason: engine.degradationReason ?? "enabled",
          ...(engine.message ? { message: engine.message } : {}),
        },
      ]),
    ),
    runtimes: Object.fromEntries(configured.map((engine) => [engine.id, engine.runtime])),
  };
}

export function applyLocalLoginOffers<T extends EngineCatalogConfig>(
  config: T,
  offers: readonly EngineId[],
): T & { localLoginOffered: EngineId[] } {
  const localLoginOffered = offers.filter(
    (engine) =>
      config.engines.includes(engine) && config.readiness[engine]?.reason === "provider_unhealthy",
  );
  const modelDetails = { ...config.modelDetails };
  const models = { ...config.models };
  for (const engine of localLoginOffered) {
    modelDetails[engine] = (modelDetails[engine] ?? []).map((model) => {
      if (!model.policyAllowed) return model;
      return { ...model, dispatchable: true };
    });
    models[engine] = (modelDetails[engine] ?? [])
      .filter((model) => model.dispatchable)
      .sort((left, right) => Number(right.default) - Number(left.default))
      .map((model) => model.id);
  }
  return { ...config, localLoginOffered, modelDetails, models };
}

export function resolveEnabledEngine(
  current: EngineId,
  enabled: readonly EngineId[],
): EngineId | null {
  if (enabled.includes(current)) return current;
  return enabled[0] ?? null;
}

export function fallbackEnabledEngineConfig() {
  return {
    engines: ["opencode"] as EngineId[],
    models: {
      opencode: selectableModelsForEngine("opencode").map((model) => model.value),
    } satisfies EngineModelCatalog,
    readiness: {} as EngineReadinessCatalog,
    runtimes: {} as Partial<Record<EngineId, CapabilityEngineRuntime>>,
    modelDetails: {} as EngineModelDetails,
    modelCatalogStatuses: {} as EngineModelCatalogStatuses,
    loaded: false,
    readinessKnown: false,
  };
}

export function parseEngineReadinessCatalog(raw: unknown): EngineReadinessCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: EngineReadinessCatalog = {};
  for (const engine of ENGINES) {
    const status = (raw as Record<string, unknown>)[engine.id];
    if (!status || typeof status !== "object" || Array.isArray(status)) continue;
    const value = status as Record<string, unknown>;
    if (typeof value.ready !== "boolean" || typeof value.reason !== "string") continue;
    out[engine.id] = {
      ready: value.ready,
      reason: value.reason as EngineReadinessStatus["reason"],
      ...(typeof value.provider === "string"
        ? { provider: value.provider as EngineReadinessStatus["provider"] }
        : {}),
      ...(typeof value.providerHealth === "string" ? { providerHealth: value.providerHealth } : {}),
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    };
  }
  return out;
}

/** A manual refresh may rotate the live lane, but selections already offered in
 * this browser session stay submit-able while newly discovered models append. */
export function mergeEngineModelCatalog(
  current: EngineModelCatalog,
  refreshed: EngineModelCatalog,
  preserveModel?: string,
): EngineModelCatalog {
  const merged: EngineModelCatalog = { ...refreshed };
  if (!preserveModel || !isFreeModel(preserveModel)) return merged;
  for (const engine of ENGINES) {
    const next = refreshed[engine.id];
    if (!next || !current[engine.id]?.includes(preserveModel) || next.includes(preserveModel)) {
      continue;
    }
    merged[engine.id] = [...next, preserveModel];
  }
  return merged;
}

/**
 * Refresh the shared Free lane, then ask the authenticated capability endpoint
 * for this actor's native model catalog. Null on failure keeps the current list.
 */
export async function requestModelCatalogRefresh(
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  options: { readonly refreshFree?: boolean } = {},
): Promise<{
  models: EngineModelCatalog;
  modelDetails: EngineModelDetails;
  modelCatalogStatuses: EngineModelCatalogStatuses;
} | null> {
  try {
    if (options.refreshFree !== false) {
      await fetcher("/api/config/models/refresh", { method: "POST" }).catch(() => null);
    }
    const response = await fetcher("/api/capabilities?refresh=models");
    if (!response.ok) return null;
    const catalog = parseCapabilityCatalog(await response.json());
    if (!catalog) return null;
    const config = engineConfigFromCapabilityCatalog(catalog);
    return {
      models: config.models,
      modelDetails: config.modelDetails,
      modelCatalogStatuses: config.modelCatalogStatuses,
    };
  } catch {
    return null;
  }
}

export function useEnabledEngineConfig(options: { readonly machineLogins?: boolean } = {}): {
  engines: EngineId[];
  models: EngineModelCatalog;
  modelDetails: EngineModelDetails;
  modelCatalogStatuses: EngineModelCatalogStatuses;
  readiness: EngineReadinessCatalog;
  runtimes: Partial<Record<EngineId, CapabilityEngineRuntime>>;
  localLoginOffered: EngineId[];
  /** True once GET /api/capabilities resolved (or failed): before that the engines
   * list is the conservative fallback and must not demote a richer default. */
  loaded: boolean;
  /** True only when the server returned an engines manifest. */
  readinessKnown: boolean;
  /** Manual model refresh: swaps the refreshed manifest in place; a failed
   * request keeps the current catalog. */
  refreshModels: (preserveModel?: string, engine?: EngineId) => Promise<void>;
} {
  const capabilityState = useCapabilityCatalog();
  const localLoginOffers = useLocalLoginOffers();
  const [config, setConfig] = useState<EngineCatalogConfig & {
    loaded: boolean;
    readinessKnown: boolean;
  }>(fallbackEnabledEngineConfig);
  useEffect(() => {
    const catalog = capabilityState.catalog;
    if (!catalog) {
      if (capabilityState.loaded) setConfig((current) => ({ ...current, loaded: true }));
      return;
    }
    const next = engineConfigFromCapabilityCatalog(catalog);
    setConfig({
      ...next,
      loaded: true,
      readinessKnown: true,
    });
  }, [capabilityState.catalog, capabilityState.loaded]);
  const refreshModels = useCallback(async (preserveModel?: string, engine?: EngineId) => {
    const refreshed = await requestModelCatalogRefresh(fetch, {
      refreshFree: engine === undefined || normalizeEngine(engine) === "opencode",
    });
    if (!refreshed || Object.keys(refreshed.models).length === 0) return;
    invalidateCapabilityCatalog();
    setConfig((c) => ({
      ...c,
      models: mergeEngineModelCatalog(c.models, refreshed.models, preserveModel),
      modelDetails: refreshed.modelDetails,
      modelCatalogStatuses: refreshed.modelCatalogStatuses,
    }));
  }, []);
  // A machine login counts only for a thread that runs on the machine; a
  // composer sending its threads to the cloud asks for none.
  const machineLogins = options.machineLogins !== false;
  const offeredConfig = useMemo(
    () => applyLocalLoginOffers(config, machineLogins ? localLoginOffers : []),
    [config, localLoginOffers, machineLogins],
  );
  return { ...offeredConfig, refreshModels };
}

/** Configured user-facing engines from GET /api/capabilities. Dispatch readiness is
 * carried separately in `readiness`, so a provider problem stays discoverable
 * and actionable instead of making its engine disappear. */
export function useEnabledEngines(): EngineId[] {
  return useEnabledEngineConfig().engines;
}

