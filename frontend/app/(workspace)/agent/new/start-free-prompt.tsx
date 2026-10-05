"use client";

import { RiArrowRightUpLine, RiCloseLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { fetchSecrets } from "@/app/(library)/secrets/secrets-api";
import { ProviderKeyForm } from "@/app/(workspace)/settings/provider-key-form";
import {
  type DeploymentConfig,
  fetchDeploymentConfig,
  fetchProviderConnections,
} from "@/app/(workspace)/settings/provider-connections-api";
import {
  isActiveConnection,
  MODEL_PROVIDER_CONNECTION_PROVIDERS,
  type ProviderConnectionMeta,
} from "@/app/(workspace)/settings/provider-connections-data";
import { Button } from "@/components/base/buttons/button";
import type { EngineModelCatalog } from "@/components/chat/engine-picker";
import { isFreeModel } from "@/components/chat/types";
import { invalidateCapabilityCatalog } from "@/hooks/use-capability-catalog";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { useSession } from "@/lib/auth";

/**
 * Start free: a member with no model key is one step from a working free model.
 * The card above the home composer says free models cost nothing on their own
 * OpenRouter key and opens the Settings key form in place, key field alone. The
 * same action sits in the picker's Free note and the composer's send error.
 * While any read is unknown nothing is shown or refused: the backend stays the
 * judge of a run.
 */

export const FREE_KEY_URL = "https://openrouter.ai/settings/keys";
export const START_FREE_ERROR = "Add a model key to send. Free models cost nothing on your own OpenRouter key.";

export interface ModelKeyState {
  /** No key of any kind serves this member, and an OpenRouter key would. */
  readonly needsKey: boolean;
  /** OpenRouter is offered to this member and no key serves it. */
  readonly openRouterMissing: boolean;
  /** OpenRouter is the one provider a key serves, so a free model is the safe start. */
  readonly onlyOpenRouter: boolean;
  /** The member's own OpenRouter key row, so the form shows a rejected key. */
  readonly openRouterConnection: ProviderConnectionMeta | null;
}

const UNKNOWN: ModelKeyState = {
  needsKey: false,
  openRouterMissing: false,
  onlyOpenRouter: false,
  openRouterConnection: null,
};

/** The providers a key serves for this member, in the backend's order: their own
 *  connection, the organization's secret (named as providerCredentialName names
 *  it), then a key this deployment serves. Only offered providers count. */
export function modelKeyState(input: {
  readonly connections: readonly ProviderConnectionMeta[];
  readonly config: Pick<DeploymentConfig, "offeredProviders" | "servedProviders">;
  readonly secretNames: readonly string[];
}): ModelKeyState {
  const offered = input.config.offeredProviders ?? [...MODEL_PROVIDER_CONNECTION_PROVIDERS, "opencode"];
  const served = offered.filter(
    (provider) =>
      input.connections.some((connection) => connection.provider === provider && isActiveConnection(connection)) ||
      input.secretNames.includes(`${provider.toUpperCase()}_API_KEY`) ||
      input.config.servedProviders.includes(provider),
  );
  const openRouterOffered = offered.includes("openrouter");
  return {
    needsKey: openRouterOffered && served.length === 0,
    openRouterMissing: openRouterOffered && !served.includes("openrouter"),
    onlyOpenRouter: served.length === 1 && served[0] === "openrouter",
    openRouterConnection:
      input.connections.find((connection) => connection.provider === "openrouter" && connection.authMethod === "api_key") ??
      null,
  };
}

/** The card shows while no key serves the member and they have not dismissed
 *  it; the key form, once opened from any surface, keeps it shown. */
export function startFreeVisible(keys: ModelKeyState, dismissed: boolean, formOpen: boolean): boolean {
  return formOpen || (keys.needsKey && !dismissed);
}

/** The free model a member whose one key is OpenRouter starts on. */
export function startFreeModel(keys: ModelKeyState, models: EngineModelCatalog): string | null {
  return keys.onlyOpenRouter ? (models.opencode?.find(isFreeModel) ?? null) : null;
}

const dismissedKey = (userId: string) => `start-free-dismissed:${userId}`;

export function startFreeDismissed(userId: string): boolean {
  try {
    return window.localStorage.getItem(dismissedKey(userId)) !== null;
  } catch {
    return false;
  }
}

export function dismissStartFree(userId: string): void {
  try {
    window.localStorage.setItem(dismissedKey(userId), new Date().toISOString());
  } catch {
    // A browser that refuses storage shows the card again on the next visit.
  }
}

export function useStartFree() {
  const { session } = useSession();
  const userId = session?.user.id;
  const [keys, setKeys] = useState(UNKNOWN);
  // Hidden until this member's dismissal is read, so it never flashes.
  const [dismissed, setDismissed] = useState(true);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [connections, config, secrets] = await Promise.all([
        fetchProviderConnections(),
        fetchDeploymentConfig(),
        fetchSecrets(),
      ]);
      setKeys(modelKeyState({ connections, config, secretNames: secrets.map((secret) => secret.name) }));
    } catch {
      setKeys(UNKNOWN);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useOrgChanges((change) => {
    if (change.type === "provider_connection") void load();
  });
  useEffect(() => {
    if (userId) setDismissed(startFreeDismissed(userId));
  }, [userId]);

  const openForm = useCallback(() => setFormOpen(true), []);
  const dismiss = useCallback(() => {
    setFormOpen(false);
    setDismissed(true);
    if (userId) dismissStartFree(userId);
  }, [userId]);
  const saved = useCallback(async () => {
    invalidateCapabilityCatalog();
    await load();
    setFormOpen(false);
  }, [load]);

  return { ...keys, visible: startFreeVisible(keys, dismissed, formOpen), formOpen, openForm, dismiss, saved };
}

/** The one action every surface offers: open the key form above the composer. */
export function AddOpenRouterKey({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-text-secondary underline underline-offset-2 hover:text-text-primary"
    >
      Add OpenRouter key
    </button>
  );
}

/** The model picker's Free note while no key serves OpenRouter. */
export function FreeLaneNote({ onAdd }: { onAdd: () => void }) {
  return (
    <>
      Free on your own OpenRouter key. <AddOpenRouterKey onClick={onAdd} />
    </>
  );
}

export function StartFreePrompt({
  formOpen,
  connection,
  onAdd,
  onDismiss,
  onSaved,
}: {
  formOpen: boolean;
  connection: ProviderConnectionMeta | null;
  onAdd: () => void;
  onDismiss: () => void;
  onSaved: () => Promise<void>;
}) {
  return (
    <section
      aria-label="Start free with OpenRouter"
      data-testid="start-free-prompt"
      className="mb-4 flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-primary-default px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-body-2-regular text-text-secondary">
          <span className="text-body-2-medium text-text-primary">Start free with OpenRouter.</span> Free models cost
          nothing on your own OpenRouter key.
        </p>
        {formOpen ? null : (
          <Button variant="neutral" size="xs" className="rounded-full" onClick={onAdd}>
            Add OpenRouter key
          </Button>
        )}
        <a
          href={FREE_KEY_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-caption-1-medium text-text-secondary hover:text-text-primary"
        >
          Get a free key
          <RiArrowRightUpLine className="size-3.5" aria-hidden />
        </a>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex size-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-primary-hover hover:text-text-primary"
        >
          <RiCloseLine className="size-4" aria-hidden />
        </button>
      </div>
      {formOpen ? (
        <ProviderKeyForm provider="openrouter" connection={connection} onSaved={onSaved} compact />
      ) : null}
    </section>
  );
}
