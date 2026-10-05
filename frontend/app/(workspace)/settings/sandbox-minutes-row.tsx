"use client";

import { useEffect, useState } from "react";
import { Chip } from "@/components/base/badges/chip";
import { backendFetch } from "@/lib/backend-fetch";
import {
  parseSandboxMinutes,
  type SandboxMinutes,
  sandboxMinutesCapped,
  sandboxMinutesLabel,
} from "@/lib/sandbox-minutes";
import { SettingsRow } from "./settings-rows";

// The member's sandbox minutes row in Settings > Usage: the time their settled
// tasks held a sandbox against the deployment's per-member cap, live from
// GET /api/sandbox-minutes.

// The figures and their words live in lib/sandbox-minutes so the composer's
// usage card reads the same shape; re-exported here for this row's callers.
export {
  parseSandboxMinutes,
  type SandboxMinutes,
  sandboxMinutesCapped,
  sandboxMinutesLabel,
} from "@/lib/sandbox-minutes";

export function SandboxMinutesRow() {
  const [minutes, setMinutes] = useState<SandboxMinutes | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    void backendFetch("/api/sandbox-minutes", { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => (res.ok ? parseSandboxMinutes(await res.json()) : null))
      .then((next) => {
        if (next) setMinutes(next);
        else setUnavailable(true);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setUnavailable(true);
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
        {minutes ? sandboxMinutesLabel(minutes) : unavailable ? "Unavailable" : "Loading..."}
      </Chip>
    </SettingsRow>
  );
}
