// The thread's usage for the details rail, from what the engine reported: the
// input and output tokens summed over the parent session's step-finish frames
// (the same frames the context ring reads; null when no frame carried tokens,
// so the tile can say "not reported") and the tool calls counted from every
// turn's durable steps in the trace's own grammar.

import type { NativeFrame } from "@/components/chat/native-events";
import { traceRowsFromWork, turnNodesFromSteps } from "@/components/chat/turn-trace-model";
import { type ApiStep, asRecord, type RunStatus } from "@/components/chat/types";

export interface ThreadUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly toolCalls: number;
}

/** What the usage needs of a turn; the conversation's Turn satisfies it. */
export interface UsageTurn {
  readonly run: { readonly child_session?: unknown };
  readonly steps: readonly ApiStep[];
  readonly status: RunStatus;
  readonly native?: {
    readonly nativeFrames: readonly NativeFrame[];
    readonly childSessionIds: ReadonlySet<string>;
  };
}

const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function threadUsage(turns: readonly UsageTurn[]): ThreadUsage {
  let input = 0;
  let output = 0;
  let reported = false;
  let toolCalls = 0;
  for (const turn of turns) {
    // A gateway child session measures its own window; its turns are its own.
    if (!turn.run.child_session) {
      const native = turn.native;
      for (const frame of native?.nativeFrames ?? []) {
        if (frame.eventType !== "part.step-finish") continue;
        if (frame.native.parentSessionId) continue;
        if (frame.native.sessionId && native?.childSessionIds.has(frame.native.sessionId)) continue;
        const payload = asRecord(frame.payload);
        const tokens = payload ? asRecord(payload.tokens) : null;
        if (!tokens) continue;
        const fresh = readNumber(tokens.input);
        const out = readNumber(tokens.output);
        if (fresh === null && out === null) continue;
        const cache = asRecord(tokens.cache);
        reported = true;
        input += (fresh ?? 0) + (readNumber(cache?.read) ?? 0) + (readNumber(cache?.write) ?? 0);
        output += (out ?? 0) + (readNumber(tokens.reasoning) ?? 0);
      }
    }
    toolCalls += traceRowsFromWork(turnNodesFromSteps(turn.steps, false, turn.status), false).filter(
      (row) => row.kind === "step" && row.family !== "reasoning" && row.family !== "boot",
    ).length;
  }
  return {
    inputTokens: reported ? input : null,
    outputTokens: reported ? output : null,
    toolCalls,
  };
}
