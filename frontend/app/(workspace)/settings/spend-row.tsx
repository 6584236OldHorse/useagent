"use client";

import { Chip } from "@/components/base/badges/chip";
import { useSpend } from "@/hooks/use-spend";
import { spendCapped, spendLabel } from "@/lib/spend";
import { SettingsRow } from "./settings-rows";

// The member's allowance row in Settings > Usage: settled model cost against the
// cap, live from GET /api/spend (same source as the composer chip).
export function SpendRow() {
  const spend = useSpend();
  const description =
    spend?.allowance === null
      ? "Settled model cost of your runs. This deployment sets no cap."
      : "Settled model cost of your runs. New tasks pause at the allowance.";
  return (
    <SettingsRow label="Allowance" description={description}>
      <Chip variant="caption" color={spend && spendCapped(spend) ? "rose" : "soft"}>
        {spend ? spendLabel(spend) : "Loading..."}
      </Chip>
    </SettingsRow>
  );
}
