"use client";

// The rail entries behind both model pickers: one provider per engine the
// server manifest configured, its lineup in the sections the product already
// speaks (Models, Free, Discovered) with the refresh actions those sections own.

import { RiRefreshLine } from "@remixicon/react";
import { useLayoutEffect, useState } from "react";
import {
  type EngineModelCatalog,
  type EngineModelDetails,
  modelCatalogNotice,
  reconcileSelectedModel,
  unavailableModelOptions,
  useEnabledEngineConfig,
} from "@/components/chat/engine-picker";
import {
  type EngineId,
  engineLabel,
  modelOptionsForEngine,
  partitionModelOptions,
} from "@/components/chat/types";
import { engineMarkFor } from "@/components/foundations/icons/vendor-marks";
import {
  ModelPicker,
  type ModelPickerProvider,
  type ModelPickerSection,
} from "@/components/pro/model-picker";
import { cx } from "@/utils/cx";

export interface ProviderCatalog {
  readonly models: EngineModelCatalog;
  readonly modelDetails: EngineModelDetails;
}

export interface ProviderRefresh {
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}

/** Refresh either the shared Free lane or this actor's native Codex catalog. */
export function RefreshModelsAction({
  label,
  refresh,
}: {
  label: string;
  refresh: ProviderRefresh;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Refresh"
      disabled={refresh.refreshing}
      onClick={refresh.onRefresh}
      className="rounded-md p-0.5 text-text-tertiary transition-colors hover:text-text-primary disabled:opacity-50"
    >
      <RiRefreshLine className={cx("size-3.5", refresh.refreshing && "animate-spin")} aria-hidden />
    </button>
  );
}

/** One rail entry for `engine`: the manifest's dispatchable models in the paid
 *  and Free sections, the discovered-but-blocked ones under Discovered. */
export function engineProvider(
  engine: EngineId,
  catalog: ProviderCatalog,
  refresh?: ProviderRefresh,
  caption?: string,
): ModelPickerProvider {
  const options = modelOptionsForEngine(
    engine,
    catalog.models[engine] ?? [],
    catalog.modelDetails[engine] ?? [],
  );
  const { paid, free } = partitionModelOptions(options);
  const discovered = unavailableModelOptions(engine, catalog.modelDetails[engine] ?? []);
  const codexRefresh = engine === "codex" && refresh
    ? <RefreshModelsAction label="Refresh Codex models" refresh={refresh} />
    : undefined;
  const sections: ModelPickerSection[] = [
    { label: "Models", action: codexRefresh, rows: paid },
    {
      label: "Free",
      action: refresh ? <RefreshModelsAction label="Refresh free models" refresh={refresh} /> : undefined,
      rows: free,
    },
    { label: "Discovered", action: codexRefresh, rows: discovered },
  ];
  return {
    id: engine,
    label: engineLabel(engine),
    caption,
    mark: engineMarkFor(engine),
    sections,
  };
}

/**
 * The picker bound to one engine's live catalog (the reply composer): the rail
 * carries that engine, the rows its manifest lineup, and the reconciliation the
 * composer relies on stays here (a removed model swaps to the first available
 * one; none left blocks sending).
 */
export function CatalogModelPicker({
  engine,
  model,
  onChange,
  onAvailabilityChange,
  className,
}: {
  engine: EngineId;
  model: string;
  onChange: (model: string) => void;
  onAvailabilityChange?: (available: boolean) => void;
  className?: string;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const { models, modelDetails, modelCatalogStatuses, refreshModels, loaded } =
    useEnabledEngineConfig();
  const options = modelOptionsForEngine(engine, models[engine] ?? [], modelDetails[engine] ?? []);
  const { replacement, blocked } = reconcileSelectedModel(model, options, loaded);
  useLayoutEffect(() => {
    if (replacement && replacement !== model) onChange(replacement);
    onAvailabilityChange?.(!blocked);
  }, [model, blocked, onAvailabilityChange, onChange, replacement]);
  const refresh: ProviderRefresh = {
    refreshing,
    onRefresh: () => {
      if (refreshing) return;
      setRefreshing(true);
      void refreshModels(model, engine).finally(() => setRefreshing(false));
    },
  };
  return (
    <ModelPicker
      providers={[engineProvider(engine, { models, modelDetails }, refresh)]}
      value={model}
      providerId={engine}
      onChange={onChange}
      notice={engine === "codex" ? modelCatalogNotice(modelCatalogStatuses.codex) : null}
      className={className}
    />
  );
}
