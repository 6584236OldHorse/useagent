"use client";

// The rail entries behind both model pickers: one provider per engine the
// server manifest configured, its lineup in the sections the product already
// speaks (Models, Free, Discovered) with the refresh actions those sections own.

import { RiRefreshLine } from "@remixicon/react";
import { createContext, use, useLayoutEffect, useState } from "react";
import {
  PROVIDER_LABELS,
  type ProviderConnectionProvider,
} from "@/app/(workspace)/settings/provider-connections-data";
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
  isFreeModel,
  modelOptionsForEngine,
  partitionModelOptions,
} from "@/components/chat/types";
import { engineMarkFor } from "@/components/foundations/icons/vendor-marks";
import {
  effortAfterPick,
  findPickerRow,
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

/** What the member's keys can run: the provider whose key a model needs and
 *  they lack (null when it can run or the answer is unknown), and the action
 *  that opens that provider's key form in place. */
export interface ModelKeyAccess {
  readonly missing: (engine: EngineId, provider: string | undefined) => ProviderConnectionProvider | null;
  readonly onAdd: (provider: ProviderConnectionProvider) => void;
}

/** The key access for the pickers under a composer that shows the key form
 *  (the reply composer provides it); absent, no model is marked. */
export const ModelKeysContext = createContext<ModelKeyAccess | null>(null);

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
 *  and Free sections, the discovered-but-blocked ones under Discovered. With
 *  `keys`, a model no key of the member's serves stays listed, tagged with the
 *  key it needs, and picking it opens that key's form; the Free note carries
 *  the same action while no key serves OpenRouter. */
export function engineProvider(
  engine: EngineId,
  catalog: ProviderCatalog,
  refresh?: ProviderRefresh,
  caption?: string,
  keys?: ModelKeyAccess | null,
): ModelPickerProvider {
  const options = modelOptionsForEngine(
    engine,
    catalog.models[engine] ?? [],
    catalog.modelDetails[engine] ?? [],
  );
  // The manifest's per-model effort seam rides on the row (none for OpenCode/Pi/Chat),
  // and so does the key the model needs when the member has none for it.
  const details = catalog.modelDetails[engine] ?? [];
  const decorate = (rows: readonly ModelPickerRow[]): ModelPickerRow[] =>
    rows.map((row) => {
      const detail = details.find((entry) => entry.id === row.value);
      const needs = keys?.missing(engine, detail?.provider) ?? null;
      return {
        ...row,
        ...(detail?.supportedReasoningEfforts?.length
          ? { efforts: detail.supportedReasoningEfforts, defaultEffort: detail.defaultReasoningEffort }
          : {}),
        ...(needs ? { unlock: { label: `Needs ${PROVIDER_LABELS[needs].name} key`, onUnlock: () => keys?.onAdd(needs) } } : {}),
      };
    });
  const { paid, free } = partitionModelOptions(options);
  const discovered = unavailableModelOptions(engine, details);
  // Free models are free on the member's own OpenRouter key; the deployment
  // never lends one, so the section says where the key goes, and while no key
  // serves OpenRouter it opens the key form in place.
  const freeKeys = keys?.missing(engine, "openrouter") ? keys : null;
  const sections: ModelPickerSection[] = [
    { label: "", rows: decorate(paid) },
    {
      label: "Free",
      action: refresh ? <RefreshModelsAction label="Refresh free models" refresh={refresh} /> : undefined,
      noteAction: freeKeys ? { label: "Add OpenRouter key", onAction: () => freeKeys.onAdd("openrouter") } : undefined,
      note: freeKeys ? (
        "Free on your own OpenRouter key."
      ) : (
        <>
          Free on your OpenRouter key.{" "}
          <Link href="/settings" className="text-text-secondary underline underline-offset-2 hover:text-text-primary">
            Add it in Settings
          </Link>
        </>
      ),
      rows: decorate(free),
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

/** The model the reply composer swaps to: a removed model's replacement, else,
 *  when the selection needs a key the member lacks, the first free model they
 *  can run; null keeps the selection. */
export function selectionFallback(
  provider: ModelPickerProvider,
  model: string,
  replacement: string | null,
): string | null {
  if (replacement || !findPickerRow([provider], model, provider.id)?.row.unlock) return replacement;
  return (
    provider.sections
      .flatMap((section) => section.rows)
      .find((row) => isFreeModel(row.value) && !row.unlock && !row.disabled)?.value ?? null
  );
}

/**
 * The picker bound to one engine's live catalog (the reply composer): the rail
 * carries that engine, the rows its manifest lineup, and the reconciliation the
 * composer relies on stays here (a removed model swaps to the first available
 * one; none left blocks sending; a model that needs a key the member lacks
 * swaps to a free model they can run).
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
  const keys = use(ModelKeysContext);
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
  const provider = engineProvider(engine, { models, modelDetails }, refresh, undefined, keys);
  const fallback = selectionFallback(provider, model, replacement);
  useLayoutEffect(() => {
    if (fallback && fallback !== model) {
      onChange(fallback);
      // The replacement row's level, so the chip and the sent value agree.
      onReasoningEffortChange?.(effortAfterPick([provider], fallback, engine, reasoningEffort));
    }
    onAvailabilityChange?.(!blocked);
  }, [blocked, engine, fallback, model, onAvailabilityChange, onChange, onReasoningEffortChange, provider, reasoningEffort]);
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
