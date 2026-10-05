"use client";

import { useCallback, useEffect, useState } from "react";
import { Select, SelectItem } from "@/components/base/select/select";
import { backendFetch } from "@/lib/backend-fetch";
import { SettingsCard, SettingsRow } from "./settings-rows";

// The member's preferred sandbox provider in Settings > Infrastructure: which of
// the providers this deployment can run starts their NEW sandboxes. Picking the
// deployment default clears the preference; a thread keeps the sandbox it has.

export interface SandboxPreference {
  readonly provider: string | null;
  readonly defaultProvider: string;
  readonly enabled: ReadonlyArray<{ readonly kind: string; readonly label: string }>;
}

/** Normalize GET/PUT /api/sandbox-preference; null on an unusable shape. */
export function parseSandboxPreference(data: unknown): SandboxPreference | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.defaultProvider !== "string" || !Array.isArray(d.enabled)) return null;
  const enabled = d.enabled.flatMap((item) => {
    const p = item as Record<string, unknown> | null;
    return p && typeof p.kind === "string" && typeof p.label === "string" ? [{ kind: p.kind, label: p.label }] : [];
  });
  return { provider: typeof d.provider === "string" ? d.provider : null, defaultProvider: d.defaultProvider, enabled };
}

const jsonHeaders = { "content-type": "application/json" } as const;

export function SandboxProviderSelect({
  preference,
  disabled,
  onChoose,
}: {
  preference: SandboxPreference;
  disabled: boolean;
  onChoose: (provider: string | null) => void;
}) {
  return (
    <Select
      aria-label="Preferred sandbox provider"
      selectedKey={preference.provider ?? preference.defaultProvider}
      isDisabled={disabled}
      onSelectionChange={(key) => onChoose(String(key) === preference.defaultProvider ? null : String(key))}
    >
      {preference.enabled.map((option) => {
        const label = option.kind === preference.defaultProvider ? `${option.label} (default)` : option.label;
        return (
          <SelectItem key={option.kind} id={option.kind} textValue={label}>
            {label}
          </SelectItem>
        );
      })}
    </Select>
  );
}

export function SandboxProviderRow() {
  const [preference, setPreference] = useState<SandboxPreference | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    void backendFetch("/api/sandbox-preference", { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => (res.ok ? parseSandboxPreference(await res.json()) : null))
      .then((next) => {
        if (next) setPreference(next);
        else setUnavailable(true);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setUnavailable(true);
      });
    return () => ctrl.abort();
  }, []);

  const choose = useCallback(async (provider: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const res = await backendFetch("/api/sandbox-preference", {
        method: "PUT",
        headers: jsonHeaders,
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const next = parseSandboxPreference(await res.json());
      if (next) setPreference(next);
    } catch {
      setError("Couldn't save the provider preference. Try again.");
    } finally {
      setSaving(false);
    }
  }, []);

  const description =
    preference && preference.enabled.length < 2
      ? "Where your new sandboxes start. This deployment runs one provider."
      : "Where your new sandboxes start. A thread keeps the sandbox it already has.";
  return (
    <SettingsCard>
      <SettingsRow label="Preferred sandbox provider" description={description}>
        {preference ? (
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <SandboxProviderSelect
              preference={preference}
              disabled={saving || preference.enabled.length < 2}
              onChoose={(provider) => void choose(provider)}
            />
            {error ? (
              <p role="alert" className="text-caption-1-regular text-text-error-primary">
                {error}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-body-2-regular text-text-secondary">{unavailable ? "Unavailable" : "Loading..."}</p>
        )}
      </SettingsRow>
    </SettingsCard>
  );
}
