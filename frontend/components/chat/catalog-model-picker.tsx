"use client";

// The rail entries behind both model pickers: one provider per engine the
// server manifest configured, its lineup in the sections the product already
// speaks (Models, Free, Discovered) with the refresh actions those sections own.

import { RiRefreshLine } from "@remixicon/react";
import { type ReactNode, useLayoutEffect, useState } from "react";
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
  effortAfterPick,
  ModelPicker,
  type ModelPickerProvider,
  type ModelPickerRow,
  type ModelPickerSection,
} from "@/components/pro/model-picker";
import Link from "next/link";
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
 *  and Free sections, the discovered-but-blocked ones under Discovered.
 *  `freeNote` replaces the Free section's default note (the home composer's
 *  in-place key action). */
export function engineProvider(
  engine: EngineId,
  catalog: ProviderCatalog,
  refresh?: ProviderRefresh,
  caption?: string,
  freeNote?: ReactNode,
): ModelPickerProvider {
  const options = modelOptionsForEngine(
    engine,
    catalog.models[engine] ?? [],
    catalog.modelDetails[engine] ?? [],
  );
  // The manifest's per-model effort seam rides on the row (none for OpenCode/Pi/Chat).
  const details = catalog.modelDetails[engine] ?? [];
  const withEfforts = (rows: readonly ModelPickerRow[]): ModelPickerRow[] =>
    rows.map((row) => {
      const detail = details.find((entry) => entry.id === row.value);
      return detail?.supportedReasoningEfforts?.length
        ? { ...row, efforts: detail.supportedReasoningEfforts, defaultEffort: detail.defaultReasoningEffort }
        : row;
    });
  const { paid, free } = partitionModelOptions(options);
  const discovered = unavailableModelOptions(engine, details);
  const sections: ModelPickerSection[] = [
    { label: "", rows: withEfforts(paid) },
    {
      label: "Free",
      action: refresh ? <RefreshModelsAction label="Refresh free models" refresh={refresh} /> : undefined,
      // Free models are free on the member's own OpenRouter key; the deployment
      // never lends one, so the section says where the key goes.
      note: freeNote ?? (
        <>
          Free on your OpenRouter key.{" "}
          <Link href="/settings" className="text-text-secondary underline underline-offset-2 hover:text-text-primary">
            Add it in Settings
          </Link>
        </>
      ),
      rows: free,
    },
    { label: "Discovered", rows: discovered },
  ];
  return {
    id: engine,
    label: engineLabel(engine),
    caption,
    mark: engineMarkFor(engine),
    // This actor's native Codex catalog refreshes from the panel header.
    ...(engine === "codex" && refresh
      ? { action: <RefreshModelsAction label="Refresh Codex models" refresh={refresh} /> }
      : {}),
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
  reasoningEffort,
  onReasoningEffortChange,
  className,
}: {
  engine: EngineId;
  model: string;
  onChange: (model: string) => void;
  onAvailabilityChange?: (available: boolean) => void;
  /** The thread's reasoning effort; null shows the model's default. */
  reasoningEffort?: string | null;
  onReasoningEffortChange?: (effort: string) => void;
  className?: string;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const { models, modelDetails, modelCatalogStatuses, refreshModels, loaded } =
    useEnabledEngineConfig();
  const options = modelOptionsForEngine(engine, models[engine] ?? [], modelDetails[engine] ?? []);
  const { replacement, blocked } = reconcileSelectedModel(model, options, loaded);
  const refresh: ProviderRefresh = {
    refreshing,
    onRefresh: () => {
      if (refreshing) return;
      setRefreshing(true);
      void refreshModels(model, engine).finally(() => setRefreshing(false));
    },
  };
  const provider = engineProvider(engine, { models, modelDetails }, refresh);
  useLayoutEffect(() => {
    if (replacement && replacement !== model) {
      onChange(replacement);
      // The replacement row's level, so the chip and the sent value agree.
      onReasoningEffortChange?.(effortAfterPick([provider], replacement, engine, reasoningEffort));
    }
    onAvailabilityChange?.(!blocked);
  }, [blocked, engine, model, onAvailabilityChange, onChange, onReasoningEffortChange, provider, reasoningEffort, replacement]);
  return (
    <ModelPicker
      providers={[provider]}
      value={model}
      providerId={engine}
      onChange={onChange}
      notice={engine === "codex" ? modelCatalogNotice(modelCatalogStatuses.codex) : null}
      effort={reasoningEffort}
      onEffortChange={onReasoningEffortChange}
      className={className}
    />
  );
}
