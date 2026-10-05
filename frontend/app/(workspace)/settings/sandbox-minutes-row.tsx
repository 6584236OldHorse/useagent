"use client";

import { useEffect, useState } from "react";
import { Chip } from "@/components/base/badges/chip";
import { backendFetch } from "@/lib/backend-fetch";
import { SettingsRow } from "./settings-rows";

// The member's sandbox minutes row in Settings > Usage: the time their settled
// tasks held a sandbox against the deployment's per-member cap, live from
// GET /api/sandbox-minutes.

export interface SandboxMinutes {
  readonly used: number;
  /** Null when the deployment runs without a cap. */
  readonly cap: number | null;
}

/** Normalize GET /api/sandbox-minutes; null on an unusable shape. */
export function parseSandboxMinutes(data: unknown): SandboxMinutes | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.used !== "number" || !Number.isFinite(d.used)) return null;
  return { used: d.used, cap: typeof d.cap === "number" && Number.isFinite(d.cap) ? d.cap : null };
}

/** "Used 12 of 600 minutes"; without a cap, just what was used. */
export function sandboxMinutesLabel(minutes: SandboxMinutes): string {
  if (minutes.cap !== null) return `Used ${minutes.used} of ${minutes.cap} minutes`;
  return `Used ${minutes.used} ${minutes.used === 1 ? "minute" : "minutes"}`;
}

export function sandboxMinutesCapped(minutes: SandboxMinutes): boolean {
  return minutes.cap !== null && minutes.used >= minutes.cap;
}

export function SandboxMinutesRow() {
  const [minutes, setMinutes] = useState<SandboxMinutes | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    void backendFetch("/api/sandbox-minutes", { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => (res.ok ? parseSandboxMinutes(await res.json()) : null))
      .then((next) => {
        if (next) setMinutes(next);
      })
      .catch(() => {
        // Keep the loading label; the row is informational.
      });
    return () => ctrl.abort();
  }, []);

  const description =
    minutes?.cap === null
      ? "Time your tasks held a sandbox. This deployment sets no cap."
      : "Time your tasks held a sandbox. New tasks pause at the cap.";
  return (
    <SettingsRow label="Sandbox minutes" description={description}>
      <Chip variant="caption" color={minutes && sandboxMinutesCapped(minutes) ? "rose" : "soft"}>
        {minutes ? sandboxMinutesLabel(minutes) : "Loading..."}
      </Chip>
    </SettingsRow>
  );
}
