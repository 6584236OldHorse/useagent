"use client";

// The status tab's context popover as the reference's usage card: the context
// window (used / window and the percent as the ring computes them) over a
// segmented bar of the buckets the runtime's usage frames carry, expandable to
// the per-bucket breakdown and free space; below it the member's usage limits,
// sandbox minutes and spend, each "x of y" with a bar while a cap is set and
// no reset line, since neither ledger is periodic today. Compact stays the
// card's action. The minutes are read when the popover opens; spend is the
// snapshot the tab already holds.

import { useEffect, useState } from "react";
import type { ConversationContext } from "@/components/pro/composer-status-bar";
import {
  AgentLimitsCard,
  type ContextSegment,
  type UsageLimit,
} from "@/components/pro/agent-limits-card";
import { backendFetch } from "@/lib/backend-fetch";
import { parseSandboxMinutes, type SandboxMinutes } from "@/lib/sandbox-minutes";
import { money, type SpendSnapshot } from "@/lib/spend";

/** The buckets a usage frame carries, in the order the bar draws them; a bucket
 *  the runtime did not report is left out rather than drawn as zero. */
export function contextSegments(context: ConversationContext): ContextSegment[] {
  const buckets: { label: string; tokens: number | undefined }[] = [
    { label: "Fresh input", tokens: context.input },
    { label: "Cached input", tokens: context.cached },
    { label: "Output", tokens: context.output },
    { label: "Reasoning", tokens: context.reasoning },
    { label: "Cache write", tokens: context.cacheWrite },
  ];
  return buckets.flatMap(({ label, tokens }) => (tokens && tokens > 0 ? [{ label, tokens }] : []));
}

/** "12 of 600 min" with a bar while a cap is set; "12 min" alone without one. */
export function minutesLimit(minutes: SandboxMinutes): UsageLimit {
  return minutes.cap === null
    ? { label: "Sandbox minutes", detail: `${minutes.used} min` }
    : {
        label: "Sandbox minutes",
        detail: `${minutes.used} of ${minutes.cap} min`,
        used: minutes.used / Math.max(1, minutes.cap),
      };
}

/** "$12.34 of $100" with a bar while an allowance is set; "$12.34" alone without one. */
export function spendLimit(spend: SpendSnapshot): UsageLimit {
  const spent = money(Number(spend.spent.toFixed(2)));
  return spend.allowance === null
    ? { label: "Spend", detail: spent }
    : {
        label: "Spend",
        detail: `${spent} of ${money(spend.allowance)}`,
        used: spend.spent / Math.max(Number.EPSILON, spend.allowance),
      };
}

async function fetchSandboxMinutes(signal: AbortSignal): Promise<SandboxMinutes | null> {
  const res = await backendFetch("/api/sandbox-minutes", { signal, cache: "no-store" });
  return res.ok ? parseSandboxMinutes(await res.json()) : null;
}

export function UsageCard({
  context,
  spend,
  onCompact,
  minutes: minutesProp,
}: {
  context: ConversationContext;
  spend?: SpendSnapshot | null;
  onCompact?: () => void;
  /** Supplied by tests and the lab; the card reads the member's minutes itself otherwise. */
  minutes?: SandboxMinutes | null;
}) {
  const [minutes, setMinutes] = useState<SandboxMinutes | null>(minutesProp ?? null);
  useEffect(() => {
    if (minutesProp !== undefined) return;
    const ctrl = new AbortController();
    void fetchSandboxMinutes(ctrl.signal)
      .then((next) => {
        if (next) setMinutes(next);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [minutesProp]);
  const limits: UsageLimit[] = [
    ...(minutes ? [minutesLimit(minutes)] : []),
    ...(spend ? [spendLimit(spend)] : []),
  ];
  return (
    <div className="flex flex-col gap-1">
      <AgentLimitsCard
        context={{ max: context.window, used: context.used, segments: contextSegments(context) }}
        limitsTitle="Usage limits"
        plan=""
        limits={limits}
        className="bg-transparent px-2 pt-1 pb-2"
      />
      <p className="px-2 pb-1 text-caption-1-regular text-text-tertiary">
        The agent compacts the conversation on its own near the window limit.
      </p>
      {onCompact && (
        <button
          type="button"
          onClick={onCompact}
          className="mx-1 mt-0.5 flex h-8 cursor-pointer items-center justify-center rounded-lg border border-border-button-default text-body-2-medium text-text-primary transition-colors hover:bg-background-primary-hover"
        >
          Compact now
        </button>
      )}
    </div>
  );
}
