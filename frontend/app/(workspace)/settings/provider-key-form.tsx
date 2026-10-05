"use client";

import { RiKey2Line } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { cx } from "@/utils/cx";
import { SpinnerIcon } from "./connection-status-chip";
import { putProviderApiKey } from "./provider-connections-api";
import {
  PROVIDER_LABELS,
  type ProviderConnectionMeta,
  type ProviderConnectionProvider,
  safeProviderMetadata,
} from "./provider-connections-data";

/** The save-key form: the key and, in Settings, the account email and label
 *  filed with it. The start-free card above the home composer shows the key
 *  alone. A saved key is write-only: the field clears and `onSaved` reloads. */
export function ProviderKeyForm({
  provider,
  connection,
  onSaved,
  compact = false,
}: {
  provider: ProviderConnectionProvider;
  connection: ProviderConnectionMeta | null;
  onSaved: () => Promise<void>;
  /** The key field and Save alone, without the optional email and label. */
  compact?: boolean;
}) {
  const labels = PROVIDER_LABELS[provider];
  const [apiKey, setApiKey] = useState("");
  const [email, setEmail] = useState("");
  const [planType, setPlanType] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEmail(connection?.metadata.email ?? "");
    setPlanType(connection?.metadata.planType ?? "");
  }, [connection?.metadata.email, connection?.metadata.planType]);

  const save = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await putProviderApiKey({
        provider,
        apiKey: trimmed,
        metadata: safeProviderMetadata({ email, planType }),
      });
      setApiKey("");
      await onSaved();
    } catch {
      setError(`Couldn't save the ${labels.name} API key.`);
    } finally {
      setSaving(false);
    }
  }, [apiKey, email, labels.name, onSaved, planType, provider]);

  return (
    <form
      className={cx("flex flex-col gap-2", !compact && "py-3")}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div
        className={cx(
          "grid gap-2",
          compact
            ? "grid-cols-[minmax(0,1fr)_auto]"
            : "lg:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_auto]",
        )}
      >
        <InputBase
          aria-label={`${labels.name} API key`}
          placeholder={labels.keyPlaceholder}
          type="password"
          autoComplete="off"
          spellCheck={false}
          leadingIcon={RiKey2Line}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
        {compact ? null : (
          <>
            <InputBase
              aria-label={`${labels.name} account email`}
              placeholder="Account email (optional)"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <InputBase
              aria-label={`${labels.name} plan or label`}
              placeholder="Label (optional)"
              value={planType}
              onChange={(event) => setPlanType(event.target.value)}
            />
          </>
        )}
        <Button
          type="submit"
          variant="secondary"
          size="small"
          className="rounded-full"
          disabled={apiKey.trim().length === 0 || saving}
          leadingIcon={saving ? SpinnerIcon : undefined}
        >
          Save key
        </Button>
      </div>
      {error ? <p className="text-caption-1-regular text-text-error-primary">{error}</p> : null}
    </form>
  );
}
