// What the running turn is doing right now, for the composer's running footer:
// the phase chip (Thinking / Working / Delegating <name>), the current step as
// a sentence, and the popover counts. Pure; reads only what the session already
// holds (the turn's durable steps, its native frames, the merged children view).
//
// Every engine emits the same `part.*` frame grammar (opencode natively; the
// native bridges for claude, codex and pi map onto it in the backend), so the
// newest root-session part frame names the current activity. A turn with no
// frames yet (an engine that streams deltas only, the boot gap) falls back to
// its newest durable step and then to the live delta channel.

import type { ThreadRelationship } from "@useagent/agent-client";
import { isChildActive } from "@/components/chat/agent-status";
import type { MergedChildFidelity } from "@/components/chat/canonical-children";
import type { CanonicalEventLike } from "@/components/chat/canonical-timeline";
import type { Turn } from "@/components/chat/conversation";
import { deriveChildrenViewFromExecutionSummary } from "@/components/chat/execution-summary-rollout";
import {
  firstLine,
  type GatewayChildSession,
  RUN_CHILD_STATUS,
  RUN_STATUS_LABEL,
} from "@/components/chat/gateway-children";
import type { NativeFrame } from "@/components/chat/native-events";
import { nativeOf } from "@/components/chat/native-ids";
import { isNarration } from "@/components/chat/timeline";
import { clip, summarizeToolStep } from "@/components/chat/tool-summary";
import { type ApiStep, deriveTrace, isRenderableTimelineStep } from "@/components/chat/types";

export type RunningPhase = "thinking" | "working" | "delegating";

export interface RunningStatus {
  readonly phase: RunningPhase;
  /** The chip text: "Thinking", "Working", "Delegating <name>". */
  readonly label: string;
  /** The current step as a plain sentence. */
  readonly sentence: string;
  /** Tool calls the turn has made so far (boot and reasoning rows excluded). */
  readonly toolCalls: number;
  readonly agentsRunning: number;
  readonly agentsDone: number;
}

const NAME_MAX = 40;
const STEP_MAX = 96;
export const NEXT_STEP = "Working through the next step";
const WRITING = "Writing the reply";
const STARTING = "Starting up";

/** The only fields of a turn the derivation reads (a `Turn` satisfies it). */
type RunningTurn = Pick<Turn, "steps" | "liveText" | "liveReasoning" | "executionSummary"> & {
  readonly native?: { readonly nativeFrames: readonly NativeFrame[] } | undefined;
  readonly canonical?: readonly CanonicalEventLike[] | undefined;
};

const PRODUCT_ACTIVE = new Set<ThreadRelationship["status"]>(["queued", "waiting", "running"]);

/** A tool step the turn made: renderable, not the answer placeholder, not
 *  sandbox boot or a reasoning row. */
function isToolCall(step: ApiStep): boolean {
  if (step.kind === "done" || !isRenderableTimelineStep(step) || isNarration(step)) return false;
  const glyph = deriveTrace(step).glyph;
  return glyph !== "boot" && glyph !== "reasoning";
}

interface Delegate {
  readonly name: string;
  readonly sentence: string;
}

interface Children {
  readonly running: number;
  readonly done: number;
  /** The first child still active, when any is. */
  readonly active: Delegate | null;
}

function countChildren(
  turn: RunningTurn,
  childSessions: readonly GatewayChildSession[],
  productChildren: readonly ThreadRelationship[],
): Children {
  const frames = turn.native?.nativeFrames ?? [];
  const view = deriveChildrenViewFromExecutionSummary(
    turn.steps,
    frames,
    turn.canonical ?? [],
    turn.executionSummary ?? null,
  );
  let running = 0;
  let done = 0;
  let active: Delegate | null = null;
  const tally = (isActive: boolean, delegate: () => Delegate) => {
    if (isActive) {
      running += 1;
      active ??= delegate();
    } else done += 1;
  };
  for (const card of view.cards) {
    let fidelity: MergedChildFidelity | undefined;
    for (const alias of card.aliases) fidelity ??= view.fidelity.get(alias);
    // Same fallback as the inline fold: a child without a status frame is running while its parent is.
    tally(isChildActive(fidelity?.status ?? "running"), () => ({
      name: fidelity?.role ?? card.title,
      sentence: fidelity?.progress ?? card.status ?? "Working",
    }));
  }
  for (const child of childSessions) {
    tally(isChildActive(RUN_CHILD_STATUS[child.status]), () => ({
      name: child.prompt,
      sentence: child.summary ? firstLine(child.summary) : RUN_STATUS_LABEL[child.status],
    }));
  }
  for (const child of productChildren) {
    tally(PRODUCT_ACTIVE.has(child.status), () => ({
      name: child.bot?.name ?? child.title,
      sentence: child.latestSummary ? firstLine(child.latestSummary) : "Working",
    }));
  }
  return { running, done, active };
}

/** The tool step a `part.tool*` frame belongs to: by native call id, else the newest tool step. */
function toolStepFor(frame: NativeFrame, steps: readonly ApiStep[]): ApiStep | undefined {
  const callId = frame.native.callId;
  const byCall = callId ? steps.find((step) => nativeOf(step)?.callID === callId) : undefined;
  return byCall ?? steps.findLast(isToolCall);
}

/** The step sentence for a durable step. */
function stepSentence(step: ApiStep): string {
  const trace = deriveTrace(step);
  if (trace.glyph === "boot") return clip(trace.target || STARTING, STEP_MAX);
  return summarizeToolStep(step).label;
}

/** The root-session activity from the newest part frame, or null without frames. */
function frameActivity(turn: RunningTurn): Pick<RunningStatus, "phase" | "sentence"> | null {
  const frames = turn.native?.nativeFrames ?? [];
  const childSessions = new Set<string>();
  for (const f of frames) if (f.native.parentSessionId && f.native.sessionId) childSessions.add(f.native.sessionId);
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    if (!f.eventType.startsWith("part.")) continue;
    if (f.native.sessionId && childSessions.has(f.native.sessionId)) continue;
    if (f.eventType.startsWith("part.reasoning")) return { phase: "thinking", sentence: NEXT_STEP };
    if (f.eventType.startsWith("part.text")) return { phase: "working", sentence: WRITING };
    if (f.eventType.startsWith("part.tool") || f.eventType.startsWith("part.subtask")) {
      const step = toolStepFor(f, turn.steps);
      return step
        ? { phase: "working", sentence: stepSentence(step) }
        : { phase: "thinking", sentence: NEXT_STEP };
    }
    // part.step-start / part.step-finish: a model call is in flight.
    return { phase: "thinking", sentence: NEXT_STEP };
  }
  return null;
}

/** Fallback without frames: the newest durable step, then the live delta channel. */
function stepActivity(turn: RunningTurn): Pick<RunningStatus, "phase" | "sentence"> {
  const step = turn.steps.findLast((s) => s.kind !== "done" && isRenderableTimelineStep(s) && !isNarration(s));
  if (step) {
    const glyph = deriveTrace(step).glyph;
    if (glyph === "reasoning") return { phase: "thinking", sentence: NEXT_STEP };
    return { phase: "working", sentence: stepSentence(step) };
  }
  if (turn.liveText) return { phase: "working", sentence: WRITING };
  if (turn.liveReasoning) return { phase: "thinking", sentence: NEXT_STEP };
  return { phase: "working", sentence: STARTING };
}

export function deriveRunningStatus(
  turn: RunningTurn,
  childSessions: readonly GatewayChildSession[] = [],
  productChildren: readonly ThreadRelationship[] = [],
): RunningStatus {
  const children = countChildren(turn, childSessions, productChildren);
  const toolCalls = turn.steps.filter(isToolCall).length;
  const counts = { toolCalls, agentsRunning: children.running, agentsDone: children.done };
  if (children.active) {
    return {
      phase: "delegating",
      label: `Delegating ${clip(firstLine(children.active.name), NAME_MAX)}`,
      sentence: clip(children.active.sentence, STEP_MAX),
      ...counts,
    };
  }
  const activity = frameActivity(turn) ?? stepActivity(turn);
  return {
    ...activity,
    label: activity.phase === "thinking" ? "Thinking" : "Working",
    ...counts,
  };
}
