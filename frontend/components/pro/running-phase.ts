// What the running turn is doing right now, for the composer's running footer:
// the phase chip (Thinking / Working / Delegating <name>), the current step as
// a sentence, and the popover counts. Pure; reads only what the session already
// holds (the turn's durable steps, its native frames, the merged children view).
//
// Two costs, kept apart so the composer memoizes them apart: deriveRunningWork
// reads the whole history (children, tool calls, open calls, the newest root
// activity, the step fallback) and reruns only when a step or a frame lands;
// deriveRunningStatus selects among those cached values and the live delta
// channel on every batch without touching the history again.
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
import { type ApiStep, asRecord, deriveTrace, isRenderableTimelineStep } from "@/components/chat/types";

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
    | { readonly nativeFrames: readonly NativeFrame[]; readonly childSessionIds?: ReadonlySet<string> }
    | undefined;
  readonly canonical?: readonly CanonicalEventLike[] | undefined;
};

/** Which live channel of the turn grew most recently: a text or reasoning
 *  delta, or neither (root activity landed last, or nothing was observed yet). */
export type LiveChannel = "text" | "reasoning" | null;

type Activity = Pick<RunningStatus, "phase" | "sentence">;

const NAME_MAX = 40;
const STEP_MAX = 96;
export const NEXT_STEP = "Working through the next step";
const THINKING: Activity = { phase: "thinking", sentence: NEXT_STEP };
const WRITING: Activity = { phase: "working", sentence: "Writing the reply" };
const STARTING: Activity = { phase: "working", sentence: "Starting up" };

// ── Live growth (which channel spoke last) ──────────────────────────────────

export interface LiveGrowth {
  readonly runId: string | null;
  readonly text: number;
  readonly reasoning: number;
  /** The root-activity watermark last seen (`RunningWork.watermark`). */
  readonly cursor: number;
  readonly latest: LiveChannel;
}

export const NO_GROWTH: LiveGrowth = { runId: null, text: 0, reasoning: 0, cursor: -1, latest: null };

/** Fold one observed snapshot of the running turn into the growth record. A
 *  text delta wins a batch it shares with a reasoning delta (the answer follows
 *  the thought); a batch that only moved the root-activity watermark hands the
 *  word back to the frames; frames the reader ignores (children, control rows)
 *  never move it. A length or watermark that went backwards means the store
 *  was replaced under the same run id, so the baseline restarts. Idempotent
 *  for a repeated snapshot, so a render replay changes nothing. */
export function advanceLiveGrowth(
  prev: LiveGrowth,
  runId: string,
  turn: Pick<RunningTurn, "liveText" | "liveReasoning">,
  watermark: number,
): LiveGrowth {
  const text = turn.liveText.length;
  const reasoning = turn.liveReasoning.length;
  const same = prev.runId === runId && text >= prev.text && reasoning >= prev.reasoning && watermark >= prev.cursor;
  const base = same ? prev : { ...NO_GROWTH, runId };
  const latest: LiveChannel =
    text > base.text ? "text" : reasoning > base.reasoning ? "reasoning" : watermark > base.cursor ? null : base.latest;
  return { runId, text, reasoning, cursor: watermark, latest };
}

// ── Structural part: everything read from the history ───────────────────────

interface Delegate {
  readonly name: string;
  readonly sentence: string;
}

export interface RunningWork {
  readonly running: number;
  readonly done: number;
  /** The first child still running, when any is. */
  readonly active: Delegate | null;
  readonly toolCalls: number;
  /** The sentence for the newest root tool call still in flight; null when every call closed. */
  readonly openTool: string | null;
  /** What the newest root activity frame said, for when every call closed. */
  readonly newestActivity: "closed" | "reasoning" | "text" | null;
  /** Seq of the newest root activity frame the reader considered; -1 without one. */
  readonly watermark: number;
  /** Without frames: what the newest durable step says; null without one. */
  readonly stepActivity: Activity | null;
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

/** A tool frame's call state: `t3.activity.tool.started`, `.updated` and
 *  `.progress` from the runtime adapters are open (an error tone closes, as the
 *  backend's own in-flight check reads it), a bare `part.tool` from the pi
 *  bridge is open. A plan update rides the same shapes and is never a call, and
 *  a frame without a call id is a provisional row whose completion can never
 *  be matched to it, so it is no call either. */
function toolFrameState(frame: NativeFrame): "open" | "closed" | null {
  if (!frame.native.callId) return null;
  const t = frame.eventType;
  if (t.startsWith("t3.activity.tool.")) {
    if (t === "t3.activity.tool.completed" || t === "t3.activity.tool.denied") return "closed";
    return asRecord(frame.payload)?.tone === "error" ? "closed" : "open";
  }
  if (!t.startsWith("part.tool")) return null;
  if (asRecord(frame.payload)?.tool === "todowrite") return null;
  return t === "part.tool" ? "open" : "closed";
}

function stepSentence(step: ApiStep): string {
  const trace = deriveTrace(step);
  if (trace.glyph === "boot") return clip(trace.target || STARTING.sentence, STEP_MAX);
  return summarizeToolStep(step).label;
}

/** The tool step a tool frame belongs to: by native call id, else the newest tool step. */
function toolStepFor(frame: NativeFrame, steps: readonly ApiStep[]): ApiStep | undefined {
  const callId = frame.native.callId;
  const byCall = callId ? steps.findLast((step) => nativeOf(step)?.callID === callId) : undefined;
  return byCall ?? steps.findLast(isToolCall);
}

/** What a root frame says about the current activity, or null for a frame the reader ignores. */
function rootActivityOf(frame: NativeFrame): "reasoning" | "text" | "closed" | "open" | null {
  const t = frame.eventType;
  if (t.startsWith("part.reasoning") && !t.endsWith(".completed")) return "reasoning";
  if (t.startsWith("part.text")) return "text";
  return toolFrameState(frame);
}

export function deriveRunningWork(
  turn: RunningTurn,
  childSessions: readonly GatewayChildSession[] = [],
  productChildren: readonly ThreadRelationship[] = [],
): RunningWork {
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
  // One pass over the root frames: open calls per call id (completing one call
  // closes only that call), and the newest frame the reader listens to.
  const openByCall = new Map<string, NativeFrame>();
  let newest: NativeFrame | null = null;
  let newestActivity: RunningWork["newestActivity"] = null;
  for (const f of frames) {
    if (f.native.sessionId && childSessionIds.has(f.native.sessionId)) continue;
    const activity = rootActivityOf(f);
    if (!activity) continue;
    if (activity === "open") openByCall.set(f.native.callId!, f);
    else if (activity === "closed") openByCall.delete(f.native.callId!);
    if (!newest || f.seq > newest.seq) {
      newest = f;
      newestActivity = activity === "open" ? "closed" : activity;
    }
  }
  let openFrame: NativeFrame | null = null;
  for (const f of openByCall.values()) if (!openFrame || f.seq > openFrame.seq) openFrame = f;
  const openStep = openFrame ? toolStepFor(openFrame, turn.steps) : undefined;
  const lastStep = turn.steps.findLast((s) => s.kind !== "done" && isRenderableTimelineStep(s) && !isNarration(s));
  return {
    running,
    done,
    active,
    toolCalls: turn.steps.filter(isToolCall).length,
    openTool: openStep ? stepSentence(openStep) : openFrame ? NEXT_STEP : null,
    newestActivity: openFrame ? null : newestActivity,
    watermark: newest?.seq ?? -1,
    stepActivity: lastStep
      ? deriveTrace(lastStep).glyph === "reasoning"
        ? THINKING
        : { phase: "working", sentence: stepSentence(lastStep) }
      : null,
  };
}

// ── Status part: a selection, never a scan ──────────────────────────────────

export function deriveRunningStatus(
  turn: Pick<RunningTurn, "liveText" | "liveReasoning">,
  work: RunningWork,
  latest: LiveChannel = null,
): RunningStatus {
  const counts = { toolCalls: work.toolCalls, agentsRunning: work.running, agentsDone: work.done };
  if (work.active) {
    return {
      phase: "delegating",
      label: `Delegating ${clip(firstLine(work.active.name), NAME_MAX)}`,
      sentence: clip(work.active.sentence, STEP_MAX),
      ...counts,
    };
  }
  let activity: Activity;
  if (work.openTool !== null) activity = { phase: "working", sentence: work.openTool };
  else if (latest === "text") activity = WRITING;
  else if (latest === "reasoning") activity = THINKING;
  else if (work.newestActivity === "reasoning") activity = THINKING;
  else if (work.newestActivity === "text") activity = WRITING;
  else if (work.newestActivity === "closed") activity = THINKING; // the model has its result and nothing newer
  else if (work.stepActivity) activity = work.stepActivity;
  else if (turn.liveText) activity = WRITING;
  else if (turn.liveReasoning) activity = THINKING;
  else activity = STARTING;
  return { ...activity, label: activity.phase === "thinking" ? "Thinking" : "Working", ...counts };
}
