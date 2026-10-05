"use client";

// The steps a turn's subagents ran, as the set of step ids the subagents fold
// attributes to a child (the same merged children projection it renders from).
// The turn's trace leaves those steps to the child's own row, so a subagent's
// command never reads as the parent's work and never renders twice.

import { useMemo } from "react";
import type { Turn } from "@/components/chat/conversation";
import { deriveChildrenViewFromExecutionSummary } from "@/components/chat/execution-summary-rollout";

export function useChildSteps(
  turn: Pick<Turn, "steps" | "native" | "canonical" | "executionSummary">,
): ReadonlySet<string> {
  const { steps, native, canonical, executionSummary } = turn;
  return useMemo(
    () =>
      new Set(
        deriveChildrenViewFromExecutionSummary(
          steps,
          native?.nativeFrames ?? [],
          canonical ?? [],
          executionSummary ?? null,
        ).ownerByStep.keys(),
      ),
    [steps, native?.nativeFrames, canonical, executionSummary],
  );
}
