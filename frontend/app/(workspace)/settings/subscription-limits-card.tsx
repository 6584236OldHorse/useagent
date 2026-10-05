"use client";

import { useCallback, useEffect, useState } from "react";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { AgentLimitsCard, type UsageLimit } from "@/components/pro/agent-limits-card";
import { fetchCodexRateLimits } from "./provider-connections-api";
import type { CodexRateLimits, CodexRateLimitWindow } from "./provider-connections-data";

// Plan usage limits for the Codex engine when it runs on the user's ChatGPT
// subscription: the 5-hour and weekly windows the provider enforces, with
// their reset times. Hidden when no subscription is signed in.

function windowLabel(window: CodexRateLimitWindow, fallback: string): string {
  const mins = window.windowDurationMins;
  if (!mins) return fallback;
  if (mins % 10_080 === 0) return mins === 10_080 ? "Weekly limit" : `${mins / 10_080}-week limit`;
  if (mins % 1_440 === 0) return mins === 1_440 ? "Daily limit" : `${mins / 1_440}-day limit`;
  if (mins % 60 === 0) return `${mins / 60}-hour limit`;
  return `${mins}-minute limit`;
}

function resetCopy(resetsAt: number | null, now: Date): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt * 1000);
  const minutes = Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) return `Resets in ${minutes} min`;
  if (minutes < 24 * 60) return `Resets in ${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  return `Resets ${at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

export function limitRows(limits: CodexRateLimits, now: Date): UsageLimit[] {
  const rows: UsageLimit[] = [];
  const push = (window: CodexRateLimitWindow | null, fallback: string) => {
    if (!window) return;
    rows.push({
      label: windowLabel(window, fallback),
      used: Math.min(1, Math.max(0, window.usedPercent / 100)),
      resets: resetCopy(window.resetsAt, now),
    });
  };
  push(limits.primary, "Session limit");
  push(limits.secondary, "Weekly limit");
  return rows;
}

const PLAN_NAMES: Record<string, string> = {
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
  free: "Free",
};

export function SubscriptionLimitsCard() {
  const [limits, setLimits] = useState<CodexRateLimits | null>(null);
  const refresh = useCallback(() => {
    fetchCodexRateLimits()
      .then(setLimits)
      .catch(() => setLimits(null));
  }, []);
  useEffect(refresh, [refresh]);
  // Connecting or revoking the account elsewhere on the page changes the answer.
  useOrgChanges((change) => {
    if (change.type === "provider_connection") refresh();
  });
  if (!limits) return null;
  const rows = limitRows(limits, new Date());
  if (rows.length === 0) return null;
  const plan = limits.planType
    ? (PLAN_NAMES[limits.planType.toLowerCase()] ?? limits.planType)
    : "";
  return (
    <AgentLimitsCard plan={plan ? `ChatGPT ${plan}` : "ChatGPT"} limits={rows} className="mb-4" />
  );
}
