// The thread's current task plan for the details rail: the newest turn that
// planned, read from its canonical plan.updated events (the latest wins) or,
// without those, its last todowrite step. Null when no turn has planned yet.

import type { CanonicalEventLike } from "@/components/chat/canonical-timeline";
import type { TimelinePlanEntry } from "@/components/chat/timeline";
import { type ApiStep, parseTodos } from "@/components/chat/types";

/** What the plan needs of a turn; the conversation's Turn satisfies it. */
export interface PlanTurn {
  readonly steps: readonly ApiStep[];
  readonly canonical?: readonly CanonicalEventLike[];
}

export function latestThreadPlan(turns: readonly PlanTurn[]): readonly TimelinePlanEntry[] | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) continue;
    const planned = (turn.canonical ?? [])
      .filter((event) => event.kind === "plan.updated" && event.entries !== undefined)
      .toSorted((a, b) => b.seq - a.seq)[0];
    if (planned?.entries) return planned.entries;
    for (let at = turn.steps.length - 1; at >= 0; at -= 1) {
      const step = turn.steps[at];
      const todos = step ? parseTodos(step) : null;
      if (todos) return todos.map(({ id, content, status }) => ({ id, text: content, status }));
    }
  }
  return null;
}
