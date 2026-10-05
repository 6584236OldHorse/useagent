// What the running turn is doing right now, for the composer's running footer:
// the phase chip (Thinking / Working / Delegating <name>), the current step as
// a sentence, and the popover counts. Pure; reads only what the session already
// holds (the turn's durable steps, its native frames, the merged children view).
//
// Two costs, kept apart so the composer memoizes them apart: the structural
// part (children, tool calls, which sessions are children) is O(steps + frames)
// and changes only when a step or a frame lands; the status part reads the
// newest root frame from the end of the frame list and is cheap on every batch.
//
// Every engine speaks one of two frame grammars: the runtime adapters (claude,
// codex, opencode) persist `t3.activity.<kind>` frames for tools and tasks and
// stream the answer as text deltas; the pi bridge persists `part.*` frames for
// text, reasoning and tools and streams both delta kinds. The chat engine has
// steps and text deltas only. An open tool always names the work; otherwise
// the delta channel that grew most recently decides between writing and
// thinking, because a delta carries no sequence number of its own.

import type { ThreadRelationship } from "@useagent/agent-client";
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
import type { ChildStatus, NativeFrame } from "@/components/chat/native-events";
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

/** The only fields of a turn the derivation reads (a `Turn` satisfies it). */
export type RunningTurn = Pick<Turn, "steps" | "liveText" | "liveReasoning" | "executionSummary"> & {
  readonly native?:
    | { readonly nativeFrames: readonly NativeFrame[]; readonly childSessionIds?: ReadonlySet<string>; readonly nativeCursor?: number }
    | undefined;
  readonly canonical?: readonly CanonicalEventLike[] | undefined;
};

/** Which live channel of the turn grew most recently: a text or reasoning
 *  delta, or neither (a frame landed last, or nothing was observed yet). */
export type LiveChannel = "text" | "reasoning" | null;

const NAME_MAX = 40;
const STEP_MAX = 96;
export const NEXT_STEP = "Working through the next step";
const WRITING = "Writing the reply";
const STARTING = "Starting up";

// ── Live growth (which channel spoke last) ──────────────────────────────────

export interface LiveGrowth {
  readonly runId: string | null;
  readonly text: number;
  readonly reasoning: number;
  readonly cursor: number;
  readonly latest: LiveChannel;
}

export const NO_GROWTH: LiveGrowth = { runId: null, text: 0, reasoning: 0, cursor: -1, latest: null };

/** Fold one observed snapshot of the running turn into the growth record. A
 *  text delta wins a batch it shares with a reasoning delta (the answer follows
 *  the thought); a batch that only brought frames hands the word back to them.
 *  Idempotent for a repeated snapshot, so a render replay changes nothing. */
export function advanceLiveGrowth(prev: LiveGrowth, runId: string, turn: RunningTurn): LiveGrowth {
  const base = prev.runId === runId ? prev : { ...NO_GROWTH, runId };
  const text = turn.liveText.length;
  const reasoning = turn.liveReasoning.length;
  const cursor = turn.native?.nativeCursor ?? -1;
  const latest: LiveChannel =
    text > base.text ? "text" : reasoning > base.reasoning ? "reasoning" : cursor > base.cursor ? null : base.latest;
  return { runId, text, reasoning, cursor, latest };
}

// ── Structural part: children, tool calls, child sessions ───────────────────

interface Delegate {
  readonly name: string;
  readonly sentence: string;
}

export interface RunningChildren {
  readonly running: number;
  readonly done: number;
  /** The first child still running, when any is. */
  readonly active: Delegate | null;
  /** Native sessions owned by children: their frames never speak for the parent. */
  readonly childSessionIds: ReadonlySet<string>;
  readonly toolCalls: number;
}

const RUNNING = new Set<ChildStatus>(["running", "waiting"]);
const DONE = new Set<ChildStatus>(["completed", "failed", "cancelled", "interrupted", "idle"]);
const PRODUCT_STATUS: Record<ThreadRelationship["status"], ChildStatus> = {
  queued: "pending",
  waiting: "waiting",
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/** A tool step the turn made: renderable, not the answer placeholder, not
 *  sandbox boot or a reasoning row. */
function isToolCall(step: ApiStep): boolean {
  if (step.kind === "done" || !isRenderableTimelineStep(step) || isNarration(step)) return false;
  const glyph = deriveTrace(step).glyph;
  return glyph !== "boot" && glyph !== "reasoning";
}

export function deriveRunningChildren(
  turn: RunningTurn,
  childSessions: readonly GatewayChildSession[] = [],
  productChildren: readonly ThreadRelationship[] = [],
): RunningChildren {
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
  // A queued (pending) child neither runs nor is done: it waits its turn.
  const tally = (status: ChildStatus, delegate: () => Delegate) => {
    if (RUNNING.has(status)) {
      running += 1;
      active ??= delegate();
    } else if (DONE.has(status)) done += 1;
  };
  for (const card of view.cards) {
    let fidelity: MergedChildFidelity | undefined;
    for (const alias of card.aliases) fidelity ??= view.fidelity.get(alias);
    // Same fallback as the inline fold: a child without a status frame is running while its parent is.
    tally(fidelity?.status ?? "running", () => ({
      name: fidelity?.role ?? card.title,
      sentence: fidelity?.progress ?? card.status ?? "Working",
    }));
  }
  for (const child of childSessions) {
    tally(RUN_CHILD_STATUS[child.status], () => ({
      name: child.prompt,
      sentence: child.summary ? firstLine(child.summary) : RUN_STATUS_LABEL[child.status],
    }));
  }
  for (const child of productChildren) {
    tally(PRODUCT_STATUS[child.status], () => ({
      name: child.bot?.name ?? child.title,
      sentence: child.latestSummary ? firstLine(child.latestSummary) : "Working",
    }));
  }
  // Child sessions: the store's stamped ids plus every frame that names a
  // parent other than itself (a pi lifecycle row names the root as its own parent).
  const childSessionIds = new Set<string>(turn.native?.childSessionIds ?? []);
  for (const f of frames) {
    const { sessionId, parentSessionId } = f.native;
    if (sessionId && parentSessionId && parentSessionId !== sessionId) childSessionIds.add(sessionId);
  }
  return { running, done, active, childSessionIds, toolCalls: turn.steps.filter(isToolCall).length };
}

// ── Status part: the newest root activity ───────────────────────────────────

type Activity = Pick<RunningStatus, "phase" | "sentence">;
const THINKING: Activity = { phase: "thinking", sentence: NEXT_STEP };
const WRITING_REPLY: Activity = { phase: "working", sentence: WRITING };

/** The tool step a tool frame belongs to: by native call id, else the newest tool step. */
function toolStepFor(frame: NativeFrame, steps: readonly ApiStep[]): ApiStep | undefined {
  const callId = frame.native.callId;
  const byCall = callId ? steps.findLast((step) => nativeOf(step)?.callID === callId) : undefined;
  return byCall ?? steps.findLast(isToolCall);
}

function stepSentence(step: ApiStep): string {
  const trace = deriveTrace(step);
  if (trace.glyph === "boot") return clip(trace.target || STARTING, STEP_MAX);
  return summarizeToolStep(step).label;
}

/** A tool frame whose call has not finished: `t3.activity.tool.started` and
 *  `.progress` from the runtime adapters, a bare `part.tool` from the pi bridge. */
function isOpenTool(eventType: string): boolean {
  return (
    eventType === "t3.activity.tool.started" ||
    eventType === "t3.activity.tool.progress" ||
    eventType === "part.tool"
  );
}

/** The newest root-session frame that says something about the current
 *  activity: a tool (open or closed), reasoning or text. Null without one. */
function newestRootActivity(
  turn: RunningTurn,
  childSessionIds: ReadonlySet<string>,
): { readonly frame: NativeFrame; readonly kind: "open-tool" | "closed" | "reasoning" | "text" } | null {
  const frames = turn.native?.nativeFrames ?? [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i]!;
    const t = f.eventType;
    if (!t.startsWith("part.") && !t.startsWith("t3.activity.")) continue;
    if (f.native.sessionId && childSessionIds.has(f.native.sessionId)) continue;
    if (isOpenTool(t)) return { frame: f, kind: "open-tool" };
    if (t.startsWith("part.reasoning") && !t.endsWith(".completed")) return { frame: f, kind: "reasoning" };
    if (t.startsWith("part.text")) return { frame: f, kind: "text" };
    if (t.startsWith("part.tool") || t.startsWith("t3.activity.tool.")) return { frame: f, kind: "closed" };
    // step start/finish, task lifecycle, approvals, questions: no activity of their own.
  }
  return null;
}

/** Without frames: the newest durable step, then whatever the delta channel holds. */
function stepActivity(turn: RunningTurn): Activity {
  const step = turn.steps.findLast((s) => s.kind !== "done" && isRenderableTimelineStep(s) && !isNarration(s));
  if (step) {
    if (deriveTrace(step).glyph === "reasoning") return THINKING;
    return { phase: "working", sentence: stepSentence(step) };
  }
  if (turn.liveText) return WRITING_REPLY;
  if (turn.liveReasoning) return THINKING;
  return { phase: "working", sentence: STARTING };
}

export function deriveRunningStatus(
  turn: RunningTurn,
  children: RunningChildren,
  latest: LiveChannel = null,
): RunningStatus {
  const counts = { toolCalls: children.toolCalls, agentsRunning: children.running, agentsDone: children.done };
  if (children.active) {
    return {
      phase: "delegating",
      label: `Delegating ${clip(firstLine(children.active.name), NAME_MAX)}`,
      sentence: clip(children.active.sentence, STEP_MAX),
      ...counts,
    };
  }
  const newest = newestRootActivity(turn, children.childSessionIds);
  let activity: Activity;
  if (newest?.kind === "open-tool") {
    const step = toolStepFor(newest.frame, turn.steps);
    activity = step ? { phase: "working", sentence: stepSentence(step) } : THINKING;
  } else if (latest === "text") activity = WRITING_REPLY;
  else if (latest === "reasoning") activity = THINKING;
  else if (newest?.kind === "reasoning") activity = THINKING;
  else if (newest?.kind === "text") activity = WRITING_REPLY;
  else if (newest) activity = THINKING; // a closed tool and nothing newer: the model has its result
  else activity = stepActivity(turn);
  return { ...activity, label: activity.phase === "thinking" ? "Thinking" : "Working", ...counts };
}
