"use client";

import { RiArrowRightUpLine, RiCloseLine } from "@remixicon/react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  PROVIDER_LABELS,
  type ProviderConnectionMeta,
  type ProviderConnectionProvider,
} from "@/app/(workspace)/settings/provider-connections-data";
import { Button } from "@/components/base/buttons/button";
import type { ModelKeyAccess } from "@/components/chat/catalog-model-picker";
import { invalidateCapabilityCatalog } from "@/hooks/use-capability-catalog";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { useSession } from "@/lib/auth";

/**
 * Start free: a member with no model key is one step from a working free model.
 * The card above the home composer says free models cost nothing on their own
 * OpenRouter key and opens the Settings key form in place, key field alone. The
 * same action sits in the picker's Free note and the composer's send error, and
 * a model whose provider no key serves opens that provider's form the same way.
 * While any read is unknown nothing is shown or refused: the backend stays the
 * judge of a run.
 */

export const FREE_KEY_URL = "https://openrouter.ai/settings/keys";
export const START_FREE_ERROR = "Add a model key to send. Free models cost nothing on your own OpenRouter key.";

export interface ModelKeyState {
  /** The reads below resolved; until then no model is marked or refused. */
  readonly known: boolean;
  /** Offered providers an API key serves this member: their own, the
   *  organization's secret, or this deployment's. */
  readonly served: readonly string[];
  /** The member's own Codex account, which runs Codex without an OpenAI key. */
  readonly codexAccount: boolean;
  /** No key of any kind serves this member, and an OpenRouter key would. */
  readonly needsKey: boolean;
  /** OpenRouter is offered to this member and no key serves it. */
  readonly openRouterMissing: boolean;
  /** OpenRouter is the one provider a key serves, so a free model is the safe start. */
  readonly onlyOpenRouter: boolean;
  /** The member's own key rows, so a form shows a rejected key. */
  readonly connections: readonly ProviderConnectionMeta[];
}

const UNKNOWN: ModelKeyState = {
  known: false,
  served: [],
  codexAccount: false,
  needsKey: false,
  openRouterMissing: false,
  onlyOpenRouter: false,
  connections: [],
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
  const active = (provider: string, authMethod: ProviderConnectionMeta["authMethod"]) =>
    input.connections.some(
      (connection) =>
        connection.provider === provider && connection.authMethod === authMethod && isActiveConnection(connection),
    );
  const served = offered.filter(
    (provider) =>
      active(provider, "api_key") ||
      input.secretNames.includes(`${provider.toUpperCase()}_API_KEY`) ||
      input.config.servedProviders.includes(provider),
  );
  const codexAccount = offered.includes("openai") && active("openai", "chatgpt_oauth");
  const anyKey = served.length > 0 || codexAccount;
  const openRouterOffered = offered.includes("openrouter");
  return {
    known: true,
    served,
    codexAccount,
    needsKey: openRouterOffered && !anyKey,
    openRouterMissing: openRouterOffered && !served.includes("openrouter"),
    onlyOpenRouter: !codexAccount && served.length === 1 && served[0] === "openrouter",
    connections: input.connections,
  };
}

/** The provider whose key `engine` needs to run a model on `provider` and this
 *  member lacks; null when a key serves it, the answer is unknown, or no member
 *  key could serve it (the backend judges those). */
export function missingKey(
  keys: ModelKeyState,
  engine: string,
  provider: string | undefined,
): ProviderConnectionProvider | null {
  if (!keys.known || !provider || keys.served.includes(provider)) return null;
  if (engine === "codex" && keys.codexAccount) return null;
  return MODEL_PROVIDER_CONNECTION_PROVIDERS.find((candidate) => candidate === provider) ?? null;
}

/** The card shows while it is wanted (no key serves the member, or their model
 *  needs one they lack) and not dismissed; an open key form always shows it. */
export function startFreeVisible(
  wanted: boolean,
  dismissed: boolean,
  formProvider: ProviderConnectionProvider | null,
): boolean {
  return formProvider !== null || (wanted && !dismissed);
}

/** The free model the composer starts on, from the free models this member can
 *  run: when OpenRouter is their one key, or when the chosen model needs a key
 *  they lack. */
export function startFreeModel(
  keys: ModelKeyState,
  runnableFree: readonly string[],
  selectionLocked: boolean,
): string | null {
  return keys.onlyOpenRouter || selectionLocked ? (runnableFree[0] ?? null) : null;
}

/** The send refusal for a model whose provider no key of the member's serves. */
export function keyRequiredError(provider: ProviderConnectionProvider): string {
  return `This model runs on your own ${PROVIDER_LABELS[provider].name} key. Add it to send.`;
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
  // The provider whose key form is open above the composer, if any.
  const [formProvider, setFormProvider] = useState<ProviderConnectionProvider | null>(null);

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

  const openForm = useCallback((provider: ProviderConnectionProvider) => setFormProvider(provider), []);
  const closeForm = useCallback(() => setFormProvider(null), []);
  const dismiss = useCallback(() => {
    setFormProvider(null);
    setDismissed(true);
    if (userId) dismissStartFree(userId);
  }, [userId]);
  const saved = useCallback(async () => {
    invalidateCapabilityCatalog();
    await load();
    setFormProvider(null);
  }, [load]);
  // What the pickers read: which models need a key, and the form to add it.
  const access = useMemo<ModelKeyAccess>(
    () => ({ missing: (engine, provider) => missingKey(keys, engine, provider), onAdd: openForm }),
    [keys, openForm],
  );
  const formConnection =
    keys.connections.find((connection) => connection.provider === formProvider && connection.authMethod === "api_key") ??
    null;

  return { ...keys, dismissed, formProvider, formConnection, openForm, closeForm, dismiss, saved, access };
}

/** The one action every surface offers: open a provider's key form in place. */
export function AddProviderKey({ provider, onClick }: { provider: ProviderConnectionProvider; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-text-secondary underline underline-offset-2 hover:text-text-primary"
    >
      Add {PROVIDER_LABELS[provider].name} key
    </button>
  );
}

/** The card above a composer: the OpenRouter start-free offer, or, once a model
 *  that needs another provider's key was picked, that provider's key form. */
export function StartFreePrompt({
  formProvider,
  connection,
  onAdd,
  onDismiss,
  onSaved,
}: {
  /** The provider whose key form is open; null shows the offer alone. */
  formProvider: ProviderConnectionProvider | null;
  connection: ProviderConnectionMeta | null;
  /** Open the OpenRouter key form. */
  onAdd: () => void;
  onDismiss: () => void;
  onSaved: () => Promise<void>;
}) {
  const provider = formProvider ?? "openrouter";
  const name = PROVIDER_LABELS[provider].name;
  const openRouter = provider === "openrouter";
  return (
    <section
      aria-label={openRouter ? "Start free with OpenRouter" : `Add your ${name} key`}
      data-testid="start-free-prompt"
      className="mb-4 flex flex-col gap-3 rounded-2xl border border-border-button-default bg-background-primary-default px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        {openRouter ? (
          <p className="min-w-0 flex-1 text-body-2-regular text-text-secondary">
            <span className="text-body-2-medium text-text-primary">Start free with OpenRouter.</span> Free models cost
            nothing on your own OpenRouter key.
          </p>
        ) : (
          <p className="min-w-0 flex-1 text-body-2-regular text-text-secondary">
            <span className="text-body-2-medium text-text-primary">Add your {name} key.</span> {name} models run on
            your own key.
          </p>
        )}
        {formProvider ? null : (
          <Button variant="neutral" size="xs" className="rounded-full" onClick={onAdd}>
            Add OpenRouter key
          </Button>
        )}
        {openRouter ? (
          <a
            href={FREE_KEY_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-caption-1-medium text-text-secondary hover:text-text-primary"
          >
            Get a free key
            <RiArrowRightUpLine className="size-3.5" aria-hidden />
          </a>
        ) : null}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex size-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-primary-hover hover:text-text-primary"
        >
          <RiCloseLine className="size-4" aria-hidden />
        </button>
      </div>
      {formProvider ? (
        <ProviderKeyForm key={formProvider} provider={formProvider} connection={connection} onSaved={onSaved} compact />
      ) : null}
    </section>
  );
}
